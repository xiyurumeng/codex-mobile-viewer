import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("user-facing CMD launchers contain ASCII only", () => {
  for (const name of ["Codex对话-管理菜单.cmd", "Codex对话-一键同步.cmd"]) {
    const bytes = fs.readFileSync(path.join(root, name));
    assert.equal([...bytes].every((value) => value < 128), true, `${name} contains non-ASCII bytes`);
  }
});

test("management launcher delegates rendering to Node", () => {
  const source = fs.readFileSync(path.join(root, "Codex对话-管理菜单.cmd"), "ascii");
  assert.match(source, /node src\\menu\.mjs/u);
});

test("PowerShell compatibility wrappers contain ASCII only", () => {
  for (const name of ["rename-cloudflare-project.ps1", "install-autosync.ps1", "uninstall-autosync.ps1"]) {
    const bytes = fs.readFileSync(path.join(root, "scripts", name));
    assert.equal([...bytes].every((value) => value < 128), true, `${name} contains non-ASCII bytes`);
  }
});

test("rename menu calls the Node command without a PowerShell prompt wrapper", () => {
  const source = fs.readFileSync(path.join(root, "src", "menu.mjs"), "utf8");
  assert.match(source, /runCli\("rename-cloudflare-project", project\)/u);
  assert.doesNotMatch(source, /runPowerShell\("rename-cloudflare-project\.ps1"\)/u);
});

test("automatic sync uses a network event instead of fixed retry polling", () => {
  const source = fs.readFileSync(path.join(root, "scripts", "install-autosync.ps1"), "ascii");
  assert.match(source, /EventID=10000/u);
  assert.doesNotMatch(source, /RepetitionInterval/u);
});

test("Git ignores local secrets, logs and every encrypted snapshot directory", () => {
  const source = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  const rules = source.split(/\r?\n/u);
  for (const pattern of [
    "data/", "dist/", "dist.previous/", "dist.staging.*/", "logs/", "test/.tmp/",
    ".env", ".env.*", "*.dpapi", "*.log", "*.pem", "*.key", "*.p12", "*.pfx"
  ]) {
    assert.ok(rules.includes(pattern), `missing ignore rule: ${pattern}`);
  }
});

test("public instructions do not disclose the current deployment hostname", () => {
  const publicText = [
    fs.readFileSync(path.join(root, "README.md"), "utf8"),
    fs.readFileSync(path.join(root, "src", "menu.mjs"), "utf8")
  ].join("\n");
  assert.doesNotMatch(publicText, /xiyurumeng-codex-mobile|codex-mobile-lenovo/u);
});
