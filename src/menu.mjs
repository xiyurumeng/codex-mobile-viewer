import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "src", "cli.mjs");
const scripts = path.join(projectRoot, "scripts");
const input = createInterface({ input: process.stdin, output: process.stdout });

function scheduleSummary() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(projectRoot, "data", "config.json"), "utf8"));
    return config.sync.dailyTimes.join("、");
  } catch { return "配置的每日时段"; }
}

function run(executable, args) {
  console.log("");
  const result = spawnSync(executable, args, { cwd: projectRoot, stdio: "inherit", windowsHide: false });
  if (result.error) console.error(`启动失败：${result.error.message}`);
  else if (result.status) console.error(`操作未成功，退出码：${result.status}`);
  console.log("");
  return result.status ?? 1;
}

const runCli = (...args) => run(process.execPath, [cli, ...args]);
const runPowerShell = (script) => run("powershell.exe", [
  "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(scripts, script)
]);

async function pause() {
  try { await input.question("按 Enter 键返回菜单……"); } catch {}
}

async function execute(action) {
  action();
  await pause();
}

function validProjectName(value) {
  return /^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/u.test(value);
}

async function renameCloudflareProject() {
  const project = (await input.question("请输入新的项目名（例如 my-codex-mobile）：")).trim();
  if (!validProjectName(project)) {
    console.error("项目名无效：只能使用小写字母、数字和连字符，长度 1-59，首尾不能是连字符。");
    await pause();
    return;
  }
  await execute(() => runCli("rename-cloudflare-project", project));
}

async function cloudflareMenu() {
  while (true) {
    console.log("\n---------------- Cloudflare 与网址设置 ----------------\n  1. 首次配置或重新录入 Account ID / API Token\n  2. 更换 pages.dev 项目名（创建新网址，旧站不删除）\n  0. 返回");
    const choice = (await input.question("请输入数字：")).trim();
    if (choice === "0") return;
    if (choice === "1") await execute(() => runPowerShell("configure-cloudflare.ps1"));
    if (choice === "2") await renameCloudflareProject();
  }
}

async function autosyncMenu() {
  while (true) {
    console.log(`\n-------------------- 自动同步设置 --------------------\n  1. 安装或修复每日 ${scheduleSummary()} 自动同步\n  2. 关闭自动同步\n  0. 返回`);
    const choice = (await input.question("请输入数字：")).trim();
    if (choice === "0") return;
    if (choice === "1") await execute(() => runPowerShell("install-autosync.ps1"));
    if (choice === "2") await execute(() => runPowerShell("uninstall-autosync.ps1"));
  }
}

async function securityMenu() {
  while (true) {
    console.log("\n---------------- 解锁口令与 Token 安全 ----------------\n  1. 更换手机端解锁口令\n  2. 删除本机保存的 Cloudflare Token\n  0. 返回");
    const choice = (await input.question("请输入数字：")).trim();
    if (choice === "0") return;
    if (choice === "1") await execute(() => runCli("rotate-passphrase"));
    if (choice === "2") {
      const confirm = (await input.question("删除后将无法部署。确认删除请输入 DELETE：")).trim();
      if (confirm === "DELETE") await execute(() => runCli("remove-token"));
    }
  }
}

async function main() {
  while (true) {
    console.log("\n============================================================\n                 Codex 手机对话查看器\n============================================================\n  1. 一键同步到手机\n  2. 查看运行状态\n  3. 执行安全检查\n  4. 只生成本地加密快照（不联网）\n  5. 首次初始化\n  6. Cloudflare 与网址设置\n  7. 自动同步设置\n  8. 解锁口令与 Token 安全\n  0. 退出\n============================================================");
    const choice = (await input.question("请输入数字：")).trim();
    if (choice === "0") return;
    if (choice === "1") await execute(() => runCli("sync"));
    if (choice === "2") await execute(() => runCli("status"));
    if (choice === "3") await execute(() => runCli("security-check"));
    if (choice === "4") await execute(() => runCli("sync", "--local-only"));
    if (choice === "5") await execute(() => runCli("setup"));
    if (choice === "6") await cloudflareMenu();
    if (choice === "7") await autosyncMenu();
    if (choice === "8") await securityMenu();
  }
}

try { await main(); }
catch (error) {
  if (error?.code !== "ERR_USE_AFTER_CLOSE") {
    console.error(`菜单异常：${error.message}`);
    process.exitCode = 1;
  }
} finally { input.close(); }
