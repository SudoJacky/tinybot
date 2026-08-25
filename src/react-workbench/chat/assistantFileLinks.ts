import type { ArtifactRef } from "../../app-core/chat/chatTurnContracts";

export type AssistantFileLink = {
  href: string;
};

export type ResolvedAssistantFileLink = {
  line?: number;
  path: string;
  title: string;
};

export type AssistantFileLinkErrorCode = "invalid_link" | "outside_workspace";

export class AssistantFileLinkError extends Error {
  readonly code: AssistantFileLinkErrorCode;

  constructor(code: AssistantFileLinkErrorCode, message: string) {
    super(message);
    this.name = "AssistantFileLinkError";
    this.code = code;
  }
}

const EXTERNAL_PROTOCOL = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i;

export function isAssistantFileHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("//")) {
    return false;
  }
  if (/^file:/i.test(value) || WINDOWS_ABSOLUTE_PATH.test(value)) {
    return true;
  }
  return !EXTERNAL_PROTOCOL.test(value);
}

export function resolveAssistantFileLink(href: string, workspaceRoot = ""): ResolvedAssistantFileLink {
  const decoded = decodeAssistantFileHref(href);
  const fragmentLine = lineFromFragment(decoded.fragment);
  const suffix = stripLineSuffix(decoded.path);
  const line = fragmentLine ?? suffix.line;
  const candidate = normalizeSlashes(suffix.path);
  const normalizedRoot = normalizeSlashes(workspaceRoot).replace(/\/+$/, "");
  let relativePath = candidate;

  if (isAbsolutePath(candidate)) {
    if (!normalizedRoot) {
      const title = candidate.split("/").pop() || candidate;
      return { ...(line ? { line } : {}), path: candidate, title };
    }
    const comparablePath = comparableWorkspacePath(candidate);
    const comparableRoot = comparableWorkspacePath(normalizedRoot);
    if (!comparablePath.startsWith(`${comparableRoot}/`)) {
      throw new AssistantFileLinkError("outside_workspace", "The file is outside the active workspace.");
    }
    relativePath = candidate.slice(normalizedRoot.length + 1);
  }

  const path = normalizeRelativePath(relativePath);
  const title = path.split("/").pop() || path;
  return { ...(line ? { line } : {}), path, title };
}

export function assistantFileLinkTitle(href: string): string {
  try {
    const decoded = decodeAssistantFileHref(href);
    const path = normalizeSlashes(stripLineSuffix(decoded.path).path).replace(/\/+$/, "");
    return path.split("/").pop() || "File";
  } catch {
    return "File";
  }
}

export function assistantFileArtifact(file: Pick<ResolvedAssistantFileLink, "path" | "title">): ArtifactRef {
  const mimeType = assistantFileMimeType(file.path);
  return {
    fetchPath: file.path,
    id: `workspace-file:${file.path}`,
    kind: mimeType === "text/markdown" ? "markdown" : mimeType === "application/json" ? "json" : "text",
    mimeType,
    status: "completed",
    title: file.title,
  };
}

function decodeAssistantFileHref(href: string): { fragment: string; path: string } {
  const value = href.trim();
  if (!isAssistantFileHref(value)) {
    throw new AssistantFileLinkError("invalid_link", "The link is not a local file link.");
  }
  if (/^file:/i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new AssistantFileLinkError("invalid_link", "The file URL is invalid.");
    }
    if (url.hostname && url.hostname !== "localhost") {
      throw new AssistantFileLinkError("outside_workspace", "Network file URLs are outside the active workspace.");
    }
    const decodedPath = decodePath(url.pathname);
    return {
      fragment: url.hash,
      path: /^\/[a-z]:\//i.test(decodedPath) ? decodedPath.slice(1) : decodedPath,
    };
  }

  const hashIndex = value.indexOf("#");
  const queryIndex = value.indexOf("?");
  const pathEnd = [hashIndex, queryIndex].filter((index) => index >= 0).reduce((minimum, index) => Math.min(minimum, index), value.length);
  return {
    fragment: hashIndex >= 0 ? value.slice(hashIndex) : "",
    path: decodePath(value.slice(0, pathEnd)),
  };
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AssistantFileLinkError("invalid_link", "The file link contains invalid URL encoding.");
  }
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsolutePath(value: string): boolean {
  return WINDOWS_ABSOLUTE_PATH.test(value) || value.startsWith("/");
}

function comparableWorkspacePath(value: string): string {
  const normalized = normalizeSlashes(value).replace(/\/+$/, "");
  return WINDOWS_ABSOLUTE_PATH.test(normalized) ? normalized.toLowerCase() : normalized;
}

function normalizeRelativePath(value: string): string {
  const segments = normalizeSlashes(value).split("/").filter((segment) => segment && segment !== ".");
  if (!segments.length) {
    throw new AssistantFileLinkError("invalid_link", "The file link does not identify a file.");
  }
  if (segments.includes("..")) {
    throw new AssistantFileLinkError("outside_workspace", "The file is outside the active workspace.");
  }
  return segments.join("/");
}

function lineFromFragment(fragment: string): number | undefined {
  const match = /^#L(\d+)(?:C\d+)?$/i.exec(fragment);
  if (!match) return undefined;
  const line = Number(match[1]);
  return Number.isSafeInteger(line) && line > 0 ? line : undefined;
}

function stripLineSuffix(value: string): { line?: number; path: string } {
  const match = /:(\d+)(?::\d+)?$/.exec(value);
  if (!match) return { path: value };
  const line = Number(match[1]);
  return {
    ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
    path: value.slice(0, match.index),
  };
}

function assistantFileMimeType(path: string): string {
  const extension = /(?:^|\/)\.?(?:[^./]+)(\.[^./]+)$/.exec(path.toLowerCase())?.[1] ?? "";
  switch (extension) {
    case ".md":
    case ".mdx": return "text/markdown";
    case ".json": return "application/json";
    case ".ts":
    case ".tsx": return "text/typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs": return "text/javascript";
    case ".css": return "text/css";
    case ".html":
    case ".htm": return "text/html";
    case ".xml": return "application/xml";
    case ".yaml":
    case ".yml": return "application/yaml";
    case ".toml": return "application/toml";
    case ".rs": return "text/x-rust";
    case ".py": return "text/x-python";
    case ".sh": return "text/x-shellscript";
    default: return "text/plain";
  }
}
