import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectToFile, unprotectFromFile } from "../src/node/dpapi.mjs";

test("Windows DPAPI protects and restores bytes for the current user", { skip: process.platform !== "win32" }, () => {
  const temporaryRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp");
  const file = path.join(temporaryRoot, `dpapi-${process.pid}.bin`);
  fs.mkdirSync(temporaryRoot, { recursive: true });
  try {
    const plaintext = Buffer.from("synthetic-test-secret", "utf8");
    protectToFile(file, plaintext);
    assert.equal(fs.readFileSync(file).includes(plaintext), false);
    assert.deepEqual(unprotectFromFile(file), plaintext);
  } finally {
    fs.rmSync(file, { force: true });
    try { fs.rmdirSync(temporaryRoot); } catch {}
  }
});
