const SAFE_EXEC_PATTERNS = [
  /^\s*git\s+(status|diff|log|show|branch|rev-parse|ls-files)(?:\s+[\w./\\:@{}=,+~^*-]+)*\s*$/,
  /^\s*uv\s+run\s+(pytest|ruff|mypy)(?:\s+[\w./\\:@{}=,+~^*-]+)*\s*$/,
];

const SHELL_CONTROL_CHARS = new Set([";", "&", "|", "<", ">", "\n", "\r", "`"]);

export function normalizeCommand(command: string): string {
  return command.trim().split(/\s+/).filter(Boolean).join(" ");
}

export function hasShellControlOperator(command: string): boolean {
  let quote: string | undefined;
  let escaped = false;
  for (const char of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (SHELL_CONTROL_CHARS.has(char)) {
      return true;
    }
  }
  return false;
}

export function isLowRiskExec(command: string): boolean {
  const normalized = normalizeCommand(command).toLowerCase();
  if (hasShellControlOperator(normalized)) {
    return false;
  }
  return SAFE_EXEC_PATTERNS.some((pattern) => pattern.test(normalized));
}
