import path from "node:path";
import { fileURLToPath } from "node:url";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const dataDir = path.join(projectRoot, "data");
export const distDir = path.join(projectRoot, "dist");
export const webDir = path.join(projectRoot, "web");
export const scriptsDir = path.join(projectRoot, "scripts");
export const configPath = path.join(dataDir, "config.json");
export const statePath = path.join(dataDir, "state.json");
export const sessionsRoot = path.join(process.env.USERPROFILE ?? "", ".codex", "sessions");
export const sessionIndexPath = path.join(process.env.USERPROFILE ?? "", ".codex", "session_index.jsonl");
