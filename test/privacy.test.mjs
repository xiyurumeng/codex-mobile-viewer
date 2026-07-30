import test from "node:test";
import assert from "node:assert/strict";
import { assertSnapshotSafe, redactUnsafeSession, scanTextForSecrets } from "../src/core/privacy.mjs";

test("recognizes credentials but ignores placeholders", () => {
  assert.equal(scanTextForSecrets("Authorization: Bearer <API_TOKEN>").length, 0);
  assert.equal(scanTextForSecrets(`value sk-proj-${"A".repeat(32)}`).length, 1);
  assert.equal(scanTextForSecrets(`cfut_${"x".repeat(40)}`).length, 1);
});

test("forbidden structural fields stop a build", () => {
  assert.throws(() => assertSnapshotSafe({ title: "x", reasoning: "secret" }), { code: "PRIVACY_SCAN_FAILED" });
  assert.doesNotThrow(() => assertSnapshotSafe({ title: "x", messages: [{ role: "user", text: "hello" }] }));
});

test("omits an entire credential-bearing message without weakening detection", () => {
  const secret = `sk-proj-${"A".repeat(32)}`;
  const original = {
    title: "safe title",
    messages: [
      { role: "user", phase: "user", text: `keep this ${secret} surrounding context private` },
      { role: "assistant", phase: "final_answer", text: "safe answer" }
    ]
  };
  const { session, redactions } = redactUnsafeSession(original);
  assert.equal(redactions.length, 1);
  assert.equal(redactions[0].messageNumber, 1);
  assert.doesNotMatch(JSON.stringify(session), /sk-proj|surrounding context/u);
  assert.match(session.messages[0].text, /疑似敏感凭据/u);
  assert.doesNotThrow(() => assertSnapshotSafe(session));
  assert.equal(scanTextForSecrets(`still detect ${secret}`).length, 1);
});
