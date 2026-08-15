import fs from "node:fs";
import path from "node:path";

export function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function resetDirectory(directory, allowedParent) {
  const resolvedDirectory = path.resolve(directory);
  const resolvedParent = path.resolve(allowedParent);
  const relative = path.relative(resolvedParent, resolvedDirectory);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to reset analysis directory outside ${resolvedParent}: ${resolvedDirectory}`);
  }
  fs.rmSync(resolvedDirectory, { recursive: true, force: true });
  ensureDirectory(resolvedDirectory);
}

export function walkFiles(directory) {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(fullPath) : [fullPath];
  });
}

export function writeJson(file, value) {
  ensureDirectory(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readJsonIfExists(file) {
  return fs.existsSync(file) ? readJson(file) : null;
}

export function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

export function toRepoPath(rootDir, value) {
  return toPosixPath(path.relative(rootDir, value));
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) {
    return "n/a";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function percentChange(current, baseline) {
  if (!baseline) {
    return current ? Number.POSITIVE_INFINITY : 0;
  }
  return ((current - baseline) / baseline) * 100;
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
