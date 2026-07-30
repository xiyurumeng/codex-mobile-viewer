import test from "node:test";
import assert from "node:assert/strict";
import {
  formatTransferProgress, shouldPrefetch, TransferManager, TransferStalledError
} from "../web/network-utils.js";

test("formats determinate and indeterminate transfer progress", () => {
  assert.match(formatTransferProgress(1024, 4096), /25%/u);
  assert.match(formatTransferProgress(2048), /2\.0 KiB/u);
});

test("prefetch is disabled for constrained or unmeasured mobile connections", () => {
  assert.equal(shouldPrefetch({ connection: { saveData: true } }), false);
  assert.equal(shouldPrefetch({ connection: { effectiveType: "3g" } }), false);
  assert.equal(shouldPrefetch({ coarsePointer: true }), false);
  assert.equal(shouldPrefetch({ coarsePointer: true, observedBytesPerSecond: 2 * 1024 * 1024 }), true);
  assert.equal(shouldPrefetch({ connection: { effectiveType: "4g", downlink: 20 } }), true);
});

test("deduplicates concurrent downloads and reports progress to every caller", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { "content-length": "4" }
    });
  };
  const manager = new TransferManager({ fetchImpl });
  const firstProgress = [];
  const secondProgress = [];
  const [first, second] = await Promise.all([
    manager.download("chunk.json", {}, { onProgress: (value) => firstProgress.push(value.loaded) }),
    manager.download("chunk.json", {}, { onProgress: (value) => secondProgress.push(value.loaded) })
  ]);
  assert.equal(requests, 1);
  assert.deepEqual(first, new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(second, first);
  assert.deepEqual(firstProgress, [4]);
  assert.deepEqual(secondProgress, [4]);
});

test("aborts a request that receives no data before the stall deadline", async () => {
  const fetchImpl = (_pathname, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  });
  const manager = new TransferManager({ fetchImpl, stallTimeoutMs: 10 });
  await assert.rejects(manager.download("stalled.json"), TransferStalledError);
});

test("a cancelled job cannot replace or delete a new download for the same path", async () => {
  let requests = 0;
  const fetchImpl = (_pathname, options) => {
    requests += 1;
    if (requests === 2) return Promise.resolve(new Response(new Uint8Array([9])));
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  };
  const manager = new TransferManager({ fetchImpl });
  const cancelled = manager.download("same.json").catch((error) => error);
  manager.cancelForeground();
  const replacement = manager.download("same.json");
  assert.equal((await cancelled).name, "TransferCancelledError");
  assert.deepEqual(await replacement, new Uint8Array([9]));
  assert.equal(requests, 2);
});

test("an oversized streamed response is reported as invalid instead of cancelled", async () => {
  const manager = new TransferManager({
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4])),
    maxBytes: 3
  });
  await assert.rejects(manager.download("oversized.json"), /加密文件尺寸异常/u);
});
