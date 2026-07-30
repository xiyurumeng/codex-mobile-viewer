import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { walkFiles } from "./files.mjs";

const API = "https://api.cloudflare.com/client/v4";
const MIME = new Map([
  [".html", "text/html;charset=UTF-8"], [".css", "text/css;charset=UTF-8"],
  [".js", "application/javascript;charset=UTF-8"], [".json", "application/json;charset=UTF-8"],
  [".webmanifest", "application/manifest+json;charset=UTF-8"], [".txt", "text/plain;charset=UTF-8"]
]);

async function request(token, pathname, { method = "GET", body, headers = {} } = {}) {
  const response = await fetch(`${API}${pathname}`, {
    method, body, headers: { Authorization: `Bearer ${token}`, ...headers }, signal: AbortSignal.timeout(120000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) {
    const message = data.errors?.map((item) => item.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Cloudflare API 请求失败：${message}`);
  }
  return data.result ?? data;
}

export async function verifyToken(token) {
  const result = await request(token, "/user/tokens/verify");
  if (result.status !== "active") throw new Error("Cloudflare API Token 不是 active 状态。");
  return true;
}

export async function resolveAccountId(token, configuredId = "") {
  if (configuredId) return configuredId;
  const accounts = await request(token, "/accounts");
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error("无法唯一确定 Cloudflare Account ID，请在管理菜单的 Cloudflare 设置中明确填写。");
  }
  return accounts[0].id;
}

async function ensureProject(token, accountId, projectName) {
  try { return await request(token, `/accounts/${accountId}/pages/projects/${projectName}`); }
  catch (error) {
    if (!/not found|不存在|8000007|HTTP 404/iu.test(error.message)) throw error;
    return request(token, `/accounts/${accountId}/pages/projects`, {
      method: "POST", body: JSON.stringify({ name: projectName, production_branch: "main" }),
      headers: { "Content-Type": "application/json" }
    });
  }
}

function assetHash(content, pathname) {
  const encoded = Buffer.from(content).toString("base64");
  return createHash("md5").update(`${encoded}${pathname}`).digest("hex");
}

function collectAssets(directory) {
  const assets = [];
  for (const file of walkFiles(directory)) {
    const pathname = `/${path.relative(directory, file).replaceAll("\\", "/")}`;
    const content = fs.readFileSync(file);
    assets.push({
      pathname, content, hash: assetHash(content, pathname),
      contentType: MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream"
    });
  }
  return assets;
}

async function uploadBucket(jwt, bucket) {
  await request(jwt, "/pages/assets/upload", {
    method: "POST", body: JSON.stringify(bucket), headers: { "Content-Type": "application/json" }
  });
}

export async function deployDirectory({ token, accountId, projectName, directory }) {
  await verifyToken(token);
  await ensureProject(token, accountId, projectName);
  const uploadToken = await request(token, `/accounts/${accountId}/pages/projects/${projectName}/upload-token`);
  const assets = collectAssets(directory);
  if (assets.length > 20000) throw new Error("文件数超过 Cloudflare Pages 免费计划的 20,000 个限制。");
  for (const asset of assets) if (asset.content.length > 25 * 1024 * 1024) throw new Error(`文件超过 25 MiB：${asset.pathname}`);
  const bucket = [];
  let bytes = 0;
  for (const asset of assets) {
    const item = { key: asset.hash, value: asset.content.toString("base64"), metadata: { contentType: asset.contentType }, base64: true };
    if (bucket.length && bytes + asset.content.length > 45 * 1024 * 1024) {
      await uploadBucket(uploadToken.jwt, bucket.splice(0));
      bytes = 0;
    }
    bucket.push(item);
    bytes += asset.content.length;
  }
  if (bucket.length) await uploadBucket(uploadToken.jwt, bucket);
  await request(uploadToken.jwt, "/pages/assets/upsert-hashes", {
    method: "POST", body: JSON.stringify({ hashes: assets.map((asset) => asset.hash) }),
    headers: { "Content-Type": "application/json" }
  });
  const form = new FormData();
  form.set("manifest", JSON.stringify(Object.fromEntries(assets.map((asset) => [asset.pathname, asset.hash]))));
  const deployment = await request(token, `/accounts/${accountId}/pages/projects/${projectName}/deployments`, { method: "POST", body: form });
  return { id: deployment.id, url: deployment.url, productionUrl: `https://${projectName}.pages.dev`, files: assets.length };
}

export async function getLatestDeployment(token, accountId, projectName) {
  const items = await request(token, `/accounts/${accountId}/pages/projects/${projectName}/deployments`);
  return Array.isArray(items) ? items[0] ?? null : null;
}
