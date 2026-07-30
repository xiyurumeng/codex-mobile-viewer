const DEFAULT_STALL_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export class TransferCancelledError extends Error {
  constructor(message = "下载已取消。") {
    super(message);
    this.name = "TransferCancelledError";
  }
}

export class TransferStalledError extends Error {
  constructor() {
    super("下载长时间没有收到数据，已停止。请检查网络后重新打开这条对话。");
    this.name = "TransferStalledError";
  }
}

export function formatTransferProgress(loaded, total = 0) {
  const loadedKiB = Math.max(0, loaded) / 1024;
  if (total > 0) {
    const totalKiB = total / 1024;
    const percentage = Math.min(100, Math.round((loaded / total) * 100));
    return `正在读取加密对话… ${percentage}%（${loadedKiB.toFixed(1)} / ${totalKiB.toFixed(1)} KiB）`;
  }
  return `正在读取加密对话… ${loadedKiB.toFixed(1)} KiB`;
}

export function shouldPrefetch({ connection, observedBytesPerSecond = 0, coarsePointer = false } = {}) {
  if (connection?.saveData) return false;
  if (["slow-2g", "2g", "3g"].includes(connection?.effectiveType)) return false;
  if (Number(connection?.downlink) > 0 && Number(connection.downlink) < 5) return false;
  if (observedBytesPerSecond > 0 && observedBytesPerSecond < 512 * 1024) return false;
  if (coarsePointer && observedBytesPerSecond < 1024 * 1024) return false;
  return true;
}

function parseContentLength(response) {
  const value = Number(response.headers?.get?.("content-length"));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export class TransferManager {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    now = () => globalThis.performance?.now?.() ?? Date.now(),
    onSample = () => {}
  } = {}) {
    if (!fetchImpl) throw new Error("当前环境不支持网络请求。");
    this.fetchImpl = fetchImpl;
    this.stallTimeoutMs = stallTimeoutMs;
    this.maxBytes = maxBytes;
    this.now = now;
    this.onSample = onSample;
    this.jobs = new Map();
  }

  cancelBackground(exceptPathname = null) {
    for (const job of this.jobs.values()) {
      if (job.priority === "background" && job.pathname !== exceptPathname) job.controller.abort();
    }
  }

  cancelForeground(exceptPathname = null) {
    for (const job of this.jobs.values()) {
      if (job.priority === "user" && job.pathname !== exceptPathname) job.controller.abort();
    }
  }

  cancelAll() {
    for (const job of this.jobs.values()) job.controller.abort();
  }

  async download(pathname, requestOptions = {}, { priority = "user", onProgress, dedupeKey = pathname } = {}) {
    let job = this.jobs.get(dedupeKey);
    if (job?.controller.signal.aborted) job = null;
    if (!job) {
      job = this.createJob(pathname, requestOptions, priority, dedupeKey);
      this.jobs.set(dedupeKey, job);
    } else if (priority === "user") {
      job.priority = "user";
    }

    if (onProgress) {
      job.listeners.add(onProgress);
      if (job.progress) onProgress(job.progress);
    }
    try {
      return await job.promise;
    } finally {
      if (onProgress) job.listeners.delete(onProgress);
    }
  }

  createJob(pathname, requestOptions, priority, dedupeKey) {
    const controller = new AbortController();
    const job = {
      controller,
      listeners: new Set(),
      pathname,
      priority,
      progress: null,
      promise: null
    };
    job.promise = this.runJob(pathname, requestOptions, job)
      .finally(() => {
        if (this.jobs.get(dedupeKey) === job) this.jobs.delete(dedupeKey);
      });
    return job;
  }

  async runJob(pathname, requestOptions, job) {
    const startedAt = this.now();
    let stalled = false;
    let policyError = null;
    let timer = null;
    const resetStallTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        job.controller.abort();
      }, this.stallTimeoutMs);
    };
    const notify = (loaded, total) => {
      job.progress = { loaded, total };
      for (const listener of job.listeners) listener(job.progress);
    };

    resetStallTimer();
    try {
      const response = await this.fetchImpl(pathname, {
        ...requestOptions,
        signal: job.controller.signal
      });
      if (!response.ok) throw new Error(`无法读取加密文件（HTTP ${response.status}）`);
      const total = parseContentLength(response);
      if (total > this.maxBytes) throw new Error("加密文件尺寸异常，已停止下载。");
      resetStallTimer();

      let bytes;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          loaded += value.byteLength;
          if (loaded > this.maxBytes) {
            policyError = new Error("加密文件尺寸异常，已停止下载。");
            job.controller.abort();
            throw policyError;
          }
          chunks.push(value);
          notify(loaded, total);
          resetStallTimer();
        }
        bytes = new Uint8Array(loaded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (loaded === 0) notify(0, total);
      } else {
        bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > this.maxBytes) throw new Error("加密文件尺寸异常，已停止下载。");
        notify(bytes.byteLength, total);
      }

      const durationMs = Math.max(1, this.now() - startedAt);
      this.onSample({ pathname, bytes: bytes.byteLength, durationMs, priority: job.priority });
      return bytes;
    } catch (error) {
      if (stalled) throw new TransferStalledError();
      if (policyError) throw policyError;
      if (job.controller.signal.aborted) throw new TransferCancelledError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}
