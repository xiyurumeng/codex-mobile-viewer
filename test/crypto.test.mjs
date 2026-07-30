import test from "node:test";
import assert from "node:assert/strict";
import {
  createSigningKeyPair, encryptAesGcm, decryptAesGcm,
  signBytes, verifyBytes, wrapContentKey, unwrapContentKey
} from "../src/core/crypto.mjs";

test("passphrase wrapping and AES-GCM round trip", () => {
  const contentKey = Buffer.alloc(32, 7);
  const wrapped = wrapContentKey(contentKey, "correct horse battery staple", 1000);
  assert.deepEqual(unwrapContentKey(wrapped, "correct horse battery staple"), contentKey);
  assert.throws(() => unwrapContentKey(wrapped, "wrong"));
  const envelope = encryptAesGcm("hello", contentKey, "aad");
  assert.equal(decryptAesGcm(envelope, contentKey, "aad").toString(), "hello");
});

test("Ed25519 detects manifest changes", () => {
  const pair = createSigningKeyPair();
  const signature = signBytes("manifest", pair.privateKey);
  assert.equal(verifyBytes("manifest", signature, pair.publicKey), true);
  assert.equal(verifyBytes("changed", signature, pair.publicKey), false);
});
