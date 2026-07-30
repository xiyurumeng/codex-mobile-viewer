import test from "node:test";
import assert from "node:assert/strict";
import {
  extractSessionDescriptor, latestTimestamp, normalizeUserMessage, parseSession, readThreadIndex
} from "../src/core/parser.mjs";

const lines = (...items) => items.map((item) => JSON.stringify(item)).join("\n");
const event = (type, payload, timestamp = "2026-01-01T00:00:00Z") => ({ type, timestamp, payload });

test("keeps only user, commentary and final messages", () => {
  const input = lines(
    event("event_msg", { type: "user_message", message: "问题" }),
    event("event_msg", { type: "agent_reasoning", text: "隐藏推理" }),
    event("event_msg", { type: "agent_message", phase: "commentary", message: "处理中" }),
    event("event_msg", { type: "mcp_tool_call_end", result: "隐藏工具结果" }),
    event("event_msg", { type: "agent_message", phase: "final_answer", message: "答案" })
  );
  const session = parseSession(input, { title: "测试" });
  assert.deepEqual(session.messages.map(({ role, phase, text }) => ({ role, phase, text })), [
    { role: "user", phase: "user", text: "问题" },
    { role: "assistant", phase: "commentary", text: "处理中" },
    { role: "assistant", phase: "final_answer", text: "答案" }
  ]);
  assert.doesNotMatch(JSON.stringify(session), /隐藏/u);
});

test("rollback removes complete latest turns", () => {
  const input = lines(
    event("event_msg", { type: "user_message", message: "保留" }),
    event("event_msg", { type: "agent_message", phase: "final_answer", message: "保留答案" }),
    event("event_msg", { type: "user_message", message: "撤销" }),
    event("event_msg", { type: "agent_message", phase: "final_answer", message: "撤销答案" }),
    event("event_msg", { type: "thread_rolled_back", num_turns: 1 })
  );
  assert.deepEqual(parseSession(input).messages.map((message) => message.text), ["保留", "保留答案"]);
});

test("event messages take precedence over duplicate response items", () => {
  const input = lines(
    event("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "重复" }] }),
    event("event_msg", { type: "user_message", message: "唯一" })
  );
  assert.deepEqual(parseSession(input).messages.map((message) => message.text), ["唯一"]);
});

test("turns response annotation transport text into readable Chinese sections", () => {
  const raw = "# Response annotations:\nEach item contains text selected from an earlier Codex response and may include a user comment. Use every selection as context and address every comment in your response. <response-annotations> [{\"text\":\"1+0.1 经就近舍入后是 3F8CCCCDH\"}] </response-annotations>\n\n## My request for Codex:\n这怎么得出来的怎么算的";
  const normalized = normalizeUserMessage(raw);
  assert.match(normalized, /^## 引用内容/u);
  assert.match(normalized, /> 1\+0\.1 经就近舍入后是 3F8CCCCDH/u);
  assert.match(normalized, /## 我的提问\n这怎么得出来的怎么算的/u);
  assert.doesNotMatch(normalized, /Response annotations|Each item contains|response-annotations|My request for Codex/u);
});

test("turns file mention transport text into file names without local paths", () => {
  const raw = "# Files mentioned by the user:\n\n## book.pdf: D:/private/course/book.pdf\n\n## My request for Codex:\n从第一章开始";
  const normalized = normalizeUserMessage(raw);
  assert.match(normalized, /## 相关文件\n- book\.pdf/u);
  assert.match(normalized, /## 我的提问\n从第一章开始/u);
  assert.doesNotMatch(normalized, /D:\/private|Files mentioned by the user|My request for Codex/u);
});

test("chooses the newest valid timestamp", () => {
  assert.equal(latestTimestamp("2026-07-17T00:00:00Z", "2026-07-29T18:33:00Z"), "2026-07-29T18:33:00Z");
  assert.equal(latestTimestamp(null, "invalid"), null);
});

test("recognizes a side task and restores its missing title from agent_path", () => {
  const descriptor = extractSessionDescriptor(lines(event("session_meta", {
    id: "child-id",
    parent_thread_id: "parent-id",
    forked_from_id: "parent-id",
    source: { subagent: { thread_spawn: {
      parent_thread_id: "parent-id", depth: 1, agent_path: "/root/snapshot_chunking",
      agent_nickname: "Fallback nickname"
    } } }
  })));
  assert.deepEqual(descriptor, {
    id: "child-id",
    relation: { kind: "side-task", parentSessionId: "parent-id", depth: 1, orphaned: false },
    fallbackTitle: "Snapshot chunking"
  });
});

test("a fork without subagent metadata remains a top-level conversation", () => {
  const descriptor = extractSessionDescriptor(lines(event("session_meta", {
    id: "fork-id", forked_from_id: "parent-id"
  })));
  assert.deepEqual(descriptor.relation, {
    kind: "conversation", parentSessionId: null, depth: 0
  });
});

test("conflicting side-task parents are marked orphaned instead of guessed", () => {
  const descriptor = extractSessionDescriptor(lines(event("session_meta", {
    id: "child-id",
    parent_thread_id: "parent-a",
    source: { subagent: { thread_spawn: {
      parent_thread_id: "parent-b", depth: 2, agent_nickname: "Named helper"
    } } }
  })));
  assert.equal(descriptor.relation.kind, "side-task");
  assert.equal(descriptor.relation.parentSessionId, null);
  assert.equal(descriptor.relation.orphaned, true);
  assert.equal(descriptor.fallbackTitle, "Named helper");
});

test("rejects a damaged desktop thread index", () => {
  assert.throws(() => readThreadIndex('{"id":"valid"}\n{damaged'), /桌面对话索引/u);
});
