import fs from "node:fs";
import path from "node:path";
import { anonymousName, encryptAesGcm, signBytes } from "../core/crypto.mjs";
import { assertSnapshotSafe, redactUnsafeSession } from "../core/privacy.mjs";
import {
  extractSessionDescriptor, latestTimestamp, parseSession, readThreadIndex, stableThreadFingerprint
} from "../core/parser.mjs";
import { ensureDir, sha256, walkFiles, writeAtomic, writeJsonAtomic } from "./files.mjs";

const SNAPSHOT_SCHEMA_VERSION = 2;
const MESSAGE_CHUNK_SIZE = 40;

function copyWebAssets(webDir, outputDir) {
  for (const source of walkFiles(webDir)) {
    const relative = path.relative(webDir, source);
    const destination = path.join(outputDir, relative);
    ensureDir(path.dirname(destination));
    fs.copyFileSync(source, destination);
  }
}

function buildMessageChunks(session, anonymousId, contentKey) {
  const chunks = [];
  const latestStart = Math.max(0, session.messages.length - MESSAGE_CHUNK_SIZE);
  let start = 0;
  let chunkIndex = 0;
  while (start < session.messages.length) {
    const count = start < latestStart
      ? Math.min(MESSAGE_CHUNK_SIZE, latestStart - start)
      : session.messages.length - start;
    const messages = session.messages.slice(start, start + count);
    const chunkId = anonymousName(contentKey, "chunk", `${anonymousId}\0${chunkIndex}`);
    const file = `t/${chunkId}.json`;
    const payload = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      threadId: anonymousId,
      start,
      count: messages.length,
      messages
    };
    assertSnapshotSafe(payload);
    const plaintext = JSON.stringify(payload);
    chunks.push({
      file,
      start,
      count: messages.length,
      fingerprint: sha256(plaintext),
      bytes: Buffer.byteLength(plaintext),
      plaintext
    });
    start += count;
    chunkIndex += 1;
  }
  return chunks;
}

function reusableChunk(previousSource, previousOutputDir, chunk) {
  if (!previousOutputDir || !Array.isArray(previousSource?.chunks)) return null;
  const previousChunk = previousSource.chunks.find((candidate) => candidate?.file === chunk.file);
  if (!previousChunk
    || previousChunk.start !== chunk.start
    || previousChunk.count !== chunk.count
    || previousChunk.fingerprint !== chunk.fingerprint
    || typeof previousChunk.ciphertextHash !== "string") return null;
  const source = path.join(previousOutputDir, chunk.file);
  if (!fs.existsSync(source)) return null;
  return sha256(fs.readFileSync(source)) === previousChunk.ciphertextHash ? source : null;
}

export function buildSnapshot({ sessionsRoot, sessionIndexPath, webDir, outputDir, previousOutputDir, contentKey, keyEnvelope, publicKey, privateKey, previousState = {} }) {
  if (!fs.existsSync(sessionIndexPath)) {
    throw new Error("Codex 桌面对话索引不存在，已停止构建以避免同步侧栏之外的历史会话。");
  }
  const titleIndex = readThreadIndex(fs.readFileSync(sessionIndexPath, "utf8"));
  const threadDir = path.join(outputDir, "t");
  fs.rmSync(outputDir, { recursive: true, force: true });
  ensureDir(threadDir);
  copyWebAssets(webDir, outputDir);
  const index = { schemaVersion: SNAPSHOT_SCHEMA_VERSION, generatedAt: new Date().toISOString(), threads: [] };
  const sourceState = {};
  let messageCount = 0;
  let changedThreads = 0;
  let reusedThreads = 0;
  let changedChunks = 0;
  let reusedChunks = 0;
  const redactions = [];
  const discoveredSources = [];
  const anonymousIds = new Map();
  for (const source of walkFiles(sessionsRoot, ".jsonl")) {
    const raw = fs.readFileSync(source, "utf8");
    const descriptor = extractSessionDescriptor(raw);
    if (!descriptor) continue;
    discoveredSources.push({ raw, descriptor });
  }
  const sources = discoveredSources
    .filter(({ descriptor }) => descriptor.relation.kind === "side-task" || titleIndex.has(descriptor.id))
    .map(({ raw, descriptor }) => {
      const anonymousId = anonymousName(contentKey, "thread", descriptor.id);
      anonymousIds.set(descriptor.id, anonymousId);
      return { raw, descriptor, anonymousId };
    });
  for (const { raw, descriptor, anonymousId } of sources) {
    const sessionId = descriptor.id;
    const metadata = titleIndex.get(sessionId);
    const parsedSession = parseSession(raw, {
      title: metadata?.title ?? descriptor.fallbackTitle ?? "未命名对话"
    });
    const sanitized = redactUnsafeSession(parsedSession);
    const session = sanitized.session;
    if (!session.messages.length) continue;
    for (const redaction of sanitized.redactions) {
      redactions.push({ thread: anonymousId, ...redaction });
    }
    assertSnapshotSafe(session);
    const updatedAt = latestTimestamp(metadata?.updatedAt, session.updatedAt);
    const parentId = descriptor.relation.kind === "side-task"
      ? anonymousIds.get(descriptor.relation.parentSessionId) ?? null
      : null;
    const relation = descriptor.relation.kind === "side-task"
      ? {
          kind: "side-task",
          parentId,
          depth: descriptor.relation.depth,
          orphaned: !parentId
        }
      : { kind: "conversation", parentId: null, depth: 0, orphaned: false };
    assertSnapshotSafe(relation);
    const fingerprint = stableThreadFingerprint({ ...session, updatedAt, relation });
    const chunks = buildMessageChunks(session, anonymousId, contentKey);
    const previousSource = previousState.sources?.[anonymousId];
    let allChunksReused = Array.isArray(previousSource?.chunks)
      && previousSource.chunks.length === chunks.length;
    for (const chunk of chunks) {
      const destination = path.join(outputDir, chunk.file);
      const reusable = reusableChunk(previousSource, previousOutputDir, chunk);
      ensureDir(path.dirname(destination));
      if (reusable) {
        fs.copyFileSync(reusable, destination);
        reusedChunks += 1;
      } else {
        writeJsonAtomic(destination, encryptAesGcm(chunk.plaintext, contentKey, chunk.file));
        changedChunks += 1;
        allChunksReused = false;
      }
      chunk.ciphertextHash = sha256(fs.readFileSync(destination));
    }
    const unchangedThread = previousSource?.fingerprint === fingerprint && allChunksReused;
    if (unchangedThread) reusedThreads += 1;
    else changedThreads += 1;
    index.threads.push({
      id: anonymousId,
      title: session.title,
      firstTimestamp: session.firstTimestamp,
      updatedAt,
      turns: session.turns,
      messages: session.messages.length,
      parseErrors: session.parseErrors,
      relation,
      chunks: chunks.map(({ file, start, count }) => ({ file, start, count }))
    });
    sourceState[anonymousId] = {
      fingerprint,
      bytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
      chunks: chunks.map(({ file, start, count, fingerprint: chunkFingerprint, ciphertextHash, bytes }) => ({
        file, start, count, fingerprint: chunkFingerprint, ciphertextHash, bytes
      }))
    };
    messageCount += session.messages.length;
  }
  index.threads.sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  assertSnapshotSafe(index);
  const indexFile = "snapshot.enc.json";
  writeJsonAtomic(path.join(outputDir, indexFile), encryptAesGcm(JSON.stringify(index), contentKey, indexFile));
  writeAtomic(path.join(outputDir, "_headers"), [
    "/" + "*", "  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'", "  Referrer-Policy: no-referrer", "  X-Content-Type-Options: nosniff", "  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()", "  Cross-Origin-Opener-Policy: same-origin", "", "/manifest.json", "  Cache-Control: no-store", "", "/snapshot.enc.json", "  Cache-Control: no-store", ""
  ].join("\n"));
  const files = {};
  for (const file of walkFiles(outputDir)) {
    const relative = path.relative(outputDir, file).replaceAll("\\", "/");
    if (relative === "manifest.json") continue;
    files[relative] = sha256(fs.readFileSync(file));
  }
  const signed = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sequence: (previousState.sequence ?? 0) + 1,
    generatedAt: index.generatedAt,
    indexFile,
    keyEnvelope,
    publicKey,
    files
  };
  const canonical = JSON.stringify(signed);
  writeJsonAtomic(path.join(outputDir, "manifest.json"), { signed, signature: signBytes(canonical, privateKey) });
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    sequence: signed.sequence, generatedAt: index.generatedAt, threads: index.threads.length,
    messages: messageCount, changedThreads, reusedThreads, changedChunks, reusedChunks, sources: sourceState,
    redactions,
    manifestHash: sha256(fs.readFileSync(path.join(outputDir, "manifest.json")))
  };
}
