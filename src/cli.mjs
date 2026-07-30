import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createSigningKeyPair, signBytes, verifyBytes, wrapContentKey } from "./core/crypto.mjs";
import { deployDirectory, getLatestDeployment, resolveAccountId } from "./node/cloudflare.mjs";
import { protectToFile, unprotectFromFile } from "./node/dpapi.mjs";
import { acquireLock, ensureDir, readJson, sha256, walkFiles, writeJsonAtomic } from "./node/files.mjs";
import {
  configPath, dataDir, distDir, projectRoot, sessionIndexPath, sessionsRoot, statePath, webDir
} from "./node/paths.mjs";
import { buildSnapshot } from "./node/snapshot.mjs";
import { PARSER_REVISION } from "./core/parser.mjs";
import { scheduledBudgetStatus, scheduledSlotId } from "./core/schedule.mjs";

const keyFile = path.join(dataDir, "content-key.dpapi");
const signingFile = path.join(dataDir, "signing-key.dpapi");
const tokenFile = path.join(dataDir, "cloudflare-token.dpapi");
const cloudflarePath = path.join(dataDir, "cloudflare.json");
const envelopePath = path.join(dataDir, "key-envelope.json");
const lockPath = path.join(dataDir, "sync.lock");
const logDir = path.join(projectRoot, "logs");

function log(message, level = "INFO") {
  const line = `${new Date().toISOString()} [${level}] ${message}`;
  console.log(line);
  try {
    ensureDir(logDir);
    fs.appendFileSync(path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`), `${line}\n`, "utf8");
  } catch {}
}

function loadConfig() {
  const config = readJson(configPath);
  if (!config) throw new Error("尚未初始化，请打开“Codex对话-管理菜单.cmd”并选择首次初始化。");
  return config;
}

function loadSecrets() {
  return {
    contentKey: unprotectFromFile(keyFile),
    privateKey: unprotectFromFile(signingFile).toString("utf8")
  };
}

function randomPassphrase() {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(25);
  const output = [];
  for (let index = 0; index < bytes.length; index += 1) {
    output.push(alphabet[bytes[index] % alphabet.length]);
  }
  return output.join("").match(/.{1,5}/g).join("-");
}

function sourceScanFingerprint() {
  const lines = [];
  for (const file of walkFiles(sessionsRoot, ".jsonl")) {
    const stat = fs.statSync(file);
    lines.push(`${path.relative(sessionsRoot, file)}\0${stat.size}\0${stat.mtimeMs}`);
  }
  if (fs.existsSync(sessionIndexPath)) {
    const stat = fs.statSync(sessionIndexPath);
    lines.push(`index\0${stat.size}\0${stat.mtimeMs}`);
  }
  return sha256(lines.sort().join("\n"));
}

function webContentFingerprint() {
  const hash = [];
  for (const file of walkFiles(webDir)) {
    hash.push(`${path.relative(webDir, file).replaceAll("\\", "/")}\0${sha256(fs.readFileSync(file))}`);
  }
  return sha256(hash.sort().join("\n"));
}

function setup() {
  if (fs.existsSync(configPath)) throw new Error("项目已经初始化。若只是同步，请使用“Codex对话-一键同步.cmd”。");
  ensureDir(dataDir);
  const defaults = JSON.parse(fs.readFileSync(path.join(projectRoot, "config.default.json"), "utf8"));
  const contentKey = randomBytes(32);
  const signing = createSigningKeyPair();
  const passphrase = randomPassphrase();
  const keyEnvelope = wrapContentKey(contentKey, passphrase, defaults.security.pbkdf2Iterations);
  protectToFile(keyFile, contentKey);
  protectToFile(signingFile, Buffer.from(signing.privateKey, "utf8"));
  writeJsonAtomic(envelopePath, { keyEnvelope, publicKey: signing.publicKey });
  writeJsonAtomic(configPath, defaults);
  writeJsonAtomic(statePath, { schemaVersion: 1, sequence: 0, pendingDeployment: false, requiresRebuild: true, deployHistory: [] });
  contentKey.fill(0);
  console.log("");
  console.log("============================================================");
  console.log("手机端解锁口令（仅显示这一次）：");
  console.log("");
  console.log(`  ${passphrase}`);
  console.log("");
  console.log("请现在保存到密码管理器。程序不会保存这段口令，也无法找回。");
  console.log("============================================================");
  console.log("");
  log("初始化完成。下一步使用“Codex对话-管理菜单.cmd”配置 Cloudflare，或先执行本地构建。");
}

function rotatePassphrase() {
  const config = loadConfig();
  const contentKey = unprotectFromFile(keyFile);
  const passphrase = randomPassphrase();
  const keyEnvelope = wrapContentKey(contentKey, passphrase, config.security.pbkdf2Iterations);
  const envelope = readJson(envelopePath);
  writeJsonAtomic(envelopePath, { ...envelope, keyEnvelope });
  const state = readJson(statePath, {});
  writeJsonAtomic(statePath, { ...state, pendingDeployment: true, requiresRebuild: true });
  contentKey.fill(0);
  console.log("");
  console.log("新的手机端解锁口令（仅显示这一次）：");
  console.log(`  ${passphrase}`);
  console.log("旧口令将在下一次成功部署后失效。请立即保存新口令并运行“Codex对话-一键同步.cmd”。");
}

async function renameCloudflareProject(args) {
  const projectName = args[0]?.trim();
  if (!projectName || !/^[a-z0-9](?:[a-z0-9-]{0,57}[a-z0-9])?$/u.test(projectName)) {
    throw new Error("新项目名无效：只能使用小写字母、数字和连字符，长度 1-59，首尾不能是连字符。");
  }
  const cloudflare = readJson(cloudflarePath);
  if (!cloudflare || !fs.existsSync(tokenFile)) throw new Error("尚未配置 Cloudflare 或本机 Token 已删除。");
  if (!fs.existsSync(distDir)) throw new Error("本地加密快照不存在，请先执行一次同步。");
  if (cloudflare.projectName === projectName) throw new Error("新项目名与当前项目名相同。");
  const token = unprotectFromFile(tokenFile).toString("utf8");
  const accountId = await resolveAccountId(token, cloudflare.accountId);
  log(`正在创建并部署新的 Cloudflare Pages 项目：${projectName}。`);
  const result = await deployDirectory({ token, accountId, projectName, directory: distDir });
  const now = new Date().toISOString();
  const state = readJson(statePath, {});
  writeJsonAtomic(cloudflarePath, { ...cloudflare, projectName, accountId });
  writeJsonAtomic(statePath, {
    ...state, pendingDeployment: false, lastDeployedAt: now,
    lastDeploymentId: result.id, lastDeploymentUrl: result.productionUrl,
    deployHistory: [...(state.deployHistory ?? []), now].slice(-450)
  });
  log(`新网址已启用：${result.productionUrl}`);
  log(`旧项目 ${cloudflare.projectName}.pages.dev 未删除，可登录 Cloudflare 后手动处理。`, "WARN");
}

function replaceDist(staging) {
  const previous = `${distDir}.previous`;
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(distDir)) fs.renameSync(distDir, previous);
  try { fs.renameSync(staging, distDir); }
  catch (error) {
    if (fs.existsSync(previous) && !fs.existsSync(distDir)) fs.renameSync(previous, distDir);
    throw error;
  }
}

async function sync(args) {
  const release = acquireLock(lockPath);
  let contentKey;
  try {
    const config = loadConfig();
    const state = readJson(statePath, { sequence: 0, deployHistory: [] });
    const scheduled = args.has("--scheduled") || args.has("--auto");
    const slot = scheduled ? scheduledSlotId(new Date(), config.sync.dailyTimes) : null;
    if (scheduled && state.lastScheduledSlot === slot) {
      log(`自动同步时段 ${slot} 已完成，本次重试无需执行。`);
      return;
    }
    let nextState = state;
    const scanFingerprint = sourceScanFingerprint();
    const webFingerprint = webContentFingerprint();
    const parserChanged = state.parserRevision !== PARSER_REVISION;
    const webChanged = state.webFingerprint !== webFingerprint;
    const needsBuild = state.requiresRebuild || state.sequence === 0 || parserChanged || webChanged || scanFingerprint !== state.scanFingerprint;
    if (needsBuild) {
      const envelope = readJson(envelopePath);
      const secrets = loadSecrets();
      contentKey = secrets.contentKey;
      const staging = path.join(projectRoot, `dist.staging.${process.pid}`);
      fs.rmSync(staging, { recursive: true, force: true });
      log("检测到会话变化，开始解析并执行隐私扫描。");
      const built = buildSnapshot({
        sessionsRoot, sessionIndexPath, webDir, outputDir: staging, previousOutputDir: distDir,
        contentKey, keyEnvelope: envelope.keyEnvelope, publicKey: envelope.publicKey,
        privateKey: secrets.privateKey, previousState: state
      });
      const oldCount = Object.keys(state.sources ?? {}).length;
      const changed = built.changedThreads > 0 || oldCount !== Object.keys(built.sources).length
        || state.sequence === 0 || state.requiresRebuild || parserChanged || webChanged;
      if (changed) {
        replaceDist(staging);
        nextState = {
          ...state, ...built, scanFingerprint, webFingerprint, parserRevision: PARSER_REVISION, requiresRebuild: false,
          pendingDeployment: true, lastBuiltAt: built.generatedAt
        };
        writeJsonAtomic(statePath, nextState);
        const redactionKinds = [...new Set(built.redactions.flatMap((item) => item.kinds))];
        log(`本地快照完成：${built.threads} 个对话、${built.messages} 条消息，变化 ${built.changedThreads}，复用 ${built.reusedThreads}。`);
        if (built.redactions.length) {
          log(`已安全省略 ${built.redactions.length} 个含疑似凭据的标题或消息；类型：${redactionKinds.join("、")}。`, "WARN");
        }
      } else {
        fs.rmSync(staging, { recursive: true, force: true });
        nextState = { ...state, scanFingerprint, webFingerprint, parserRevision: PARSER_REVISION, requiresRebuild: false };
        writeJsonAtomic(statePath, nextState);
        log("文件属性变化，但可见对话内容没有变化。");
      }
    } else {
      log("本地会话没有变化。");
    }
    if (args.has("--local-only")) return;
    if (!nextState.pendingDeployment && !args.has("--force")) {
      if (scheduled) {
        nextState = { ...nextState, lastScheduledSlot: slot, lastScheduledCompletedAt: new Date().toISOString() };
        writeJsonAtomic(statePath, nextState);
        log(`自动同步时段 ${slot} 没有待部署变化，已完成。`);
      } else log("没有待部署变化。");
      return;
    }
    const cloudflare = readJson(cloudflarePath);
    if (!cloudflare || !fs.existsSync(tokenFile)) {
      log("Cloudflare 项目或本机 Token 未配置，保留待部署状态。", "WARN");
      return;
    }
    if (scheduled) {
      const budget = scheduledBudgetStatus(
        new Date(), nextState.scheduledDeployHistory ?? [],
        config.sync.maximumScheduledDeploysPerDay, config.sync.maximumScheduledDeploysPerMonth
      );
      if (!budget.allowed) {
        nextState = { ...nextState, lastScheduledSlot: slot, lastScheduledCompletedAt: new Date().toISOString() };
        writeJsonAtomic(statePath, nextState);
        log(`${budget.reason}，保留待部署状态。`, "WARN");
        return;
      }
    }
    const token = unprotectFromFile(tokenFile).toString("utf8");
    const accountId = await resolveAccountId(token, cloudflare.accountId);
    log("正在向 Cloudflare Pages 上传静态网页和加密快照。");
    const result = await deployDirectory({ token, accountId, projectName: cloudflare.projectName, directory: distDir });
    const now = new Date().toISOString();
    const history = [...(nextState.deployHistory ?? []), now].slice(-450);
    writeJsonAtomic(statePath, {
      ...nextState, pendingDeployment: false, lastDeployedAt: now,
      lastDeploymentId: result.id, lastDeploymentUrl: result.productionUrl, deployHistory: history,
      ...(scheduled ? {
        lastScheduledSlot: slot, lastScheduledCompletedAt: now,
        scheduledDeployHistory: [...(nextState.scheduledDeployHistory ?? []), now].slice(-200)
      } : {})
    });
    log(`部署成功：${result.productionUrl}（${result.files} 个文件）。`);
  } finally {
    if (contentKey) contentKey.fill(0);
    release();
  }
}

function status() {
  const config = readJson(configPath);
  const state = readJson(statePath);
  const cloudflare = readJson(cloudflarePath);
  const hasCloudflareConfig = fs.existsSync(cloudflarePath);
  const hasCloudflareToken = fs.existsSync(tokenFile);
  console.log(`初始化：${config ? "是" : "否"}`);
  console.log(`本地快照：${fs.existsSync(path.join(distDir, "manifest.json")) ? "存在" : "不存在"}`);
  console.log(`Cloudflare：${!hasCloudflareConfig ? "项目未配置" : hasCloudflareToken ? "已配置 Token（内容不显示）" : "项目已配置，但本机 Token 缺失"}`);
  if (state) {
    console.log(`对话：${state.threads ?? 0}，消息：${state.messages ?? 0}`);
    console.log(`最后构建：${state.lastBuiltAt ?? "无"}`);
    console.log(`最后部署：${state.lastDeployedAt ?? "无"}`);
    console.log(`等待部署：${state.pendingDeployment ? "是" : "否"}`);
    if (config?.sync?.dailyTimes) console.log(`自动同步时段：${config.sync.dailyTimes.join("、")}`);
    console.log(`最近完成的自动时段：${state.lastScheduledSlot ?? "无"}`);
    if (cloudflare?.projectName) console.log(`正式网址：https://${cloudflare.projectName}.pages.dev`);
    else if (state.lastDeploymentUrl) console.log(`部署地址：${state.lastDeploymentUrl}`);
  }
}

async function securityCheck() {
  const state = readJson(statePath);
  const manifestPath = path.join(distDir, "manifest.json");
  if (!state || !fs.existsSync(manifestPath)) throw new Error("没有可检查的本地快照。");
  const manifest = readJson(manifestPath);
  const envelope = readJson(envelopePath);
  if (manifest.signed.publicKey !== envelope.publicKey) throw new Error("manifest 公钥与本机签名基线不一致。");
  const validSignature = verifyBytes(JSON.stringify(manifest.signed), manifest.signature, manifest.signed.publicKey);
  if (!validSignature) throw new Error("本地 manifest 签名无效。");
  for (const [relative, expected] of Object.entries(manifest.signed.files)) {
    const file = path.join(distDir, relative);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) throw new Error(`文件缺失或哈希不一致：${relative}`);
  }
  const expectedFiles = new Set(Object.keys(manifest.signed.files));
  const actualFiles = new Set(walkFiles(distDir).map((file) => path.relative(distDir, file).replaceAll("\\", "/")).filter((file) => file !== "manifest.json"));
  if (expectedFiles.size !== actualFiles.size || [...actualFiles].some((file) => !expectedFiles.has(file))) {
    throw new Error("本地快照存在未签名的额外文件或文件清单不完整。");
  }
  if (manifest.signed.sequence < state.sequence) throw new Error("本地快照序号低于状态基线。");
  if (state.manifestHash && sha256(fs.readFileSync(manifestPath)) !== state.manifestHash) throw new Error("本地 manifest 与状态基线哈希不一致。");
  log(`本地安全检查通过：签名有效，${Object.keys(manifest.signed.files).length} 个文件哈希一致。`);
  const cloudflare = readJson(cloudflarePath);
  if (cloudflare && fs.existsSync(tokenFile) && state.lastDeploymentId) {
    const token = unprotectFromFile(tokenFile).toString("utf8");
    const accountId = await resolveAccountId(token, cloudflare.accountId);
    const latest = await getLatestDeployment(token, accountId, cloudflare.projectName);
    if (latest?.id !== state.lastDeploymentId) throw new Error("Cloudflare 最新部署不是由本地记录的部署，已停止信任。请在官网检查并撤销 Token。");
    log("Cloudflare 最新部署 ID 与本地基线一致。");
  }
}

function removeToken() {
  if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile, { force: true });
  log("本机保存的 Cloudflare Token 已删除。仍需登录 Cloudflare 官网撤销该 Token。", "WARN");
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "setup") setup();
  else if (command === "sync") await sync(new Set(args));
  else if (command === "status") status();
  else if (command === "security-check") await securityCheck();
  else if (command === "rotate-passphrase") rotatePassphrase();
  else if (command === "remove-token") removeToken();
  else if (command === "rename-cloudflare-project") await renameCloudflareProject(args);
  else throw new Error("未知命令。");
} catch (error) {
  log(error.message, "ERROR");
  if (error.findings) for (const finding of error.findings) log(`${finding.kind} at ${finding.path}`, "ERROR");
  process.exitCode = 1;
}
