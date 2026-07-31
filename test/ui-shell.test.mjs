import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSource = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(root, "web", "index.html"), "utf8");

function sourceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("theme bootstrap blocks the first paint before styles and the app module", () => {
  const theme = htmlSource.indexOf('<script src="theme-init.js"></script>');
  const styles = htmlSource.indexOf('<link rel="stylesheet" href="styles.css">');
  const app = htmlSource.indexOf('<script type="module" src="app.js"></script>');
  assert.ok(theme >= 0 && theme < styles && styles < app);
});

test("service worker includes the blocking theme bootstrap", () => {
  const worker = fs.readFileSync(path.join(root, "web", "sw.js"), "utf8");
  assert.match(worker, /theme-init\.js/u);
});

test("reader zoom indicator hides after every completed zoom", () => {
  const applying = sourceBetween(appSource, "function applyReaderScale(", "function initializeReaderScale() {");
  assert.match(appSource, /indicatorDurationMs: 2500/u);
  assert.match(applying, /reset\.hidden = !showControl;/u);

  const finishing = sourceBetween(appSource, "function finishReaderZoomGesture() {", "function cancelReaderZoomGesture(");
  assert.match(finishing, /scheduleReaderZoomIndicatorHide\(\);/u);
  assert.doesNotMatch(finishing, /state\.readerScale === 1/u);

  const resetting = sourceBetween(appSource, "function resetReaderScale() {", "function formatDate(");
  assert.match(resetting, /scheduleReaderZoomIndicatorHide\(\);/u);
});

test("unlock is invalidated while deriving the key or loading the index", () => {
  const unlock = sourceBetween(appSource, "async function unlock(event) {", "async function initialize() {");
  const firstAwait = unlock.indexOf("await unwrapContentKey");
  const requestStart = unlock.indexOf("++state.unlockRequest");
  const unlockingStart = unlock.indexOf("state.unlocking = true");
  const guard = "if (request !== state.unlockRequest || document.hidden)";
  const firstGuard = unlock.indexOf(guard);
  const secondGuard = unlock.indexOf(guard, firstGuard + guard.length);
  assert.ok(requestStart >= 0 && requestStart < firstAwait);
  assert.ok(unlockingStart >= 0 && unlockingStart < firstAwait);
  assert.ok(firstGuard > firstAwait);
  assert.ok(secondGuard > unlock.indexOf("await loadEncryptedJson"));

  const clearing = sourceBetween(appSource, "function clearPlaintext() {", "function lockViewer(");
  assert.match(clearing, /state\.unlockRequest \+= 1/u);
  const visibility = sourceBetween(appSource, 'document.addEventListener("visibilitychange"', "initializeTheme();");
  assert.match(visibility, /state\.contentKey \|\| state\.unlocking/u);
  assert.match(visibility, /lockViewer\(/u);
});

test("search input does not cancel an active foreground open", () => {
  const search = sourceBetween(appSource, "function onSearch(event) {", "function closeSidebar() {");
  assert.doesNotMatch(search, /cancelForeground|cancelAll/u);
});

test("a cancelled current open leaves a retryable terminal status", () => {
  const opening = sourceBetween(appSource, "async function openThread(thread) {", "async function prefetchRecentThreads() {");
  assert.match(opening, /error instanceof TransferCancelledError && request === state\.openRequest/u);
  assert.match(opening, /读取已取消，请重新打开这条对话。/u);
});

test("legacy plaintext cache writes are guarded after async decryption", () => {
  const opening = sourceBetween(appSource, "async function openThread(thread) {", "async function prefetchRecentThreads() {");
  const legacyOpen = sourceBetween(
    opening,
    "const data = await loadEncryptedJson(thread.file",
    "state.currentSession = session;"
  );
  const openGuard = legacyOpen.indexOf("if (request !== state.openRequest || state.selectedId !== thread.id || !state.contentKey) return;");
  const openCommit = legacyOpen.indexOf("state.sessions.set(thread.id, session);");
  assert.ok(openGuard >= 0 && openGuard < openCommit);

  const searching = sourceBetween(appSource, "async function populateSearchCache(query, request) {", "let searchTimer;");
  const legacySearch = sourceBetween(
    searching,
    "} else if (!state.sessions.has(thread.id)) {",
    "} catch (error) {"
  );
  const searchGuard = legacySearch.indexOf("if (request !== state.searchRequest || !state.contentKey) return;");
  const searchCommit = legacySearch.indexOf("state.sessions.set(thread.id, { kind: \"legacy\", data });");
  assert.ok(searchGuard >= 0 && searchGuard < searchCommit);
});

test("locking clears and remasks the passphrase field", () => {
  const clearing = sourceBetween(appSource, "function clearPlaintext() {", "function lockViewer(");
  assert.match(clearing, /\$\("#passphrase"\)\.value = "";/u);
  assert.match(clearing, /\$\("#passphrase"\)\.type = "password";/u);
  assert.match(appSource, /\$\("#lock-button"\)\.addEventListener\("click", \(\) => lockViewer\(/u);
  const visibility = sourceBetween(appSource, 'document.addEventListener("visibilitychange"', "initializeTheme();");
  assert.match(visibility, /lockViewer\(/u);
});

test("question outline controls are present and reset with plaintext state", () => {
  for (const id of [
    "outline-button", "message-outline", "outline-search", "outline-count",
    "outline-status", "outline-list", "outline-close", "outline-scrim"
  ]) assert.match(htmlSource, new RegExp(`id=["']${id}["']`, "u"));

  const resetting = sourceBetween(appSource, "function resetMessageOutline() {", "function renderMessageOutline(");
  assert.match(resetting, /state\.outlineRequest \+= 1/u);
  assert.match(resetting, /state\.outlineEntries = \[\]/u);
  assert.match(resetting, /state\.outlineThreadId = null/u);
  assert.match(resetting, /closeMessageOutline\(\)/u);

  const clearing = sourceBetween(appSource, "function clearPlaintext() {", "function lockViewer(");
  assert.match(clearing, /resetConversationView\(\)/u);
  assert.match(clearing, /state\.sessions\.clear\(\)/u);
});

test("forced manifest refresh bypasses caches and verifies before returning", () => {
  const fetching = sourceBetween(appSource, "async function fetchManifest(", "async function decryptEnvelope(");
  assert.match(fetching, /manifest\.json\?cmv=\$\{Date\.now\(\)\}/u);
  const verifying = fetching.indexOf("await verifyManifest(manifest);");
  const returning = fetching.indexOf("return manifest;");
  assert.ok(verifying >= 0 && verifying < returning);
});

test("a valid signed manifest advances the rollback floor before unlock", () => {
  const verifying = sourceBetween(appSource, "async function verifyManifest(manifest) {", "async function fetchManifest(");
  const signatureAccepted = verifying.indexOf('if (!valid) throw new Error("快照签名无效，已拒绝解锁。");');
  const sequenceCommit = verifying.indexOf('localStorage.setItem("cmv.sequence"');
  assert.ok(signatureAccepted >= 0 && signatureAccepted < sequenceCommit);
  assert.match(verifying, /Number\.isSafeInteger\(sequence\)/u);
});

test("unlock retries only once after a verified manifest version change", () => {
  const unlocking = sourceBetween(appSource, "async function unlock(event) {", "async function initialize() {");
  assert.equal(unlocking.match(/fetchManifest\(\{ force: true \}\)/gu)?.length, 1);
  const refresh = unlocking.indexOf("latest = await fetchManifest({ force: true });");
  const versionCheck = unlocking.indexOf("manifestVersionChanged(state.manifest, latest)");
  const switchManifest = unlocking.indexOf("state.manifest = latest;");
  const retry = unlocking.indexOf("result = await attempt(latest);");
  assert.ok(refresh >= 0 && refresh < versionCheck);
  assert.ok(versionCheck < switchManifest && switchManifest < retry);
  assert.match(unlocking, /if \(initialError\?\.name !== "OperationError"\) throw initialError;/u);
});

test("candidate keys stay local until the index has decrypted successfully", () => {
  const unlocking = sourceBetween(appSource, "async function unlock(event) {", "async function initialize() {");
  const attemptStart = unlocking.indexOf("const attempt = async (manifest) => {");
  const attemptEnd = unlocking.indexOf("try {", attemptStart);
  const attempt = unlocking.slice(attemptStart, attemptEnd);
  assert.match(attempt, /contentKey,/u);
  assert.doesNotMatch(attempt, /state\.contentKey\s*=/u);
  const commit = unlocking.indexOf("state.contentKey = result.contentKey;");
  const resultGuard = unlocking.indexOf("if (!result)");
  assert.ok(commit > resultGuard);
});

test("refresh controls exist for locked and unlocked pages", () => {
  assert.match(htmlSource, /id="lock-refresh-button"/u);
  assert.match(htmlSource, /id="refresh-button"/u);
  const refreshing = sourceBetween(appSource, "async function refreshViewerManifest() {", "function clearPlaintext() {");
  assert.match(refreshing, /manifestVersionChanged\(previous, latest\)/u);
  assert.match(refreshing, /state\.manifest = latest;\s*lockViewer\(/u);
});

test("outline jumps within the conversation scroller instead of the page viewport", () => {
  const jumping = sourceBetween(appSource, "function jumpToMessage(messageIndex) {", "function renderThreadList(");
  assert.match(jumping, /target\.getBoundingClientRect\(\)\.top/u);
  assert.match(jumping, /scroller\.getBoundingClientRect\(\)\.top/u);
  assert.match(jumping, /scroller\.scrollTop = Math\.max/u);
  assert.doesNotMatch(jumping, /scrollIntoView/u);
});
