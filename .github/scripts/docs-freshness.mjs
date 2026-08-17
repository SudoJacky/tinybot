#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT_DOCUMENTS = new Set(["README.md", "README_ZH.md", "CONTRIBUTING.md"]);
const ARCHITECTURE_PREFIX = "docs/architecture/";
const EXCLUDED_PREFIXES = ["docs/archive/", "docs/local/"];
const WATCH_MARKER_PATTERN = /^<!-- tinybot-doc-watch:\r?\n([\s\S]*?)\r?\n-->$/m;
const FINGERPRINT_NAME = "tinybot-doc-fingerprint";
const VALID_FINGERPRINT_PATTERN = new RegExp(
  `^<!-- ${FINGERPRINT_NAME}: sha256:([a-f0-9]{64}) -->$`,
  "m",
);
const ANY_FINGERPRINT_PATTERN = new RegExp(
  `^[\\t ]*<!--[\\t ]*${FINGERPRINT_NAME}:.*?-->[\\t ]*$`,
  "m",
);
const MODULE_FINGERPRINT_PATTERN =
  /^[\t ]*<!--[\t ]*tinybot-module-fingerprint:.*?-->[\t ]*\r?\n?/gm;

function fail(message) {
  throw new Error(message);
}

function runGit(arguments_, cwd, input) {
  const result = spawnSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    input,
  });
  if (result.error) {
    fail(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(result.stderr.trim() || `git ${arguments_.join(" ")} failed`);
  }
  return result.stdout;
}

function runGitBuffer(arguments_, cwd, input) {
  const result = spawnSync("git", arguments_, {
    cwd,
    input,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(result.stderr.toString("utf8").trim() || `git ${arguments_.join(" ")} failed`);
  }
  return result.stdout;
}

function repositoryRoot() {
  return resolve(runGit(["rev-parse", "--show-toplevel"], process.cwd()).trim());
}

function splitNullTerminated(value) {
  return value.split("\0").filter(Boolean);
}

function normalizePath(path) {
  return path.replaceAll("\\", "/");
}

function indexEntries(root) {
  const entries = new Map();
  for (const record of splitNullTerminated(runGit(["ls-files", "--stage", "-z"], root))) {
    const separator = record.indexOf("\t");
    if (separator === -1) {
      fail(`could not parse staged file record: ${record}`);
    }
    const [mode, hash, stage] = record.slice(0, separator).split(" ");
    const file = normalizePath(record.slice(separator + 1));
    if (!mode || !hash || stage !== "0") {
      fail(`unmerged or invalid staged file: ${file}`);
    }
    entries.set(file, hash);
  }
  return entries;
}

function workingFiles(root) {
  return splitNullTerminated(
    runGit(["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root),
  ).map(normalizePath);
}

function isFormalDocument(file) {
  if (ROOT_DOCUMENTS.has(file)) {
    return true;
  }
  return (
    file.startsWith("docs/") &&
    file.endsWith(".md") &&
    !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

function formalDocuments(files) {
  return [...new Set(files.filter(isFormalDocument))].sort();
}

function architectureDocuments(files) {
  return files.filter(
    (file) => file.startsWith(ARCHITECTURE_PREFIX) && file.endsWith(".md"),
  );
}

function readWorkingFile(root, file) {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) {
    fail(`document or watched source is missing: ${file}`);
  }
  return readFileSync(absolute, "utf8");
}

function readIndexContents(root, files, entries) {
  const hashes = [...new Set(files.map((file) => {
    const hash = entries.get(file);
    if (!hash) {
      fail(`staged document or watched source is missing: ${file}`);
    }
    return hash;
  }))];
  if (hashes.length === 0) {
    return new Map();
  }
  const output = runGitBuffer(
    ["cat-file", "--batch"],
    root,
    Buffer.from(`${hashes.join("\n")}\n`, "utf8"),
  );
  const byHash = new Map();
  let offset = 0;
  for (const requestedHash of hashes) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd === -1) {
      fail(`git cat-file returned a truncated header for ${requestedHash}`);
    }
    const header = output.subarray(offset, headerEnd).toString("utf8");
    const [actualHash, type, sizeText] = header.split(" ");
    const size = Number.parseInt(sizeText, 10);
    if (actualHash !== requestedHash || type !== "blob" || !Number.isSafeInteger(size)) {
      fail(`git cat-file returned an invalid blob header: ${header}`);
    }
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd > output.length) {
      fail(`git cat-file returned truncated content for ${requestedHash}`);
    }
    byHash.set(requestedHash, output.subarray(contentStart, contentEnd).toString("utf8"));
    offset = contentEnd + 1;
  }
  return new Map(files.map((file) => [file, byHash.get(entries.get(file))]));
}

function normalizeRepositoryTarget(root, target, label) {
  const absolute = resolve(root, target);
  const repositoryRelative = normalizePath(relative(root, absolute));
  if (
    repositoryRelative === ".." ||
    repositoryRelative.startsWith("../") ||
    repositoryRelative === ""
  ) {
    fail(`${label} is outside the repository: ${target}`);
  }
  return repositoryRelative;
}

function watchedSources(root, document, contents, indexFileSet) {
  const match = contents.match(WATCH_MARKER_PATTERN);
  if (!match) {
    return { kind: "missing", sources: [] };
  }
  const sources = match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((source) => normalizeRepositoryTarget(root, source, `watch source in ${document}`));
  if (sources.length === 0) {
    fail(`architecture document has an empty watch list: ${document}`);
  }
  const unique = new Set(sources);
  if (unique.size !== sources.length) {
    fail(`architecture document has duplicate watch sources: ${document}`);
  }
  for (const source of sources) {
    if (source.startsWith("docs/local/") || source.startsWith("openspec/")) {
      fail(`architecture document watches excluded content: ${document} -> ${source}`);
    }
    if (!indexFileSet.has(source)) {
      fail(`architecture document watches an untracked or missing file: ${document} -> ${source}`);
    }
  }
  return { kind: "valid", sources: [...unique].sort() };
}

function mapReader(contents) {
  return (file) => {
    if (!contents.has(file)) {
      fail(`staged document or watched source was not loaded: ${file}`);
    }
    return contents.get(file);
  };
}

function stagedCheckReader(root, documents, entries) {
  const indexFileSet = new Set(entries.keys());
  const contents = readIndexContents(root, documents, entries);
  const watched = new Set();
  for (const document of architectureDocuments(documents)) {
    try {
      const watch = watchedSources(root, document, contents.get(document), indexFileSet);
      if (watch.kind === "valid") {
        watch.sources.forEach((source) => watched.add(source));
      }
    } catch {
      // checkFreshness reports the precise validation failure.
    }
  }
  for (const [file, content] of readIndexContents(root, [...watched], entries)) {
    contents.set(file, content);
  }
  return mapReader(contents);
}

function stagedReviewReader(root, documents, entries) {
  const indexFileSet = new Set(entries.keys());
  const watched = new Set();
  for (const document of documents) {
    const watch = watchedSources(
      root,
      document,
      readWorkingFile(root, document),
      indexFileSet,
    );
    if (watch.kind !== "valid") {
      fail(`architecture document has no watch marker: ${document}`);
    }
    watch.sources.forEach((source) => watched.add(source));
  }
  return mapReader(readIndexContents(root, [...watched], entries));
}

function normalizedWatchedContent(contents) {
  return contents
    .replace(MODULE_FINGERPRINT_PATTERN, "")
    .replace(ANY_FINGERPRINT_PATTERN, "")
    .replaceAll("\r\n", "\n");
}

function fingerprint(sources, readFile) {
  const hash = createHash("sha256");
  hash.update("tinybot-doc-fingerprint-v1\0");
  for (const source of sources) {
    hash.update(`${source}\0`);
    hash.update(normalizedWatchedContent(readFile(source)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function recordedFingerprint(contents) {
  const match = contents.match(VALID_FINGERPRINT_PATTERN);
  if (match) {
    return { kind: "valid", fingerprint: match[1] };
  }
  return contents.includes(FINGERPRINT_NAME) ? { kind: "invalid" } : { kind: "missing" };
}

function withFingerprint(contents, value) {
  const marker = `<!-- ${FINGERPRINT_NAME}: sha256:${value} -->`;
  if (ANY_FINGERPRINT_PATTERN.test(contents)) {
    return contents.replace(ANY_FINGERPRINT_PATTERN, marker);
  }
  const watch = contents.match(WATCH_MARKER_PATTERN);
  if (!watch) {
    fail("cannot add a documentation fingerprint without a watch marker");
  }
  return contents.replace(watch[0], `${watch[0]}\n${marker}`);
}

function contentOutsideFences(contents) {
  const visible = [];
  let fence = null;
  for (const line of contents.split(/\r?\n/)) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      const kind = fenceMatch[1][0];
      if (fence === null) {
        fence = kind;
      } else if (fence === kind) {
        fence = null;
      }
      continue;
    }
    if (fence === null) {
      visible.push(line);
    }
  }
  return visible.join("\n");
}

function localLinkTargets(contents) {
  const visible = contentOutsideFences(contents);
  const targets = [];
  const pattern = /!?\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^)]*)?\)/g;
  for (const match of visible.matchAll(pattern)) {
    const raw = match[1].startsWith("<") ? match[1].slice(1, -1) : match[1];
    if (raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      continue;
    }
    targets.push(raw);
  }
  return targets;
}

function repositoryLinkTarget(root, document, target) {
  const withoutFragment = target.split("#", 1)[0].split("?", 1)[0];
  if (!withoutFragment) {
    return null;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    fail(`document contains an invalid encoded link: ${document} -> ${target}`);
  }
  return normalizeRepositoryTarget(
    root,
    resolve(root, dirname(document), decoded),
    `local link in ${document}`,
  );
}

function pathExists(file, availableFiles) {
  return availableFiles.has(file) || [...availableFiles].some((entry) => entry.startsWith(`${file}/`));
}

function validateDocuments(root, documents, availableFiles, readFile) {
  const errors = [];
  for (const document of documents) {
    const contents = readFile(document);
    const visible = contentOutsideFences(contents);
    const h1Count = visible.split("\n").filter((line) => /^# [^#]/.test(line)).length;
    if (h1Count !== 1) {
      errors.push(`${document}: expected exactly one H1, found ${h1Count}`);
    }
    for (const target of localLinkTargets(contents)) {
      let resolved;
      try {
        resolved = repositoryLinkTarget(root, document, target);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!resolved) {
        continue;
      }
      if (resolved.startsWith("docs/local/")) {
        errors.push(`${document}: formal documentation must not link local scratch content: ${target}`);
      } else if (!pathExists(resolved, availableFiles)) {
        errors.push(`${document}: broken local link: ${target}`);
      }
    }
  }
  for (const error of errors) {
    console.log(`INVALID     ${error}`);
  }
  console.log(`Documentation structure: ${documents.length} checked, ${errors.length} invalid`);
  return errors.length === 0;
}

function changedWatchedSources(root, document, sources, staged) {
  const baseline = runGit(["log", "-1", "--format=%H", "--", document], root).trim();
  if (!baseline) {
    return sources;
  }
  const arguments_ = staged
    ? ["diff", "--cached", "--name-only", "-z", baseline, "--", ...sources]
    : ["diff", "--name-only", "-z", baseline, "--", ...sources];
  return splitNullTerminated(runGit(arguments_, root)).map(normalizePath);
}

function checkFreshness(root, documents, indexFileSet, readFile, staged) {
  let current = 0;
  let needsReview = 0;
  for (const document of documents) {
    const contents = readFile(document);
    let watch;
    try {
      watch = watchedSources(root, document, contents, indexFileSet);
    } catch (error) {
      console.log(`INVALID     ${document}`);
      console.log(`            ${error instanceof Error ? error.message : String(error)}`);
      needsReview += 1;
      continue;
    }
    if (watch.kind === "missing") {
      console.log(`UNTRACKED   ${document}`);
      console.log("            add a tinybot-doc-watch marker");
      needsReview += 1;
      continue;
    }
    const recorded = recordedFingerprint(contents);
    const actual = fingerprint(watch.sources, readFile);
    if (recorded.kind === "missing") {
      console.log(`UNREVIEWED  ${document}`);
      console.log(
        `            run: node .github/scripts/docs-freshness.mjs review${staged ? " --staged" : ""} ${document}`,
      );
      needsReview += 1;
      continue;
    }
    if (recorded.kind === "invalid") {
      console.log(`INVALID     ${document}`);
      console.log("            fingerprint marker is malformed");
      needsReview += 1;
      continue;
    }
    if (recorded.fingerprint !== actual) {
      console.log(`STALE       ${document}`);
      const changed = changedWatchedSources(root, document, watch.sources, staged);
      for (const source of changed) {
        console.log(`            changed: ${source}`);
      }
      if (changed.length === 0) {
        console.log("            watched content no longer matches the reviewed fingerprint");
      }
      needsReview += 1;
      continue;
    }
    console.log(`CURRENT     ${document}`);
    current += 1;
  }
  console.log(`Architecture freshness: ${current} current, ${needsReview} requiring review`);
  return needsReview === 0;
}

function selectedArchitectureDocuments(root, targets, documents) {
  if (targets.length === 0 || (targets.length === 1 && targets[0] === "--all")) {
    return documents;
  }
  if (targets.includes("--all")) {
    fail("--all cannot be combined with document targets");
  }
  return [...new Set(targets.map((target) => {
    const document = normalizeRepositoryTarget(root, target, "architecture document target");
    if (!documents.includes(document)) {
      fail(`no architecture document found for: ${target}`);
    }
    return document;
  }))];
}

function review(root, selected, indexFileSet, readSource) {
  for (const document of selected) {
    const contents = readWorkingFile(root, document);
    const watch = watchedSources(root, document, contents, indexFileSet);
    if (watch.kind !== "valid") {
      fail(`architecture document has no watch marker: ${document}`);
    }
    const value = fingerprint(watch.sources, readSource);
    writeFileSync(resolve(root, document), withFingerprint(contents, value), "utf8");
    console.log(`REVIEWED    ${document}`);
  }
  console.log(`Updated ${selected.length} architecture document fingerprint${selected.length === 1 ? "" : "s"}.`);
}

function usage() {
  console.log(`Usage:
  node .github/scripts/docs-freshness.mjs check [--staged]
  node .github/scripts/docs-freshness.mjs review [--staged] <document ... | --all>

The check command validates formal documentation outside docs/archive and
docs/local, then verifies every docs/architecture fingerprint. Review updates
fingerprints after a human has read the document and its declared watch
sources. Neither command reads openspec or docs/local content.`);
}

function main() {
  const [command, ...arguments_] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const root = repositoryRoot();
  const staged = arguments_.includes("--staged");
  if (arguments_.filter((argument) => argument === "--staged").length > 1) {
    fail("--staged may be provided only once");
  }
  const targets = arguments_.filter((argument) => argument !== "--staged");
  const entries = indexEntries(root);
  const indexed = [...entries.keys()];
  const indexFileSet = new Set(indexed);

  if (command === "check") {
    if (targets.length !== 0) {
      fail("check accepts only the optional --staged flag");
    }
    const files = staged ? indexed : workingFiles(root);
    const documents = formalDocuments(files);
    const readFile = staged
      ? stagedCheckReader(root, documents, entries)
      : (file) => readWorkingFile(root, file);
    const structureCurrent = validateDocuments(root, documents, new Set(files), readFile);
    const freshnessCurrent = checkFreshness(
      root,
      architectureDocuments(documents),
      indexFileSet,
      readFile,
      staged,
    );
    if (!structureCurrent || !freshnessCurrent) {
      process.exitCode = 1;
    }
    return;
  }

  if (command === "review") {
    const workingDocuments = architectureDocuments(formalDocuments(workingFiles(root)));
    const selected = selectedArchitectureDocuments(root, targets, workingDocuments);
    if (selected.length === 0) {
      fail("no architecture documents found to review");
    }
    const readSource = staged
      ? stagedReviewReader(root, selected, entries)
      : (file) => readWorkingFile(root, file);
    review(root, selected, indexFileSet, readSource);
    return;
  }

  fail(`unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`documentation freshness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
