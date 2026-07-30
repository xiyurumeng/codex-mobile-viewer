import {
  buildThreadTree, canToggleConversationTitle, clampReaderScale, filterThreadTree,
  latestBatchStart, olderBatchStart, pointDistance, preserveScrollTop,
  preserveBottomOffset, preserveScrollRatio, readerScaleFromPinch,
  remainingMessagesBeforeChunk, resolveTheme, sortThreadsByUpdatedAt
} from "./ui-utils.js";
import {
  formatTransferProgress, shouldPrefetch, TransferCancelledError, TransferManager
} from "./network-utils.js";

const UI_CONFIG = Object.freeze({
  initialMessageBatch: 40, olderMessageBatch: 40, prefetchThreads: 3,
  prefetchConcurrency: 1, topLoadThreshold: 80,
  readerZoom: Object.freeze({
    minimum: 0.85, maximum: 1.3, activationRatio: 0.12, indicatorDurationMs: 2500
  })
});
const CIPHER_CACHE_PREFIX = "codex-mobile-viewer-cipher-";
const THEME_STORAGE_KEY = "cmv.theme";
const TITLE_HINT_STORAGE_KEY = "cmv.titleHintSeen.v1";
const READER_SCALE_STORAGE_KEY = "cmv.readerScale.v1";
const PINCH_EXCLUDED_SELECTOR = "button, a, input, textarea, select, [contenteditable='true']";

const state = {
  manifest: null, contentKey: null, index: null, sessions: new Map(),
  selectedId: null, currentThread: null, currentSession: null,
  firstLoadedChunkIndex: -1, renderedStart: 0, loadingOlder: false,
  olderProgress: "", openRequest: 0, searchRequest: 0, unlockRequest: 0,
  unlocking: false, idleTimer: null,
  hintTimer: null, idleMinutes: 5, observedBytesPerSecond: 0,
  titleCollapsed: false, titleLayoutRequest: 0, lastScrollTop: 0,
  readerScale: 1, zoomGesture: null, zoomIndicatorTimer: null,
  expandedThreadIds: new Set()
};

const $ = (selector) => document.querySelector(selector);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const transferManager = new TransferManager({
  onSample({ bytes, durationMs }) {
    if (bytes < 1024) return;
    const sample = (bytes * 1000) / durationMs;
    state.observedBytesPerSecond = state.observedBytesPerSecond
      ? (state.observedBytesPerSecond * 0.65) + (sample * 0.35)
      : sample;
  }
});

function bytesFromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function pemBytes(pem) {
  return bytesFromBase64(pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, ""));
}

async function sha256Hex(bytes) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function networkBytes(pathname, expectedHash, { priority = "user", onProgress } = {}) {
  const bytes = await transferManager.download(pathname, {
    cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer"
  }, { priority, onProgress, dedupeKey: `${pathname}\u0000${expectedHash ?? ""}` });
  if (expectedHash && await sha256Hex(bytes) !== expectedHash) throw new Error("文件哈希不匹配，快照可能已被修改。");
  return bytes;
}

function cipherCacheName() {
  return `${CIPHER_CACHE_PREFIX}${state.manifest?.signed?.sequence ?? "unknown"}`;
}

async function cacheCiphertext(pathname, bytes) {
  if (!("caches" in globalThis)) return;
  try {
    const cache = await caches.open(cipherCacheName());
    await cache.put(pathname, new Response(bytes, { headers: { "content-type": "application/json" } }));
  } catch {}
}

async function cachedCiphertext(pathname, expectedHash) {
  if (!("caches" in globalThis)) return null;
  try {
    const cache = await caches.open(cipherCacheName());
    const response = await cache.match(pathname);
    if (!response) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!expectedHash || await sha256Hex(bytes) === expectedHash) return bytes;
    await cache.delete(pathname);
  } catch {}
  return null;
}

async function fetchBytes(pathname, expectedHash, {
  cacheCipher = false, priority = "user", onProgress
} = {}) {
  if (priority === "user") transferManager.cancelBackground(pathname);
  if (!cacheCipher) return networkBytes(pathname, expectedHash, { priority, onProgress });
  const cached = await cachedCiphertext(pathname, expectedHash);
  if (cached) return cached;
  const bytes = await networkBytes(pathname, expectedHash, { priority, onProgress });
  await cacheCiphertext(pathname, bytes);
  return bytes;
}

async function removeOldCipherCaches() {
  if (!("caches" in globalThis)) return;
  const current = cipherCacheName();
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith(CIPHER_CACHE_PREFIX) && name !== current).map((name) => caches.delete(name)));
}

async function verifyManifest(manifest) {
  if (!manifest?.signed || !manifest.signature) throw new Error("快照清单格式无效。");
  const publicBytes = pemBytes(manifest.signed.publicKey);
  const fingerprint = await sha256Hex(publicBytes);
  const trusted = localStorage.getItem("cmv.trustedPublicKey");
  if (trusted && trusted !== fingerprint) throw new Error("签名公钥与本设备首次信任的指纹不同，已拒绝解锁。");
  const previousSequence = Number(localStorage.getItem("cmv.sequence") || 0);
  if (previousSequence && manifest.signed.sequence < previousSequence) throw new Error("云端快照版本发生回退，已拒绝解锁。");
  let key;
  try { key = await crypto.subtle.importKey("spki", publicBytes, { name: "Ed25519" }, false, ["verify"]); }
  catch { throw new Error("此浏览器不支持 Ed25519 签名验证，请升级浏览器。"); }
  const valid = await crypto.subtle.verify(
    "Ed25519", key, bytesFromBase64(manifest.signature), encoder.encode(JSON.stringify(manifest.signed))
  );
  if (!valid) throw new Error("快照签名无效，已拒绝解锁。");
  localStorage.setItem("cmv.trustedPublicKey", fingerprint);
}

async function decryptEnvelope(envelope, key, additionalData) {
  const ciphertext = bytesFromBase64(envelope.ciphertext);
  const tag = bytesFromBase64(envelope.tag);
  const combined = new Uint8Array(ciphertext.length + tag.length);
  combined.set(ciphertext);
  combined.set(tag, ciphertext.length);
  const algorithm = { name: "AES-GCM", iv: bytesFromBase64(envelope.iv), tagLength: 128 };
  if (additionalData) algorithm.additionalData = encoder.encode(additionalData);
  return new Uint8Array(await crypto.subtle.decrypt(algorithm, key, combined));
}

async function unwrapContentKey(passphrase, envelope) {
  const material = await crypto.subtle.importKey("raw", encoder.encode(passphrase.normalize("NFKC")), "PBKDF2", false, ["deriveKey"]);
  const wrappingKey = await crypto.subtle.deriveKey({
    name: "PBKDF2", salt: bytesFromBase64(envelope.salt), iterations: envelope.iterations, hash: "SHA-256"
  }, material, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const raw = await decryptEnvelope(envelope, wrappingKey, "codex-mobile-viewer:key:v1");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
}

async function loadEncryptedJson(pathname, additionalData, {
  cacheCipher = false, priority = "user", onProgress
} = {}) {
  const expected = state.manifest.signed.files[pathname];
  if (!expected) throw new Error(`清单缺少文件：${pathname}`);
  const envelope = JSON.parse(decoder.decode(await fetchBytes(pathname, expected, {
    cacheCipher, priority, onProgress
  })));
  return JSON.parse(decoder.decode(await decryptEnvelope(envelope, state.contentKey, additionalData)));
}

function setLockStatus(message, error = false) {
  $("#lock-status").textContent = message;
  $("#lock-status").classList.toggle("error", error);
}

function applyTheme(theme, persist = false) {
  document.documentElement.dataset.theme = theme;
  $("meta[name='theme-color']")?.setAttribute("content", theme === "dark" ? "#161816" : "#f5f5f2");
  $("#theme-button")?.setAttribute("aria-pressed", String(theme === "dark"));
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }
}

function initializeTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_STORAGE_KEY); } catch {}
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  applyTheme(resolveTheme(stored, prefersDark));
}

function applyReaderScale(value, { persist = false, showControl = false } = {}) {
  const { minimum, maximum } = UI_CONFIG.readerZoom;
  const scale = Math.round(clampReaderScale(value, minimum, maximum) * 100) / 100;
  const percentage = Math.round(scale * 100);
  const scroller = $("#conversation-scroll");
  const oldTop = scroller.scrollTop;
  const oldScrollHeight = scroller.scrollHeight;
  const oldClientHeight = scroller.clientHeight;
  state.readerScale = scale;
  $("#conversation").style.setProperty("--reader-scale", String(scale));
  scroller.scrollTop = preserveScrollRatio(
    oldTop, oldScrollHeight, oldClientHeight, scroller.scrollHeight, scroller.clientHeight
  );
  state.lastScrollTop = scroller.scrollTop;
  const reset = $("#reader-zoom-reset");
  reset.textContent = `${percentage}%`;
  reset.setAttribute("aria-label", `当前字号 ${percentage}%，点击恢复默认字号`);
  reset.hidden = !showControl;
  if (persist) {
    try { localStorage.setItem(READER_SCALE_STORAGE_KEY, String(scale)); } catch {}
  }
}

function initializeReaderScale() {
  let stored = 1;
  try { stored = Number(localStorage.getItem(READER_SCALE_STORAGE_KEY) ?? 1); } catch {}
  applyReaderScale(stored);
}

function scheduleReaderZoomIndicatorHide() {
  clearTimeout(state.zoomIndicatorTimer);
  state.zoomIndicatorTimer = setTimeout(() => {
    $("#reader-zoom-reset").hidden = true;
  }, UI_CONFIG.readerZoom.indicatorDurationMs);
}

function finishReaderZoomGesture() {
  applyReaderScale(state.readerScale, { persist: true, showControl: true });
  scheduleReaderZoomIndicatorHide();
  state.zoomGesture = null;
}

function cancelReaderZoomGesture({ persist = false } = {}) {
  if (persist && state.zoomGesture?.active) finishReaderZoomGesture();
  state.zoomGesture = null;
  readerPointers.clear();
}

function resetReaderScale() {
  applyReaderScale(1, { persist: true, showControl: true });
  scheduleReaderZoomIndicatorHide();
}

function formatDate(value, withTime = false) {
  if (!value) return "时间未知";
  const options = withTime
    ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat("zh-CN", options).format(new Date(value));
}

function isChunkedThread(thread) {
  return Array.isArray(thread?.chunks);
}

function getChunkedSession(thread) {
  let session = state.sessions.get(thread.id);
  if (!session || session.kind !== "chunked") {
    session = { kind: "chunked", threadId: thread.id, chunks: new Map() };
    state.sessions.set(thread.id, session);
  }
  return session;
}

async function loadThreadChunk(thread, chunkIndex, options = {}) {
  const metadata = thread.chunks?.[chunkIndex];
  if (!metadata?.file) throw new Error("对话分片索引无效。");
  const session = getChunkedSession(thread);
  if (session.chunks.has(chunkIndex)) return session.chunks.get(chunkIndex);
  const chunk = await loadEncryptedJson(metadata.file, metadata.file, { cacheCipher: true, ...options });
  if (chunk?.schemaVersion !== 2 || !Array.isArray(chunk.messages)
    || chunk.threadId !== thread.id
    || Number(chunk.start) !== Number(metadata.start)
    || Number(chunk.count) !== Number(metadata.count)
    || chunk.messages.length !== Number(metadata.count)) {
    throw new Error("对话分片内容与签名索引不一致。");
  }
  session.chunks.set(chunkIndex, chunk);
  return chunk;
}

function cachedSessionMessages(session) {
  if (!session) return [];
  if (session.kind === "legacy") return session.data.messages ?? [];
  return [...session.chunks.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, chunk]) => chunk.messages);
}

function appendParagraph(parent, text) {
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  parent.append(paragraph);
}

function renderMarkdown(text) {
  const root = document.createElement("div");
  root.className = "markdown";
  const lines = String(text).replace(/\r/g, "").split("\n");
  let code = null;
  let list = null;
  let quote = null;
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) appendParagraph(root, paragraph.join("\n"));
    paragraph = [];
  };
  const flushList = () => { list = null; };
  const flushQuote = () => { quote = null; };
  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph(); flushList(); flushQuote();
      if (code) { root.append(code.wrapper); code = null; }
      else {
        const pre = document.createElement("pre");
        const element = document.createElement("code");
        pre.append(element);
        code = { wrapper: pre, element, lines: [] };
      }
      continue;
    }
    if (code) { code.lines.push(line); code.element.textContent = code.lines.join("\n"); continue; }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph(); flushList(); flushQuote();
      const element = document.createElement(`h${heading[1].length}`);
      element.textContent = heading[2];
      root.append(element);
      continue;
    }
    const item = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (item) {
      flushParagraph(); flushQuote();
      if (!list) { list = document.createElement("ul"); root.append(list); }
      const element = document.createElement("li");
      element.textContent = item[1];
      list.append(element);
      continue;
    }
    if (line.startsWith("> ")) {
      flushParagraph(); flushList();
      if (!quote) { quote = document.createElement("blockquote"); root.append(quote); }
      appendParagraph(quote, line.slice(2));
      continue;
    }
    flushQuote();
    if (!line.trim()) { flushParagraph(); flushList(); } else paragraph.push(line);
  }
  flushParagraph();
  if (code) root.append(code.wrapper);
  return root;
}

function createMessageElement(message) {
  const article = document.createElement("section");
  article.className = `message ${message.role === "user" ? "user" : message.phase}`;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = message.role === "user" ? "你" : message.phase === "commentary" ? "Codex · 过程更新" : "Codex";
  article.append(label, renderMarkdown(message.text));
  return article;
}

function setConversationStatus(message = "") {
  $("#conversation-status").textContent = message;
}

function updateOlderControl() {
  const button = $("#load-older");
  const remaining = state.currentSession?.kind === "chunked"
    ? remainingMessagesBeforeChunk(state.currentThread?.chunks, state.firstLoadedChunkIndex)
    : state.renderedStart;
  const hasOlder = Boolean(state.currentSession && remaining > 0);
  button.hidden = !hasOlder;
  button.disabled = state.loadingOlder;
  button.textContent = state.loadingOlder
    ? (state.olderProgress || "正在加载更早消息…")
    : `加载更早消息（还剩 ${remaining} 条）`;
}

function scrollConversationToBottom() {
  requestAnimationFrame(() => {
    const scroller = $("#conversation-scroll");
    scroller.scrollTop = scroller.scrollHeight;
    state.lastScrollTop = scroller.scrollTop;
  });
}

function renderLegacyLatestMessages(session) {
  const messages = $("#messages");
  state.renderedStart = latestBatchStart(session.messages.length, UI_CONFIG.initialMessageBatch);
  const fragment = document.createDocumentFragment();
  for (const message of session.messages.slice(state.renderedStart)) fragment.append(createMessageElement(message));
  messages.replaceChildren(fragment);
  updateOlderControl();
  scrollConversationToBottom();
}

function renderLatestChunk(chunk) {
  const fragment = document.createDocumentFragment();
  for (const message of chunk.messages) fragment.append(createMessageElement(message));
  $("#messages").replaceChildren(fragment);
  updateOlderControl();
  scrollConversationToBottom();
}

function loadOlderLegacyMessages() {
  if (state.loadingOlder || !state.currentSession || state.renderedStart <= 0) return;
  state.loadingOlder = true;
  updateOlderControl();
  const scroller = $("#conversation-scroll");
  const oldHeight = scroller.scrollHeight;
  const oldTop = scroller.scrollTop;
  const nextStart = olderBatchStart(state.renderedStart, UI_CONFIG.olderMessageBatch);
  const fragment = document.createDocumentFragment();
  for (const message of state.currentSession.data.messages.slice(nextStart, state.renderedStart)) {
    fragment.append(createMessageElement(message));
  }
  $("#messages").prepend(fragment);
  state.renderedStart = nextStart;
  requestAnimationFrame(() => {
    scroller.scrollTop = preserveScrollTop(oldTop, oldHeight, scroller.scrollHeight);
    state.lastScrollTop = scroller.scrollTop;
    state.loadingOlder = false;
    updateOlderControl();
  });
}

async function loadOlderMessages() {
  if (state.loadingOlder || !state.currentSession) return;
  if (state.currentSession.kind === "legacy") return loadOlderLegacyMessages();
  if (state.firstLoadedChunkIndex <= 0) return;

  const request = state.openRequest;
  const thread = state.currentThread;
  const nextChunkIndex = state.firstLoadedChunkIndex - 1;
  state.loadingOlder = true;
  state.olderProgress = "";
  updateOlderControl();
  try {
    const chunk = await loadThreadChunk(thread, nextChunkIndex, {
      priority: "user",
      onProgress({ loaded, total }) {
        if (request !== state.openRequest) return;
        state.olderProgress = formatTransferProgress(loaded, total)
          .replace("正在读取加密对话", "正在加载更早消息");
        updateOlderControl();
      }
    });
    if (request !== state.openRequest || state.selectedId !== thread.id) return;

    const scroller = $("#conversation-scroll");
    const oldHeight = scroller.scrollHeight;
    const oldTop = scroller.scrollTop;
    const fragment = document.createDocumentFragment();
    for (const message of chunk.messages) fragment.append(createMessageElement(message));
    $("#messages").prepend(fragment);
    state.firstLoadedChunkIndex = nextChunkIndex;
    await new Promise((resolve) => requestAnimationFrame(resolve));
    scroller.scrollTop = preserveScrollTop(oldTop, oldHeight, scroller.scrollHeight);
    state.lastScrollTop = scroller.scrollTop;
    setConversationStatus();
  } catch (error) {
    if (!(error instanceof TransferCancelledError) && request === state.openRequest) {
      setConversationStatus(`无法加载更早消息：${error.message}`);
      $("#conversation-status").classList.add("error");
    }
  } finally {
    if (request === state.openRequest) {
      state.loadingOlder = false;
      state.olderProgress = "";
      updateOlderControl();
    }
  }
}

function renderThreadList(query = "") {
  if (!state.index) return;
  const normalized = query.trim().toLocaleLowerCase();
  const list = $("#thread-list");
  list.replaceChildren();
  const matchingIds = new Set(state.index.threads.filter((thread) => {
    if (!normalized) return true;
    const cached = state.sessions.get(thread.id);
    return thread.title.toLocaleLowerCase().includes(normalized)
      || cachedSessionMessages(cached)
        .some((message) => message.text.toLocaleLowerCase().includes(normalized));
  }).map((thread) => thread.id));
  const tree = buildThreadTree(state.index.threads);
  const visibleTree = normalized ? filterThreadTree(tree, matchingIds) : tree;

  const appendNode = (node, depth = 0) => {
    const thread = node.thread;
    const row = document.createElement("div");
    row.className = `thread-row${thread.id === state.selectedId ? " active" : ""}${depth ? " child" : ""}`;
    row.style.setProperty("--thread-depth", String(depth));
    const button = document.createElement("button");
    button.type = "button";
    button.className = "thread-item";
    button.setAttribute("aria-current", thread.id === state.selectedId ? "true" : "false");
    const title = document.createElement("strong");
    title.textContent = thread.title;
    const meta = document.createElement("span");
    const kind = thread.relation?.kind === "side-task"
      ? (thread.relation.orphaned ? "未归类侧边任务 · " : "侧边任务 · ")
      : "";
    meta.textContent = `${kind}${formatDate(thread.updatedAt)} · ${thread.messages} 条消息`;
    button.append(title, meta);
    button.addEventListener("click", () => openThread(thread));
    row.append(button);

    const hasChildren = node.children.length > 0;
    const expanded = normalized || state.expandedThreadIds.has(thread.id);
    if (hasChildren) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "thread-toggle";
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute("aria-label", `${expanded ? "收起" : "展开"} ${thread.title} 的侧边任务`);
      toggle.title = expanded ? "收起侧边任务" : "展开侧边任务";
      toggle.textContent = expanded ? "⌄" : "›";
      toggle.addEventListener("click", () => {
        if (state.expandedThreadIds.has(thread.id)) state.expandedThreadIds.delete(thread.id);
        else state.expandedThreadIds.add(thread.id);
        renderThreadList($("#search").value);
      });
      row.append(toggle);
    }
    list.append(row);
    if (hasChildren && expanded) node.children.forEach((child) => appendNode(child, depth + 1));
  };
  visibleTree.forEach((node) => appendNode(node));
  const sideTaskCount = state.index.threads.filter((thread) => thread.relation?.kind === "side-task").length;
  const conversationCount = state.index.threads.length - sideTaskCount;
  $("#thread-count").textContent = sideTaskCount
    ? `${conversationCount} 个对话 · ${sideTaskCount} 个侧边任务`
    : `${conversationCount} 个对话`;
  $("#search-state").textContent = normalized ? `${matchingIds.size} 项匹配` : "";
}

async function openThread(thread) {
  resetIdleTimer();
  clearTimeout(searchTimer);
  const request = ++state.openRequest;
  state.searchRequest += 1;
  const newestPath = isChunkedThread(thread) ? thread.chunks.at(-1)?.file : thread.file;
  transferManager.cancelBackground(newestPath);
  transferManager.cancelForeground(newestPath);
  state.selectedId = thread.id;
  state.currentThread = thread;
  state.currentSession = null;
  state.firstLoadedChunkIndex = -1;
  state.renderedStart = 0;
  state.loadingOlder = false;
  state.olderProgress = "";
  setTitleCollapsed(false, { preserveScroll: false });
  $("#empty-state").hidden = true;
  $("#conversation-header").hidden = false;
  $("#conversation-title").textContent = thread.title;
  $("#conversation-date").textContent = formatDate(thread.updatedAt, true);
  $("#conversation-meta").textContent = `${thread.messages} 条可见消息`;
  $("#messages").replaceChildren();
  $("#load-older").hidden = true;
  $("#conversation-status").classList.remove("error");
  setConversationStatus("正在读取加密对话…");
  renderThreadList($("#search").value);
  closeSidebar();
  try {
    if (isChunkedThread(thread)) {
      if (thread.chunks.length === 0) {
        if (request !== state.openRequest) return;
        state.currentSession = getChunkedSession(thread);
        state.firstLoadedChunkIndex = -1;
        $("#conversation-meta").textContent = `${thread.turns} 轮 · 0 条可见消息`;
        setConversationStatus();
        renderLatestChunk({ messages: [] });
        showTitleHintOnce();
        return;
      }
      const chunkIndex = thread.chunks.length - 1;
      const chunk = await loadThreadChunk(thread, chunkIndex, {
        priority: "user",
        onProgress({ loaded, total }) {
          if (request === state.openRequest) setConversationStatus(formatTransferProgress(loaded, total));
        }
      });
      if (request !== state.openRequest || state.selectedId !== thread.id) return;
      state.currentSession = getChunkedSession(thread);
      state.firstLoadedChunkIndex = chunkIndex;
      $("#conversation-title").textContent = thread.title;
      $("#conversation-date").textContent = formatDate(thread.updatedAt, true);
      $("#conversation-meta").textContent = `${thread.turns} 轮 · ${thread.messages} 条可见消息`;
      setConversationStatus();
      renderLatestChunk(chunk);
    } else {
      let session = state.sessions.get(thread.id);
      if (!session || session.kind !== "legacy") {
        const data = await loadEncryptedJson(thread.file, thread.file, {
          cacheCipher: true,
          priority: "user",
          onProgress({ loaded, total }) {
            if (request === state.openRequest) setConversationStatus(formatTransferProgress(loaded, total));
          }
        });
        if (request !== state.openRequest || state.selectedId !== thread.id || !state.contentKey) return;
        session = { kind: "legacy", data };
        state.sessions.set(thread.id, session);
      }
      if (request !== state.openRequest || state.selectedId !== thread.id) return;
      state.currentSession = session;
      $("#conversation-title").textContent = session.data.title;
      $("#conversation-date").textContent = formatDate(session.data.updatedAt, true);
      $("#conversation-meta").textContent = `${session.data.turns} 轮 · ${session.data.messages.length} 条可见消息`;
      setConversationStatus();
      renderLegacyLatestMessages(session.data);
    }
    showTitleHintOnce();
    renderThreadList($("#search").value);
  } catch (error) {
    if (error instanceof TransferCancelledError && request === state.openRequest) {
      setConversationStatus("读取已取消，请重新打开这条对话。");
    } else if (request === state.openRequest) {
      setConversationStatus(`无法打开：${error.message}`);
      $("#conversation-status").classList.add("error");
    }
  }
}

async function prefetchRecentThreads() {
  const connection = navigator.connection ?? navigator.mozConnection ?? navigator.webkitConnection;
  const coarsePointer = globalThis.matchMedia?.("(pointer: coarse)").matches ?? false;
  if (!shouldPrefetch({
    connection, observedBytesPerSecond: state.observedBytesPerSecond, coarsePointer
  })) return;
  const queue = state.index.threads.slice(0, UI_CONFIG.prefetchThreads);
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length && state.contentKey) {
      const thread = queue[cursor++];
      const file = isChunkedThread(thread) ? thread.chunks.at(-1)?.file : thread.file;
      if (!file) continue;
      const expected = state.manifest.signed.files[file];
      if (!expected) continue;
      try {
        await fetchBytes(file, expected, { cacheCipher: true, priority: "background" });
      } catch {}
      if (!shouldPrefetch({
        connection, observedBytesPerSecond: state.observedBytesPerSecond, coarsePointer
      })) break;
    }
  };
  await Promise.all(Array.from({ length: UI_CONFIG.prefetchConcurrency }, worker));
}

async function populateSearchCache(query, request) {
  if (!query.trim()) return renderThreadList();
  if (request !== state.searchRequest || !state.contentKey) return;
  transferManager.cancelBackground();
  $("#search-state").textContent = "正在搜索…";
  for (const [threadIndex, thread] of state.index.threads.entries()) {
    if (request !== state.searchRequest || !state.contentKey) return;
    try {
      if (isChunkedThread(thread)) {
        for (let chunkIndex = thread.chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
          if (request !== state.searchRequest) return;
          await loadThreadChunk(thread, chunkIndex, {
            priority: "user",
            onProgress({ loaded, total }) {
              if (request !== state.searchRequest) return;
              const detail = formatTransferProgress(loaded, total).replace("正在读取加密对话… ", "");
              $("#search-state").textContent = `正在搜索 ${threadIndex + 1}/${state.index.threads.length} · ${detail}`;
            }
          });
        }
      } else if (!state.sessions.has(thread.id)) {
        const data = await loadEncryptedJson(thread.file, thread.file, { cacheCipher: true, priority: "user" });
        if (request !== state.searchRequest || !state.contentKey) return;
        state.sessions.set(thread.id, { kind: "legacy", data });
      }
    } catch (error) {
      if (error instanceof TransferCancelledError || request !== state.searchRequest) return;
      $("#search-state").textContent = `搜索失败：${error.message}`;
      return;
    }
  }
  if (request === state.searchRequest) renderThreadList(query);
}

let searchTimer;
function onSearch(event) {
  const request = ++state.searchRequest;
  clearTimeout(searchTimer);
  if (!event.target.value.trim()) return renderThreadList();
  searchTimer = setTimeout(() => populateSearchCache(event.target.value, request), 350);
}

function closeSidebar() {
  $("#sidebar").classList.remove("open");
  $("#scrim").classList.remove("open");
}

function setTitleCollapsed(collapsed, { preserveScroll = true } = {}) {
  const next = Boolean(collapsed && state.selectedId);
  const request = ++state.titleLayoutRequest;
  const scroller = $("#conversation-scroll");
  const oldTop = scroller.scrollTop;
  const scrollHeight = scroller.scrollHeight;
  const oldClientHeight = scroller.clientHeight;
  state.titleCollapsed = next;
  $("#conversation").classList.toggle("title-collapsed", next);
  $("#conversation-header").setAttribute("aria-hidden", String(next));
  if (!preserveScroll) return;
  requestAnimationFrame(() => {
    if (request !== state.titleLayoutRequest) return;
    scroller.scrollTop = preserveBottomOffset(oldTop, scrollHeight, oldClientHeight, scroller.clientHeight);
    state.lastScrollTop = scroller.scrollTop;
  });
}

function dismissTitleHint() {
  clearTimeout(state.hintTimer);
  state.hintTimer = null;
  $("#title-toggle-hint").hidden = true;
}

function showTitleHintOnce() {
  let seen = false;
  try { seen = localStorage.getItem(TITLE_HINT_STORAGE_KEY) === "1"; } catch {}
  if (seen) return;
  try { localStorage.setItem(TITLE_HINT_STORAGE_KEY, "1"); } catch {}
  $("#title-toggle-hint").hidden = false;
  clearTimeout(state.hintTimer);
  state.hintTimer = setTimeout(dismissTitleHint, 2800);
}

function resetConversationView() {
  cancelReaderZoomGesture({ persist: true });
  titlePointers.clear();
  titleTap = null;
  state.selectedId = null;
  state.currentThread = null;
  state.currentSession = null;
  state.firstLoadedChunkIndex = -1;
  state.renderedStart = 0;
  state.loadingOlder = false;
  state.olderProgress = "";
  state.lastScrollTop = 0;
  setTitleCollapsed(false, { preserveScroll: false });
  $("#conversation-header").hidden = true;
  $("#conversation-title").textContent = "";
  $("#conversation-date").textContent = "";
  $("#conversation-meta").textContent = "";
  $("#messages").replaceChildren();
  $("#conversation-status").textContent = "";
  $("#conversation-status").classList.remove("error");
  $("#load-older").hidden = true;
  $("#load-older").disabled = false;
  $("#load-older").textContent = "加载更早消息";
  $("#empty-state").hidden = false;
  $("#conversation-scroll").scrollTop = 0;
  $("#search").value = "";
  $("#search-state").textContent = "";
  closeSidebar();
  dismissTitleHint();
}

function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  if (state.contentKey) state.idleTimer = setTimeout(() => lockViewer("因闲置已自动锁定。"), state.idleMinutes * 60 * 1000);
}

function clearPlaintext() {
  transferManager.cancelAll();
  state.contentKey = null;
  state.index = null;
  state.sessions.clear();
  state.expandedThreadIds.clear();
  state.openRequest += 1;
  state.searchRequest += 1;
  state.unlockRequest += 1;
  state.unlocking = false;
  clearTimeout(state.idleTimer);
  clearTimeout(searchTimer);
  resetConversationView();
  $("#thread-list").replaceChildren();
  $("#thread-count").textContent = "0 个对话";
  $("#passphrase").value = "";
  $("#passphrase").type = "password";
}

function lockViewer(message = "已锁定。", error = false) {
  clearPlaintext();
  $("#unlock-button").disabled = false;
  $("#viewer").hidden = true;
  $("#locked").hidden = false;
  setLockStatus(message, error);
  $("#passphrase").focus();
}

async function unlock(event) {
  event.preventDefault();
  const request = ++state.unlockRequest;
  const button = $("#unlock-button");
  const passphrase = $("#passphrase").value;
  state.unlocking = true;
  button.disabled = true;
  setLockStatus("正在本设备上派生解密密钥…");
  try {
    const contentKey = await unwrapContentKey(passphrase, state.manifest.signed.keyEnvelope);
    if (request !== state.unlockRequest || document.hidden) {
      if (request === state.unlockRequest) lockViewer("页面进入后台，解锁已取消。");
      return;
    }
    state.contentKey = contentKey;
    const index = await loadEncryptedJson(state.manifest.signed.indexFile, state.manifest.signed.indexFile, {
      onProgress({ loaded, total }) {
        if (request === state.unlockRequest) {
          setLockStatus(formatTransferProgress(loaded, total).replace("加密对话", "加密索引"));
        }
      }
    });
    if (request !== state.unlockRequest || document.hidden) {
      if (request === state.unlockRequest) lockViewer("页面进入后台，解锁已取消。");
      return;
    }
    state.index = index;
    state.index.threads = sortThreadsByUpdatedAt(state.index.threads);
    const previousSequence = Number(localStorage.getItem("cmv.sequence") || 0);
    localStorage.setItem("cmv.sequence", String(Math.max(previousSequence, state.manifest.signed.sequence)));
    $("#passphrase").value = "";
    $("#locked").hidden = true;
    $("#viewer").hidden = false;
    $("#sync-time").textContent = `同步于 ${formatDate(state.index.generatedAt, true)}`;
    resetConversationView();
    renderThreadList();
    resetIdleTimer();
    removeOldCipherCaches().catch(() => {});
    prefetchRecentThreads().catch(() => {});
  } catch (error) {
    if (request !== state.unlockRequest) return;
    clearPlaintext();
    button.disabled = false;
    const message = error?.name === "OperationError"
      ? "口令错误，或快照已损坏。"
      : `无法解锁：${error.message}`;
    setLockStatus(message, true);
  } finally {
    if (request === state.unlockRequest) {
      state.unlocking = false;
      button.disabled = false;
    }
  }
}

async function initialize() {
  try {
    const bytes = await fetchBytes("manifest.json");
    state.manifest = JSON.parse(decoder.decode(bytes));
    await verifyManifest(state.manifest);
    setLockStatus("快照验证通过，等待解锁。");
  } catch (error) {
    $("#unlock-button").disabled = true;
    setLockStatus(error.message, true);
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
}

const titlePointers = new Set();
const readerPointers = new Map();
let titleTap = null;

function beginReaderZoom(event) {
  if (event.pointerType !== "touch") return;
  const excluded = event.target instanceof Element
    && Boolean(event.target.closest(PINCH_EXCLUDED_SELECTOR));
  if (excluded) return;
  readerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try { event.currentTarget.setPointerCapture(event.pointerId); } catch {}
  if (readerPointers.size > 2) {
    if (state.zoomGesture?.active) finishReaderZoomGesture();
    state.zoomGesture = null;
    return;
  }
  if (readerPointers.size !== 2) return;
  const entries = [...readerPointers.entries()];
  const distance = pointDistance(entries[0][1], entries[1][1]);
  if (distance < 24) return;
  state.zoomGesture = {
    pointerIds: entries.map(([pointerId]) => pointerId),
    startDistance: distance,
    startScale: state.readerScale,
    active: false
  };
  if (titleTap) titleTap.hadMultiplePointers = true;
}

function moveReaderZoom(event) {
  if (event.pointerType !== "touch" || !readerPointers.has(event.pointerId)) return;
  readerPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  const gesture = state.zoomGesture;
  if (!gesture || !gesture.pointerIds.every((pointerId) => readerPointers.has(pointerId))) return;
  const [left, right] = gesture.pointerIds.map((pointerId) => readerPointers.get(pointerId));
  const result = readerScaleFromPinch({
    startScale: gesture.startScale,
    startDistance: gesture.startDistance,
    currentDistance: pointDistance(left, right),
    active: gesture.active,
    activationRatio: UI_CONFIG.readerZoom.activationRatio,
    minimum: UI_CONFIG.readerZoom.minimum,
    maximum: UI_CONFIG.readerZoom.maximum
  });
  gesture.active = result.active;
  if (!result.active) return;
  event.preventDefault();
  if (titleTap) titleTap.hadMultiplePointers = true;
  clearTimeout(state.zoomIndicatorTimer);
  applyReaderScale(result.scale, { showControl: true });
}

function endReaderZoom(event) {
  readerPointers.delete(event.pointerId);
  if (!state.zoomGesture?.pointerIds.includes(event.pointerId)) return;
  if (state.zoomGesture.active) finishReaderZoomGesture();
  else state.zoomGesture = null;
}

function beginTitleTap(event) {
  titlePointers.add(event.pointerId);
  if (titlePointers.size === 1) {
    titleTap = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startedAt: performance.now(),
      scrollTop: $("#conversation-scroll").scrollTop,
      target: event.target,
      hadMultiplePointers: false
    };
  } else if (titleTap) {
    titleTap.hadMultiplePointers = true;
  }
}

function finishTitleTap(event) {
  const tap = titleTap;
  const hadMultiplePointers = Boolean(tap?.hadMultiplePointers || titlePointers.size > 1);
  titlePointers.delete(event.pointerId);
  if (!tap || tap.pointerId !== event.pointerId) return;
  titleTap = null;
  if (!state.currentSession) return;

  const distance = Math.hypot(event.clientX - tap.x, event.clientY - tap.y);
  const scrollDelta = Math.abs($("#conversation-scroll").scrollTop - tap.scrollTop);
  const interactiveTarget = tap.target instanceof Element
    && Boolean(tap.target.closest("button, a, input, textarea, select, [contenteditable='true']"));
  const hasSelection = Boolean(globalThis.getSelection?.()?.toString());
  if (canToggleConversationTitle({
    distance,
    scrollDelta,
    durationMs: performance.now() - tap.startedAt,
    hadMultiplePointers,
    interactiveTarget,
    hasSelection
  })) setTitleCollapsed(!state.titleCollapsed);
}

function cancelTitleTap(event) {
  titlePointers.delete(event.pointerId);
  if (titleTap?.pointerId === event.pointerId) titleTap = null;
  else if (titleTap) titleTap.hadMultiplePointers = true;
}

$("#unlock-form").addEventListener("submit", unlock);
$("#toggle-passphrase").addEventListener("click", () => {
  const field = $("#passphrase");
  field.type = field.type === "password" ? "text" : "password";
});
$("#lock-button").addEventListener("click", () => lockViewer("已手动锁定。"));
$("#theme-button").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next, true);
});
$("#nav-button").addEventListener("click", () => {
  $("#sidebar").classList.add("open"); $("#scrim").classList.add("open");
});
$("#scrim").addEventListener("click", closeSidebar);
$("#title-toggle-hint-close").addEventListener("click", dismissTitleHint);
$("#reader-zoom-reset").addEventListener("click", resetReaderScale);
$("#search").addEventListener("input", onSearch);
$("#load-older").addEventListener("click", loadOlderMessages);
$("#conversation-scroll").addEventListener("pointerdown", beginTitleTap, { passive: true });
$("#conversation-scroll").addEventListener("pointerdown", beginReaderZoom, { passive: true });
$("#conversation-scroll").addEventListener("pointermove", moveReaderZoom, { passive: false });
$("#conversation-scroll").addEventListener("pointerup", finishTitleTap, { passive: true });
$("#conversation-scroll").addEventListener("pointerup", endReaderZoom, { passive: true });
$("#conversation-scroll").addEventListener("pointercancel", cancelTitleTap, { passive: true });
$("#conversation-scroll").addEventListener("pointercancel", endReaderZoom, { passive: true });
$("#conversation-scroll").addEventListener("scroll", (event) => {
  const currentTop = event.currentTarget.scrollTop;
  const movingUp = currentTop < state.lastScrollTop - 1;
  state.lastScrollTop = currentTop;
  if (movingUp && currentTop <= UI_CONFIG.topLoadThreshold) loadOlderMessages();
}, { passive: true });
for (const eventName of ["pointerdown", "keydown", "scroll"]) {
  document.addEventListener(eventName, resetIdleTimer, { passive: true });
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden && (state.contentKey || state.unlocking)) lockViewer("页面进入后台，已自动锁定。");
});
initializeTheme();
initializeReaderScale();
initialize();
