#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const MODULE_ROOTS = ["src", "src-tauri"];
const MARKER_NAME = "tinybot-module-fingerprint";
const VALID_MARKER_PATTERN = new RegExp(
  `^<!-- ${MARKER_NAME}: sha256:([a-f0-9]{64}) -->$`,
  "m",
);
const ANY_MARKER_PATTERN = new RegExp(
  `^[\\t ]*<!--[\\t ]*${MARKER_NAME}:.*?-->[\\t ]*$`,
  "m",
);

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

function repositoryRoot() {
  return resolve(runGit(["rev-parse", "--show-toplevel"], process.cwd()).trim());
}

function splitNullTerminated(value) {
  return value.split("\0").filter(Boolean);
}

function trackedFiles(root) {
  return splitNullTerminated(
    runGit(["ls-files", "--cached", "-z", "--", ...MODULE_ROOTS], root),
  ).sort();
}

function workingTreeHashes(root, files) {
  const present = files.filter((file) => existsSync(resolve(root, file)));
  if (present.some((file) => file.includes("\n"))) {
    fail("tracked file names containing newlines are not supported");
  }
  const output = present.length
    ? runGit(["hash-object", "--stdin-paths"], root, `${present.join("\n")}\n`).trim().split(/\r?\n/)
    : [];
  if (output.length !== present.length) {
    fail(`git hashed ${output.length} files, expected ${present.length}`);
  }
  const hashes = new Map(present.map((file, index) => [file, output[index]]));
  for (const file of files) {
    if (!hashes.has(file)) {
      hashes.set(file, "missing");
    }
  }
  return hashes;
}

function indexHashes(root, files) {
  const records = splitNullTerminated(
    runGit(["ls-files", "--stage", "-z", "--", ...MODULE_ROOTS], root),
  );
  const hashes = new Map();
  for (const record of records) {
    const separator = record.indexOf("\t");
    if (separator === -1) {
      fail(`could not parse staged file record: ${record}`);
    }
    const [mode, hash, stage] = record.slice(0, separator).split(" ");
    const file = record.slice(separator + 1);
    if (!mode || !hash || stage !== "0") {
      fail(`unmerged or invalid staged file: ${file}`);
    }
    hashes.set(file, hash);
  }
  for (const file of files) {
    if (!hashes.has(file)) {
      fail(`missing staged content hash for: ${file}`);
    }
  }
  return hashes;
}

function isReadme(file) {
  return file === "README.md" || file.endsWith("/README.md");
}

function moduleReadmes(files) {
  return files.filter(
    (file) =>
      isReadme(file) && MODULE_ROOTS.some((root) => file === `${root}/README.md` || file.startsWith(`${root}/`)),
  );
}

function moduleDirectory(readme) {
  return dirname(readme).replaceAll("\\", "/");
}

function isInside(file, directory) {
  return file === directory || file.startsWith(`${directory}/`);
}

function ownerOf(file, readmes) {
  let owner = null;
  let ownerLength = -1;
  for (const readme of readmes) {
    const directory = moduleDirectory(readme);
    if (isInside(file, directory) && directory.length > ownerLength) {
      owner = readme;
      ownerLength = directory.length;
    }
  }
  return owner;
}

function ownedFiles(readme, files, readmes) {
  return files.filter((file) => !isReadme(file) && ownerOf(file, readmes) === readme);
}

function fingerprint(readme, files, readmes, hashes) {
  const owned = ownedFiles(readme, files, readmes);
  if (owned.length === 0) {
    fail(`module README owns no tracked files: ${readme}`);
  }
  const hash = createHash("sha256");
  hash.update("tinybot-readme-fingerprint-v1\0");
  for (const file of owned) {
    hash.update(`${file}\0`);
    hash.update(`${hashes.get(file)}\0`);
  }
  return hash.digest("hex");
}

function markerFrom(contents) {
  const match = contents.match(VALID_MARKER_PATTERN);
  if (match) {
    return { kind: "valid", fingerprint: match[1] };
  }
  if (contents.includes(MARKER_NAME)) {
    return { kind: "invalid" };
  }
  return { kind: "missing" };
}

function withMarker(contents, value) {
  const marker = `<!-- ${MARKER_NAME}: sha256:${value} -->`;
  if (ANY_MARKER_PATTERN.test(contents)) {
    return contents.replace(ANY_MARKER_PATTERN, marker);
  }

  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const lines = contents.split(/\r?\n/);
  if (lines[0]?.startsWith("# ")) {
    lines.splice(1, 0, marker);
  } else {
    lines.unshift(marker, "");
  }
  return lines.join(newline);
}

function normalizeTarget(root, target, readmes) {
  const absolute = resolve(root, target);
  const repositoryRelative = relative(root, absolute).replaceAll("\\", "/");
  if (repositoryRelative === ".." || repositoryRelative.startsWith("../")) {
    fail(`module target is outside the repository: ${target}`);
  }
  const candidate = isReadme(repositoryRelative)
    ? repositoryRelative
    : `${repositoryRelative.replace(/\/$/, "")}/README.md`;
  if (!readmes.includes(candidate)) {
    fail(`no tracked module README found for: ${target}`);
  }
  return candidate;
}

function selectedReadmes(root, targets, readmes) {
  if (targets.length === 0 || (targets.length === 1 && targets[0] === "--all")) {
    return readmes;
  }
  if (targets.includes("--all")) {
    fail("--all cannot be combined with module targets");
  }
  return [...new Set(targets.map((target) => normalizeTarget(root, target, readmes)))];
}

function stagedChanges(root) {
  return splitNullTerminated(
    runGit(["diff", "--cached", "--name-only", "--diff-filter=ACMRD", "-z"], root),
  );
}

function affectedReadmes(changed, readmes) {
  const affected = new Set();
  for (const file of changed) {
    if (readmes.includes(file)) {
      affected.add(file);
      continue;
    }
    const owner = ownerOf(file, readmes);
    if (owner) {
      affected.add(owner);
    }
  }
  return [...affected].sort();
}

function changedFilesSinceReadme(root, readme, readmes) {
  const baseline = runGit(["log", "-1", "--format=%H", "--", readme], root).trim();
  if (!baseline) {
    return [];
  }
  const changed = splitNullTerminated(
    runGit(["diff", "--name-only", "-z", baseline, "--", moduleDirectory(readme)], root),
  );
  return changed.filter((file) => !isReadme(file) && ownerOf(file, readmes) === readme);
}

function check(root, selected, files, readmes, hashes, options = {}) {
  let current = 0;
  let needsReview = 0;

  for (const readme of selected) {
    const absoluteReadme = resolve(root, readme);
    if (!options.staged && !existsSync(absoluteReadme)) {
      console.log(`DELETED     ${readme}`);
      needsReview += 1;
      continue;
    }

    const contents = options.staged
      ? runGit(["show", `:${readme}`], root)
      : readFileSync(absoluteReadme, "utf8");
    const recorded = markerFrom(contents);
    const actual = fingerprint(readme, files, readmes, hashes);
    if (recorded.kind === "missing") {
      console.log(`UNREVIEWED  ${readme}`);
      console.log(
        `            run: node .github/scripts/readme-freshness.mjs review${options.staged ? " --staged" : ""} ${moduleDirectory(readme)}`,
      );
      if (options.staged) {
        console.log(`            then stage: ${readme}`);
      }
      needsReview += 1;
      continue;
    }
    if (recorded.kind === "invalid") {
      console.log(`INVALID     ${readme}`);
      console.log(`            fingerprint marker is malformed`);
      needsReview += 1;
      continue;
    }
    if (recorded.fingerprint !== actual) {
      console.log(`STALE       ${readme}`);
      const changed = options.staged
        ? options.changed.filter((file) => !isReadme(file) && ownerOf(file, readmes) === readme)
        : changedFilesSinceReadme(root, readme, readmes);
      for (const file of changed) {
        console.log(`            changed: ${file}`);
      }
      if (changed.length === 0) {
        console.log("            module content no longer matches the reviewed fingerprint");
      }
      needsReview += 1;
      continue;
    }

    console.log(`CURRENT     ${readme}`);
    current += 1;
  }

  console.log(`README freshness: ${current} current, ${needsReview} requiring review`);
  return needsReview === 0;
}

function review(root, selected, files, readmes, hashes) {
  for (const readme of selected) {
    const absoluteReadme = resolve(root, readme);
    if (!existsSync(absoluteReadme)) {
      fail(`cannot review a missing README: ${readme}`);
    }
    const contents = readFileSync(absoluteReadme, "utf8");
    const actual = fingerprint(readme, files, readmes, hashes);
    const updated = withMarker(contents, actual);
    writeFileSync(absoluteReadme, updated, "utf8");
    console.log(`REVIEWED    ${readme}`);
  }
  console.log(`Updated ${selected.length} README fingerprint${selected.length === 1 ? "" : "s"}.`);
}

function usage() {
  console.log(`Usage:
  node .github/scripts/readme-freshness.mjs check [module ...]
  node .github/scripts/readme-freshness.mjs check --staged
  node .github/scripts/readme-freshness.mjs review <module ... | --all>
  node .github/scripts/readme-freshness.mjs review --staged <module ... | --all>

Modules are tracked README.md files below src/ and src-tauri/. A source file
belongs to its nearest ancestor README. The check command never writes files;
review records the current module fingerprint after the README has been read.
Use review --staged after staging module changes so unrelated working-tree
content cannot enter the fingerprint, then stage the updated README.`);
}

function main() {
  const [command, ...targets] = process.argv.slice(2);
  if (command === "--help" || command === "-h" || !command) {
    usage();
    return;
  }

  const root = repositoryRoot();
  const files = trackedFiles(root);
  const readmes = moduleReadmes(files);
  if (readmes.length === 0) {
    fail(`no tracked module READMEs found below ${MODULE_ROOTS.join(" or ")}`);
  }

  if (command === "check") {
    if (targets.includes("--staged")) {
      if (targets.length !== 1) {
        fail("--staged cannot be combined with module targets");
      }
      const changed = stagedChanges(root);
      const selected = affectedReadmes(changed, readmes);
      if (selected.length === 0) {
        console.log("README freshness: no staged module changes");
        return;
      }
      const hashes = indexHashes(root, files);
      if (!check(root, selected, files, readmes, hashes, { staged: true, changed })) {
        process.exitCode = 1;
      }
      return;
    }
    const selected = selectedReadmes(root, targets, readmes);
    if (!check(root, selected, files, readmes, workingTreeHashes(root, files))) {
      process.exitCode = 1;
    }
    return;
  }
  if (command === "review") {
    const staged = targets.includes("--staged");
    if (targets.filter((target) => target === "--staged").length > 1) {
      fail("--staged may be provided only once");
    }
    const moduleTargets = targets.filter((target) => target !== "--staged");
    if (moduleTargets.length === 0) {
      fail("review requires at least one module target or --all");
    }
    review(
      root,
      selectedReadmes(root, moduleTargets, readmes),
      files,
      readmes,
      staged ? indexHashes(root, files) : workingTreeHashes(root, files),
    );
    return;
  }
  fail(`unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  console.error(`README freshness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
