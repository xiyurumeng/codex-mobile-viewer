import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function ensureDir(directory) { fs.mkdirSync(directory, { recursive: true }); }
export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
}
export function writeAtomic(file, content) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}
export function walkFiles(root, suffix = "") {
  if (!fs.existsSync(root)) return [];
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...walkFiles(full, suffix));
    else if (!suffix || entry.name.endsWith(suffix)) output.push(full);
  }
  return output;
}
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function acquireLock(file, staleMilliseconds = 30 * 60 * 1000) {
  ensureDir(path.dirname(file));
  try {
    const fd = fs.openSync(file, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return () => { try { fs.closeSync(fd); } catch {} try { fs.unlinkSync(file); } catch {} };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const age = Date.now() - fs.statSync(file).mtimeMs;
    if (age > staleMilliseconds) { fs.unlinkSync(file); return acquireLock(file, staleMilliseconds); }
    const lockError = new Error("另一个同步进程正在运行。"); lockError.code = "LOCKED"; throw lockError;
  }
}
