import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSigningKeyPair, decryptAesGcm, verifyBytes, wrapContentKey } from "../src/core/crypto.mjs";
import { buildSnapshot } from "../src/node/snapshot.mjs";

const line = (type, payload, timestamp) => JSON.stringify({ type, payload, timestamp });

function readEncryptedIndex(directory, contentKey) {
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, "snapshot.enc.json"), "utf8"));
  return JSON.parse(decryptAesGcm(envelope, contentKey, "snapshot.enc.json").toString());
}

function readEncryptedChunk(directory, chunk, contentKey) {
  const envelope = JSON.parse(fs.readFileSync(path.join(directory, chunk.file), "utf8"));
  return JSON.parse(decryptAesGcm(envelope, contentKey, chunk.file).toString());
}

test("builds a signed encrypted snapshot and reuses unchanged thread ciphertext", () => {
  const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "cmv-test-"));
  try {
    const sessions = path.join(root, "sessions");
    const web = path.join(root, "web");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const recovered = path.join(root, "recovered");
    const migrated = path.join(root, "migrated");
    fs.mkdirSync(sessions);
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<h1>shell</h1>");
    fs.writeFileSync(path.join(root, "index.jsonl"), `${JSON.stringify({ id: "raw-session-id", thread_name: "测试标题", updated_at: "2025-12-31T00:00:00Z" })}\n`);
    fs.writeFileSync(path.join(sessions, "session.jsonl"), [
      line("session_meta", { id: "raw-session-id" }, "2026-01-01T00:00:00Z"),
      line("event_msg", { type: "user_message", message: "<script>not executable</script>" }, "2026-01-01T00:00:01Z"),
      line("event_msg", { type: "agent_reasoning", text: "NEVER_UPLOAD_REASONING" }, "2026-01-01T00:00:02Z"),
      line("event_msg", { type: "agent_message", phase: "final_answer", message: "安全答案" }, "2026-01-01T00:00:03Z")
    ].join("\n"));
    const contentKey = Buffer.alloc(32, 3);
    const keys = createSigningKeyPair();
    const keyEnvelope = wrapContentKey(contentKey, "test-passphrase", 1000);
    const one = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: first, contentKey, keyEnvelope, publicKey: keys.publicKey, privateKey: keys.privateKey
    });
    const manifest = JSON.parse(fs.readFileSync(path.join(first, "manifest.json"), "utf8"));
    assert.equal(verifyBytes(JSON.stringify(manifest.signed), manifest.signature, keys.publicKey), true);
    assert.equal(manifest.signed.schemaVersion, 2);
    assert.equal(one.schemaVersion, 2);
    const allBytes = fs.readdirSync(first, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name))).join("");
    assert.doesNotMatch(allBytes, /raw-session-id|测试标题|安全答案|NEVER_UPLOAD_REASONING/u);
    const index = readEncryptedIndex(first, contentKey);
    assert.equal(index.schemaVersion, 2);
    assert.equal(index.threads[0].title, "测试标题");
    assert.equal(index.threads[0].updatedAt, "2026-01-01T00:00:03Z");
    assert.equal(index.threads[0].turns, 1);
    assert.equal(index.threads[0].messages, 2);
    assert.deepEqual(index.threads[0].relation, {
      kind: "conversation", parentId: null, depth: 0, orphaned: false
    });
    assert.deepEqual(index.threads[0].chunks.map(({ start, count }) => ({ start, count })), [{ start: 0, count: 2 }]);
    assert.equal(Object.hasOwn(index.threads[0], "file"), false);
    const [chunk] = index.threads[0].chunks;
    const chunkPayload = readEncryptedChunk(first, chunk, contentKey);
    assert.equal(chunkPayload.schemaVersion, 2);
    assert.equal(chunkPayload.threadId, index.threads[0].id);
    assert.equal(chunkPayload.start, 0);
    assert.equal(chunkPayload.count, 2);
    assert.equal(chunkPayload.messages[1].text, "安全答案");
    const firstCiphertext = fs.readFileSync(path.join(first, chunk.file));
    const two = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: second, previousOutputDir: first, contentKey, keyEnvelope,
      publicKey: keys.publicKey, privateKey: keys.privateKey, previousState: one
    });
    assert.equal(two.changedThreads, 0);
    assert.equal(two.reusedThreads, 1);
    assert.equal(two.changedChunks, 0);
    assert.equal(two.reusedChunks, 1);
    assert.deepEqual(fs.readFileSync(path.join(second, chunk.file)), firstCiphertext);

    fs.writeFileSync(path.join(second, chunk.file), "tampered ciphertext");
    const recovery = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: recovered, previousOutputDir: second, contentKey, keyEnvelope,
      publicKey: keys.publicKey, privateKey: keys.privateKey, previousState: two
    });
    assert.equal(recovery.changedThreads, 1);
    assert.equal(recovery.changedChunks, 1);
    assert.equal(readEncryptedChunk(recovered, chunk, contentKey).messages[1].text, "安全答案");

    const legacyState = {
      schemaVersion: 1,
      sequence: one.sequence,
      sources: {
        [index.threads[0].id]: {
          fingerprint: one.sources[index.threads[0].id].fingerprint,
          bytes: one.sources[index.threads[0].id].bytes
        }
      }
    };
    const migration = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: migrated, previousOutputDir: first, contentKey, keyEnvelope,
      publicKey: keys.publicKey, privateKey: keys.privateKey, previousState: legacyState
    });
    assert.equal(migration.schemaVersion, 2);
    assert.equal(migration.changedThreads, 1);
    assert.equal(migration.reusedThreads, 0);
    assert.equal(migration.changedChunks, 1);
    assert.equal(migration.reusedChunks, 0);
    assert.notDeepEqual(fs.readFileSync(path.join(migrated, chunk.file)), firstCiphertext);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(temporaryRoot); } catch {}
  }
});

test("uses the desktop index for ordinary conversations and still groups side tasks", () => {
  const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "cmv-tree-"));
  try {
    const sessions = path.join(root, "sessions");
    const web = path.join(root, "web");
    const output = path.join(root, "output");
    fs.mkdirSync(sessions);
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<h1>shell</h1>");
    fs.writeFileSync(path.join(root, "index.jsonl"), [
      JSON.stringify({ id: "raw-parent-id", thread_name: "父对话" }),
      JSON.stringify({ id: "raw-fork-id", thread_name: "普通派生对话" })
    ].join("\n"));
    fs.writeFileSync(path.join(sessions, "parent.jsonl"), [
      line("session_meta", { id: "raw-parent-id" }, "2026-01-01T00:00:00Z"),
      line("event_msg", { type: "user_message", message: "父问题" }, "2026-01-01T00:00:01Z")
    ].join("\n"));
    fs.writeFileSync(path.join(sessions, "child.jsonl"), [
      line("session_meta", {
        id: "raw-child-id",
        parent_thread_id: "raw-parent-id",
        forked_from_id: "raw-parent-id",
        source: { subagent: { thread_spawn: {
          parent_thread_id: "raw-parent-id", depth: 1, agent_path: "/root/frontend_audit"
        } } }
      }, "2026-01-01T00:00:02Z"),
      line("event_msg", { type: "user_message", message: "子任务" }, "2026-01-01T00:00:03Z")
    ].join("\n"));
    fs.writeFileSync(path.join(sessions, "fork.jsonl"), [
      line("session_meta", { id: "raw-fork-id", forked_from_id: "raw-parent-id" }, "2026-01-01T00:00:04Z"),
      line("event_msg", { type: "user_message", message: "普通派生问题" }, "2026-01-01T00:00:05Z")
    ].join("\n"));
    fs.writeFileSync(path.join(sessions, "hidden-history.jsonl"), [
      line("session_meta", { id: "raw-hidden-id" }, "2025-12-01T00:00:00Z"),
      line("event_msg", { type: "user_message", message: "桌面侧栏已经隐藏的旧任务" }, "2025-12-01T00:00:01Z")
    ].join("\n"));

    const contentKey = Buffer.alloc(32, 9);
    const keys = createSigningKeyPair();
    const built = buildSnapshot({
      sessionsRoot: sessions,
      sessionIndexPath: path.join(root, "index.jsonl"),
      webDir: web,
      outputDir: output,
      contentKey,
      keyEnvelope: wrapContentKey(contentKey, "test-passphrase", 1000),
      publicKey: keys.publicKey,
      privateKey: keys.privateKey
    });
    const index = readEncryptedIndex(output, contentKey);
    const parent = index.threads.find((thread) => thread.title === "父对话");
    const child = index.threads.find((thread) => thread.title === "Frontend audit");
    const fork = index.threads.find((thread) => thread.title === "普通派生对话");
    assert.equal(built.threads, 3);
    assert.equal(Object.keys(built.sources).length, 3);
    assert.equal(child.relation.kind, "side-task");
    assert.equal(child.relation.parentId, parent.id);
    assert.equal(child.relation.orphaned, false);
    assert.equal(fork.relation.kind, "conversation");
    assert.equal(fork.relation.parentId, null);
    assert.equal(index.threads.some((thread) => thread.title === "未命名对话"), false);
    const allBytes = fs.readdirSync(output, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)))
      .join("");
    assert.doesNotMatch(allBytes, /raw-parent-id|raw-child-id|raw-fork-id|raw-hidden-id/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(temporaryRoot); } catch {}
  }
});

test("keeps an explicit side task as orphaned when its hidden parent is not indexed", () => {
  const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "cmv-orphan-"));
  try {
    const sessions = path.join(root, "sessions");
    const web = path.join(root, "web");
    const output = path.join(root, "output");
    fs.mkdirSync(sessions);
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<h1>shell</h1>");
    fs.writeFileSync(path.join(root, "index.jsonl"), "");
    fs.writeFileSync(path.join(sessions, "hidden-parent.jsonl"), [
      line("session_meta", { id: "hidden-parent" }, "2026-01-01T00:00:00Z"),
      line("event_msg", { type: "user_message", message: "hidden" }, "2026-01-01T00:00:01Z")
    ].join("\n"));
    fs.writeFileSync(path.join(sessions, "visible-child.jsonl"), [
      line("session_meta", {
        id: "visible-child", parent_thread_id: "hidden-parent",
        source: { subagent: { thread_spawn: {
          parent_thread_id: "hidden-parent", depth: 1, agent_path: "/root/orphan_audit"
        } } }
      }, "2026-01-01T00:00:02Z"),
      line("event_msg", { type: "user_message", message: "child" }, "2026-01-01T00:00:03Z")
    ].join("\n"));

    const contentKey = Buffer.alloc(32, 8);
    const keys = createSigningKeyPair();
    const built = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: output, contentKey, keyEnvelope: wrapContentKey(contentKey, "test-passphrase", 1000),
      publicKey: keys.publicKey, privateKey: keys.privateKey
    });
    const index = readEncryptedIndex(output, contentKey);
    assert.equal(built.threads, 1);
    assert.equal(index.threads[0].title, "Orphan audit");
    assert.deepEqual(index.threads[0].relation, {
      kind: "side-task", parentId: null, depth: 1, orphaned: true
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(temporaryRoot); } catch {}
  }
});

test("fails closed when the desktop thread index is missing", () => {
  const contentKey = Buffer.alloc(32, 4);
  const keys = createSigningKeyPair();
  assert.throws(() => buildSnapshot({
    sessionsRoot: "unused", sessionIndexPath: "missing-index.jsonl", webDir: "unused", outputDir: "unused",
    contentKey, keyEnvelope: wrapContentKey(contentKey, "test-passphrase", 1000),
    publicKey: keys.publicKey, privateKey: keys.privateKey
  }), /桌面对话索引/u);
});

test("chunks messages in groups of 40 and only rewrites the changed tail", () => {
  const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryRoot, "cmv-chunks-"));
  try {
    const sessions = path.join(root, "sessions");
    const web = path.join(root, "web");
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const sessionFile = path.join(sessions, "session.jsonl");
    fs.mkdirSync(sessions);
    fs.mkdirSync(web);
    fs.writeFileSync(path.join(web, "index.html"), "<h1>shell</h1>");
    fs.writeFileSync(path.join(root, "index.jsonl"), `${JSON.stringify({ id: "chunk-session", thread_name: "分片测试" })}\n`);

    const records = [line("session_meta", { id: "chunk-session" }, "2026-01-01T00:00:00Z")];
    for (let index = 0; index < 415; index += 1) {
      records.push(line(
        "event_msg",
        { type: "user_message", message: `消息 ${String(index + 1).padStart(3, "0")}` },
        new Date(Date.UTC(2026, 0, 1, 0, 0, index + 1)).toISOString()
      ));
    }
    fs.writeFileSync(sessionFile, records.join("\n"));

    const contentKey = Buffer.alloc(32, 7);
    const keys = createSigningKeyPair();
    const keyEnvelope = wrapContentKey(contentKey, "test-passphrase", 1000);
    const one = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: first, contentKey, keyEnvelope, publicKey: keys.publicKey, privateKey: keys.privateKey
    });
    const firstIndex = readEncryptedIndex(first, contentKey);
    const firstThread = firstIndex.threads[0];
    assert.deepEqual(firstThread.chunks.map(({ count }) => count), [
      40, 40, 40, 40, 40, 40, 40, 40, 40, 15, 40
    ]);
    assert.equal(firstThread.chunks.at(-1).start, 375);
    assert.equal(one.changedChunks, 11);
    assert.equal(one.sources[firstThread.id].chunks.length, 11);
    const originalCiphertext = firstThread.chunks.map((chunk) => fs.readFileSync(path.join(first, chunk.file)));

    records.push(line(
      "event_msg",
      { type: "user_message", message: "消息 416" },
      new Date(Date.UTC(2026, 0, 1, 0, 6, 56)).toISOString()
    ));
    fs.writeFileSync(sessionFile, records.join("\n"));
    const two = buildSnapshot({
      sessionsRoot: sessions, sessionIndexPath: path.join(root, "index.jsonl"), webDir: web,
      outputDir: second, previousOutputDir: first, contentKey, keyEnvelope,
      publicKey: keys.publicKey, privateKey: keys.privateKey, previousState: one
    });
    const secondIndex = readEncryptedIndex(second, contentKey);
    const secondThread = secondIndex.threads[0];
    assert.deepEqual(secondThread.chunks.map(({ count }) => count), [
      40, 40, 40, 40, 40, 40, 40, 40, 40, 16, 40
    ]);
    assert.equal(secondThread.chunks.at(-1).start, 376);
    assert.equal(two.changedThreads, 1);
    assert.equal(two.reusedThreads, 0);
    assert.equal(two.changedChunks, 2);
    assert.equal(two.reusedChunks, 9);
    for (let index = 0; index < 9; index += 1) {
      assert.deepEqual(fs.readFileSync(path.join(second, secondThread.chunks[index].file)), originalCiphertext[index]);
    }
    assert.notDeepEqual(fs.readFileSync(path.join(second, secondThread.chunks[9].file)), originalCiphertext[9]);
    assert.notDeepEqual(fs.readFileSync(path.join(second, secondThread.chunks[10].file)), originalCiphertext[10]);

    const messages = secondThread.chunks.flatMap((chunk) => readEncryptedChunk(second, chunk, contentKey).messages);
    assert.equal(messages.length, 416);
    assert.equal(messages[0].text, "消息 001");
    assert.equal(messages.at(-1).text, "消息 416");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.rmdirSync(temporaryRoot); } catch {}
  }
});
