import { createHash } from "node:crypto";

const ALLOWED_AGENT_PHASES = new Set(["commentary", "final_answer"]);
export const PARSER_REVISION = 5;

function quoteMarkdown(text) {
  return String(text).split(/\r?\n/u).map((line) => "> " + line).join("\n");
}

function normalizeResponseAnnotations(text) {
  const match = String(text).match(
    /(?:^|\n)\s*(?:#{1,6}\s*)?Response annotations:\s*[\s\S]*?<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>\s*(?:#{1,6}\s*)?My request for Codex:\s*([\s\S]*)$/iu
  );
  if (!match) return null;
  let annotations;
  try { annotations = JSON.parse(match[1]); }
  catch { return null; }
  if (!Array.isArray(annotations) || !annotations.length) return null;

  const sections = ["## 引用内容"];
  annotations.forEach((annotation, index) => {
    const selected = typeof annotation?.text === "string" ? annotation.text.trim() : "";
    const comment = [annotation?.comment, annotation?.user_comment]
      .find((value) => typeof value === "string" && value.trim())?.trim();
    if (annotations.length > 1) sections.push("### 引用 " + (index + 1));
    if (selected) sections.push(quoteMarkdown(selected));
    if (comment) sections.push("### 我的批注\n" + comment);
  });
  const request = match[2].trim();
  if (request) sections.push("## 我的提问\n" + request);
  return sections.join("\n\n");
}

function normalizeFileMentions(text) {
  const match = String(text).match(
    /^\s*(?:#{1,6}\s*)?Files mentioned by the user:\s*([\s\S]*?)\s*(?:#{1,6}\s*)?My request for Codex:\s*([\s\S]*)$/iu
  );
  if (!match) return null;
  const names = match[1].split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const separator = line.indexOf(": ");
    return (separator >= 0 ? line.slice(0, separator) : line)
      .replace(/^(?:#{1,6}|[-*])\s*/u, "").trim();
  }).filter(Boolean);
  const sections = [];
  if (names.length) sections.push("## 相关文件\n" + names.map((name) => "- " + name).join("\n"));
  const request = match[2].trim();
  if (request) sections.push("## 我的提问\n" + request);
  return sections.join("\n\n");
}

export function normalizeUserMessage(text) {
  const source = typeof text === "string" ? text.trim() : "";
  if (!source) return "";
  return normalizeResponseAnnotations(source) ?? normalizeFileMentions(source) ?? source;
}

export function parseJsonLines(text) {
  const records = [];
  const errors = [];
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { errors.push(index + 1); }
  }
  return { records, errors };
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && typeof item === "object" && ["input_text", "output_text", "text"].includes(item.type))
    .map((item) => item.text ?? "")
    .join("\n");
}

function pushUserTurn(turns, text, timestamp) {
  const normalized = normalizeUserMessage(text);
  if (!normalized) return;
  turns.push({ timestamp: timestamp ?? null, messages: [
    { role: "user", phase: "user", text: normalized, timestamp: timestamp ?? null },
  ] });
}

function pushAgentMessage(turns, text, phase, timestamp) {
  if (!ALLOWED_AGENT_PHASES.has(phase) || !text?.trim() || turns.length === 0) return;
  turns.at(-1).messages.push({ role: "assistant", phase, text: text.trim(), timestamp: timestamp ?? null });
}

function parseEventMessages(records) {
  const turns = [];
  for (const record of records) {
    if (record?.type !== "event_msg" || !record.payload) continue;
    const payload = record.payload;
    if (payload.type === "user_message") pushUserTurn(turns, payload.message, record.timestamp);
    else if (payload.type === "agent_message") pushAgentMessage(turns, payload.message, payload.phase, record.timestamp);
    else if (payload.type === "thread_rolled_back") {
      const count = Number.isSafeInteger(payload.num_turns) && payload.num_turns > 0 ? payload.num_turns : 0;
      if (count) turns.splice(Math.max(0, turns.length - count), count);
    }
  }
  return turns;
}

function parseResponseItems(records) {
  const turns = [];
  for (const record of records) {
    const payload = record?.type === "response_item" ? record.payload : null;
    if (payload?.type !== "message") continue;
    const text = textFromContent(payload.content);
    if (payload.role === "user") pushUserTurn(turns, text, record.timestamp);
    if (payload.role === "assistant") pushAgentMessage(turns, text, payload.phase ?? "final_answer", record.timestamp);
  }
  return turns;
}

export function parseSession(text, { title = "未命名对话" } = {}) {
  const { records, errors } = parseJsonLines(text);
  const hasVisibleEvents = records.some((record) =>
    record?.type === "event_msg" && ["user_message", "agent_message", "thread_rolled_back"].includes(record.payload?.type));
  const turns = hasVisibleEvents ? parseEventMessages(records) : parseResponseItems(records);
  const messages = turns.flatMap((turn) => turn.messages);
  const firstTimestamp = messages.find((message) => message.timestamp)?.timestamp ?? null;
  const updatedAt = [...messages].reverse().find((message) => message.timestamp)?.timestamp ?? firstTimestamp;
  return { title, firstTimestamp, updatedAt, turns: turns.length, messages, parseErrors: errors };
}

export function stableThreadFingerprint(session) {
  return createHash("sha256").update(JSON.stringify(session)).digest("hex");
}

export function latestTimestamp(...values) {
  let latest = null;
  let latestTime = -Infinity;
  for (const value of values) {
    const time = typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(time) && time > latestTime) {
      latest = value;
      latestTime = time;
    }
  }
  return latest;
}

export function extractSessionId(text) {
  return extractSessionDescriptor(text)?.id ?? null;
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function humanizeTaskPath(value) {
  const source = nonemptyString(value);
  if (!source) return null;
  const leaf = source.split(/[\\/]/u).filter(Boolean).at(-1);
  const words = leaf?.replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
  return words ? words[0].toLocaleUpperCase() + words.slice(1) : null;
}

export function extractSessionDescriptor(text) {
  const { records } = parseJsonLines(text);
  const payload = records.find((record) => record?.type === "session_meta")?.payload;
  const id = nonemptyString(payload?.id);
  if (!id) return null;

  const spawn = payload?.source?.subagent?.thread_spawn;
  if (!spawn || typeof spawn !== "object") {
    return { id, relation: { kind: "conversation", parentSessionId: null, depth: 0 }, fallbackTitle: null };
  }

  const spawnParent = nonemptyString(spawn.parent_thread_id);
  const directParent = nonemptyString(payload.parent_thread_id);
  const forkParent = nonemptyString(payload.forked_from_id);
  const explicitParents = [spawnParent, directParent].filter(Boolean);
  const parentsAgree = explicitParents.length > 0 && new Set(explicitParents).size === 1;
  const forkAgrees = !forkParent || (parentsAgree && forkParent === explicitParents[0]);
  const parentSessionId = parentsAgree && forkAgrees ? explicitParents[0] : null;
  const taskTitle = humanizeTaskPath(spawn.agent_path ?? payload.agent_path)
    ?? nonemptyString(spawn.agent_nickname ?? payload.agent_nickname)
    ?? "侧边任务";
  const depth = Number.isSafeInteger(spawn.depth) && spawn.depth > 0 ? spawn.depth : 1;
  return {
    id,
    relation: {
      kind: "side-task",
      parentSessionId,
      depth,
      orphaned: !parentSessionId
    },
    fallbackTitle: taskTitle
  };
}

export function readThreadIndex(text) {
  const { records, errors } = parseJsonLines(text);
  if (errors.length) {
    throw new Error(`Codex 桌面对话索引无法解析：${errors.length} 行内容损坏。`);
  }
  const result = new Map();
  for (const record of records) {
    if (typeof record?.id !== "string") continue;
    result.set(record.id, {
      title: typeof record.thread_name === "string" && record.thread_name.trim() ? record.thread_name.trim() : "未命名对话",
      updatedAt: record.updated_at ?? null,
    });
  }
  return result;
}
