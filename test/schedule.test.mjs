import test from "node:test";
import assert from "node:assert/strict";
import { scheduledBudgetStatus, scheduledSlotId } from "../src/core/schedule.mjs";

const times = ["00:00", "11:55"];

test("maps retries to the same daily schedule slot", () => {
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 0, 0), times), "2026-07-30@00:00");
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 0, 45), times), "2026-07-30@00:00");
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 11, 54), times), "2026-07-30@00:00");
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 11, 55), times), "2026-07-30@11:55");
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 12, 40), times), "2026-07-30@11:55");
});

test("uses the previous day when before the first configured time", () => {
  assert.equal(scheduledSlotId(new Date(2026, 6, 30, 7, 0), ["08:00", "20:00"]), "2026-07-29@20:00");
});

test("rejects invalid schedules", () => {
  assert.throws(() => scheduledSlotId(new Date(), []), /至少需要/u);
  assert.throws(() => scheduledSlotId(new Date(), ["24:00"]), /时间无效/u);
});

test("scheduled deployment budget counts only supplied automatic history", () => {
  const now = new Date(2026, 6, 30, 12, 0);
  const history = [
    new Date(2026, 6, 30, 0, 1).toISOString(),
    new Date(2026, 6, 30, 11, 56).toISOString()
  ];
  assert.deepEqual(scheduledBudgetStatus(now, history, 2, 62), {
    allowed: false, reason: "已达到今日自动部署上限"
  });
  assert.equal(scheduledBudgetStatus(now, history.slice(0, 1), 2, 62).allowed, true);
});
