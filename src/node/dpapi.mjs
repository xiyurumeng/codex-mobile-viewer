import { spawnSync } from "node:child_process";
import path from "node:path";
import { scriptsDir } from "./paths.mjs";

function run(mode, file, bytes) {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(scriptsDir, "dpapi.ps1"), mode, file];
  const result = spawnSync("powershell.exe", args, {
    input: bytes ? Buffer.from(bytes).toString("base64") : undefined,
    encoding: "utf8", windowsHide: true, maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`DPAPI ${mode} 失败：${(result.stderr || result.stdout || "未知错误").trim()}`);
  return mode === "unprotect" ? Buffer.from(result.stdout.trim(), "base64") : undefined;
}

export const protectToFile = (file, bytes) => run("protect", file, bytes);
export const unprotectFromFile = (file) => run("unprotect", file);
