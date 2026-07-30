const SECRET_PATTERNS = [
  ["OpenAI API Key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/gu],
  ["Cloudflare API Token", /\bcfut_[A-Za-z0-9_-]{20,}\b/gu],
  ["GitHub Token", /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/gu],
  ["AWS Access Key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu],
  ["PEM Private Key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ["Authorization Bearer", /\bAuthorization\s*:\s*Bearer\s+(?![<{$%])[A-Za-z0-9._~+\/-]{24,}/giu],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu]
];

const FORBIDDEN_KEYS = new Set([
  "reasoning", "system", "developer", "tool_call", "tool_output",
  "command_output", "session_id", "cwd", "attachments", "images"
]);

export function scanTextForSecrets(text) {
  const findings = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match) findings.push({ kind, offset: match.index });
  }
  return findings;
}

export function inspectSnapshot(snapshot) {
  const findings = [];
  const walk = (value, path = "$") => {
    if (typeof value === "string") {
      for (const finding of scanTextForSecrets(value)) findings.push({ ...finding, path });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLowerCase())) findings.push({ kind: "Forbidden field", path: `${path}.${key}` });
      walk(item, `${path}.${key}`);
    }
  };
  walk(snapshot);
  return findings;
}

export function assertSnapshotSafe(snapshot) {
  const findings = inspectSnapshot(snapshot);
  if (!findings.length) return;
  const error = new Error(`隐私扫描失败：发现 ${findings.length} 个禁止项；为避免泄露，构建已停止。`);
  error.code = "PRIVACY_SCAN_FAILED";
  error.findings = findings.map(({ kind, path }) => ({ kind, path }));
  throw error;
}

export function redactUnsafeSession(session) {
  const redactions = [];
  let title = session.title;
  const titleFindings = scanTextForSecrets(title);
  if (titleFindings.length) {
    redactions.push({ field: "title", kinds: [...new Set(titleFindings.map((finding) => finding.kind))] });
    title = "标题因包含疑似敏感凭据而未同步";
  }

  const messages = session.messages.map((message, index) => {
    const findings = scanTextForSecrets(message.text);
    if (!findings.length) return message;
    redactions.push({
      field: "message",
      messageNumber: index + 1,
      role: message.role,
      phase: message.phase,
      kinds: [...new Set(findings.map((finding) => finding.kind))]
    });
    return {
      ...message,
      text: "此消息因包含疑似敏感凭据而未同步。请在原始 Codex 对话中查看。"
    };
  });

  return { session: { ...session, title, messages }, redactions };
}
