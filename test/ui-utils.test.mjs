import test from "node:test";
import assert from "node:assert/strict";
import {
  buildThreadTree, canToggleConversationTitle, clampReaderScale, filterThreadTree,
  latestBatchStart, olderBatchStart, pointDistance, preserveScrollTop,
  preserveBottomOffset, preserveScrollRatio, readerScaleFromPinch,
  remainingMessagesBeforeChunk, resolveTheme, sortThreadsByUpdatedAt
} from "../web/ui-utils.js";

test("latest batch selects only the newest messages", () => {
  assert.equal(latestBatchStart(316, 40), 276);
  assert.equal(latestBatchStart(12, 40), 0);
});

test("older batch stops at the beginning", () => {
  assert.equal(olderBatchStart(276, 40), 236);
  assert.equal(olderBatchStart(20, 40), 0);
});

test("prepend compensation preserves the visible position", () => {
  assert.equal(preserveScrollTop(36, 800, 1320), 556);
});

test("title layout changes preserve the distance from the conversation bottom", () => {
  assert.equal(preserveBottomOffset(1500, 2000, 400, 600), 1300);
  assert.equal(preserveBottomOffset(1600, 2000, 400, 600), 1400);
});

test("reader reflow preserves relative reading progress", () => {
  assert.equal(preserveScrollRatio(800, 2000, 400, 3000, 400), 1300);
  assert.equal(preserveScrollRatio(1600, 2000, 400, 3000, 400), 2600);
  assert.equal(preserveScrollRatio(0, 400, 400, 800, 400), 0);
});

test("threads are sorted from newest edit to oldest", () => {
  const sorted = sortThreadsByUpdatedAt([
    { id: "old", updatedAt: "2026-07-17T00:00:00Z" },
    { id: "unknown", updatedAt: null },
    { id: "new", updatedAt: "2026-07-29T18:33:00Z" }
  ]);
  assert.deepEqual(sorted.map((thread) => thread.id), ["new", "old", "unknown"]);
});

test("stored theme wins and system preference is the fallback", () => {
  assert.equal(resolveTheme("dark", false), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme(null, true), "dark");
  assert.equal(resolveTheme(null, false), "light");
});

test("title toggle accepts a clean tap and rejects scroll, selection, controls, or multiple fingers", () => {
  assert.equal(canToggleConversationTitle({ distance: 4, scrollDelta: 1, durationMs: 120 }), true);
  assert.equal(canToggleConversationTitle({ distance: 20, durationMs: 120 }), false);
  assert.equal(canToggleConversationTitle({ scrollDelta: 8, durationMs: 120 }), false);
  assert.equal(canToggleConversationTitle({ durationMs: 900 }), false);
  assert.equal(canToggleConversationTitle({ hadMultiplePointers: true }), false);
  assert.equal(canToggleConversationTitle({ interactiveTarget: true }), false);
  assert.equal(canToggleConversationTitle({ hasSelection: true }), false);
});

test("remaining messages comes from the first displayed chunk offset", () => {
  const chunks = [{ start: 0 }, { start: 40 }, { start: 55 }];
  assert.equal(remainingMessagesBeforeChunk(chunks, 2), 55);
  assert.equal(remainingMessagesBeforeChunk(chunks, 0), 0);
  assert.equal(remainingMessagesBeforeChunk(chunks, -1), 0);
});

test("reader pinch waits for the activation threshold and clamps its scale", () => {
  assert.equal(pointDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.deepEqual(readerScaleFromPinch({
    startScale: 1, startDistance: 100, currentDistance: 110
  }), { active: false, scale: 1 });
  assert.deepEqual(readerScaleFromPinch({
    startScale: 1, startDistance: 100, currentDistance: 120
  }), { active: true, scale: 1.2 });
  assert.equal(readerScaleFromPinch({
    startScale: 1.2, startDistance: 100, currentDistance: 200
  }).scale, 1.3);
  assert.equal(clampReaderScale(0.2), 0.85);
  assert.equal(clampReaderScale("invalid"), 1);
});

test("thread tree groups only explicit side tasks and keeps orphaned tasks visible", () => {
  const roots = buildThreadTree([
    { id: "root", updatedAt: "2026-07-30T02:00:00Z" },
    { id: "child", updatedAt: "2026-07-30T03:00:00Z", relation: { kind: "side-task", parentId: "root" } },
    { id: "fork", updatedAt: "2026-07-30T01:00:00Z", relation: { kind: "conversation", parentId: null } },
    { id: "orphan", updatedAt: "2026-07-30T00:00:00Z", relation: { kind: "side-task", parentId: "missing" } }
  ]);
  assert.deepEqual(roots.map((node) => node.thread.id), ["root", "fork", "orphan"]);
  assert.deepEqual(roots[0].children.map((node) => node.thread.id), ["child"]);
});

test("thread tree rejects cycles and search keeps the matching ancestor path", () => {
  const roots = buildThreadTree([
    { id: "root", updatedAt: "2026-07-30T03:00:00Z" },
    { id: "child", updatedAt: "2026-07-30T02:00:00Z", relation: { kind: "side-task", parentId: "root" } },
    { id: "grandchild", updatedAt: "2026-07-30T01:00:00Z", relation: { kind: "side-task", parentId: "child" } },
    { id: "cycle-a", relation: { kind: "side-task", parentId: "cycle-b" } },
    { id: "cycle-b", relation: { kind: "side-task", parentId: "cycle-a" } }
  ]);
  assert.ok(roots.some((node) => node.thread.id === "cycle-a"));
  assert.ok(roots.some((node) => node.thread.id === "cycle-b"));
  const filtered = filterThreadTree(roots, new Set(["grandchild"]));
  assert.deepEqual(filtered.map((node) => node.thread.id), ["root"]);
  assert.equal(filtered[0].children[0].thread.id, "child");
  assert.equal(filtered[0].children[0].children[0].thread.id, "grandchild");
});
