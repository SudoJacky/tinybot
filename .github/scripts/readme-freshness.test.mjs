import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./readme-freshness.mjs", import.meta.url));
const docsScriptPath = fileURLToPath(new URL("./docs-freshness.mjs", import.meta.url));
const hookPath = fileURLToPath(new URL("../../.githooks/pre-commit", import.meta.url));

function run(command, arguments_, cwd) {
  return spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
  });
}

function git(repository, ...arguments_) {
  const result = run("git", arguments_, repository);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(repository, path, contents) {
  const absolutePath = join(repository, ...path.split("/"));
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents, "utf8");
}

function fixture(t) {
  const repository = mkdtempSync(join(tmpdir(), "tinybot-readme-freshness-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  git(repository, "init");
  git(repository, "config", "user.name", "Tinybot Tests");
  git(repository, "config", "user.email", "tinybot@example.com");
  write(repository, "src-tauri/README.md", "# Desktop backend\n\nBackend overview.\n");
  write(repository, "src-tauri/Cargo.toml", "[package]\nname = \"fixture\"\n");
  write(repository, "src-tauri/src/agent/README.md", "# Agent\n\nAgent overview.\n");
  write(repository, "src-tauri/src/agent/mod.rs", "pub mod runtime;\n");
  write(repository, "src-tauri/src/agent/runtime/README.md", "# Runtime\n\nRuntime overview.\n");
  write(repository, "src-tauri/src/agent/runtime/loop.rs", "pub fn run() {}\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "test: create fixture");
  return repository;
}

function readmeTool(repository, ...arguments_) {
  return run(process.execPath, [scriptPath, ...arguments_], repository);
}

test("review records the current module fingerprint and check detects later changes", (t) => {
  const repository = fixture(t);
  const module = "src-tauri/src/agent/runtime";

  const beforeReview = readmeTool(repository, "check", module);
  assert.equal(beforeReview.status, 1);
  assert.match(beforeReview.stdout, /UNREVIEWED\s+src-tauri\/src\/agent\/runtime\/README\.md/);

  const reviewed = readmeTool(repository, "review", module);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(reviewed.stdout, /REVIEWED\s+src-tauri\/src\/agent\/runtime\/README\.md/);
  assert.match(
    readFileSync(join(repository, "src-tauri/src/agent/runtime/README.md"), "utf8"),
    /^<!-- tinybot-module-fingerprint: sha256:[a-f0-9]{64} -->$/m,
  );

  const current = readmeTool(repository, "check", module);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout, /CURRENT\s+src-tauri\/src\/agent\/runtime\/README\.md/);

  git(repository, "config", "core.autocrlf", "true");
  write(repository, "src-tauri/src/agent/runtime/loop.rs", "pub fn run() {}\r\n");
  const differentCheckoutNewlines = readmeTool(repository, "check", module);
  assert.equal(
    differentCheckoutNewlines.status,
    0,
    differentCheckoutNewlines.stdout + differentCheckoutNewlines.stderr,
  );

  write(repository, "src-tauri/src/agent/runtime/loop.rs", "pub fn run() { println!(\"changed\"); }\r\n");
  const stale = readmeTool(repository, "check", module);
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /STALE\s+src-tauri\/src\/agent\/runtime\/README\.md/);
  assert.match(stale.stdout, /changed: src-tauri\/src\/agent\/runtime\/loop\.rs/);
});

test("a file belongs only to its nearest ancestor README", (t) => {
  const repository = fixture(t);
  const parent = "src-tauri/src/agent";
  const child = "src-tauri/src/agent/runtime";

  assert.equal(readmeTool(repository, "review", parent, child).status, 0);
  write(repository, "src-tauri/src/agent/runtime/loop.rs", "pub fn run() { println!(\"child\"); }\n");

  const parentAfterChildChange = readmeTool(repository, "check", parent);
  assert.equal(parentAfterChildChange.status, 0, parentAfterChildChange.stdout);
  assert.match(parentAfterChildChange.stdout, /CURRENT\s+src-tauri\/src\/agent\/README\.md/);
  assert.equal(readmeTool(repository, "check", child).status, 1);

  write(repository, "src-tauri/src/agent/mod.rs", "pub mod runtime;\npub mod provider;\n");
  const parentAfterOwnChange = readmeTool(repository, "check", parent);
  assert.equal(parentAfterOwnChange.status, 1);
  assert.match(parentAfterOwnChange.stdout, /changed: src-tauri\/src\/agent\/mod\.rs/);
});

test("staged checks enforce only affected modules and ignore unstaged content", (t) => {
  const repository = fixture(t);
  const module = "src-tauri/src/agent/runtime";
  const source = "src-tauri/src/agent/runtime/loop.rs";
  const readme = "src-tauri/src/agent/runtime/README.md";

  write(repository, source, "pub fn run() { println!(\"staged\"); }\n");
  git(repository, "add", source);

  const unreviewed = readmeTool(repository, "check", "--staged");
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stdout, /UNREVIEWED\s+src-tauri\/src\/agent\/runtime\/README\.md/);
  assert.doesNotMatch(unreviewed.stdout, /UNREVIEWED\s+src-tauri\/src\/agent\/README\.md/);

  assert.equal(readmeTool(repository, "review", module).status, 0);
  git(repository, "add", readme);
  const reviewed = readmeTool(repository, "check", "--staged");
  assert.equal(reviewed.status, 0, reviewed.stdout + reviewed.stderr);

  write(repository, source, "pub fn run() { println!(\"unstaged\"); }\n");
  const ignoresUnstaged = readmeTool(repository, "check", "--staged");
  assert.equal(ignoresUnstaged.status, 0, ignoresUnstaged.stdout + ignoresUnstaged.stderr);
});

test("staged review fingerprints the index instead of unrelated working-tree content", (t) => {
  const repository = fixture(t);
  const module = "src-tauri/src/agent/runtime";
  const source = "src-tauri/src/agent/runtime/loop.rs";
  const readme = "src-tauri/src/agent/runtime/README.md";

  write(repository, source, "pub fn run() { println!(\"staged\"); }\n");
  git(repository, "add", source);
  write(repository, source, "pub fn run() { println!(\"unstaged\"); }\n");

  const reviewed = readmeTool(repository, "review", "--staged", module);
  assert.equal(reviewed.status, 0, reviewed.stderr);
  git(repository, "add", readme);

  const stagedCheck = readmeTool(repository, "check", "--staged");
  assert.equal(stagedCheck.status, 0, stagedCheck.stdout + stagedCheck.stderr);

  const workingTreeCheck = readmeTool(repository, "check", module);
  assert.equal(workingTreeCheck.status, 1);
  assert.match(workingTreeCheck.stdout, /STALE\s+src-tauri\/src\/agent\/runtime\/README\.md/);
});

test("the tracked pre-commit hook blocks an unreviewed staged module", (t) => {
  const repository = fixture(t);
  const repositoryScript = join(repository, ".github/scripts/readme-freshness.mjs");
  const repositoryDocsScript = join(repository, ".github/scripts/docs-freshness.mjs");
  const repositoryHook = join(repository, ".githooks/pre-commit");
  mkdirSync(dirname(repositoryScript), { recursive: true });
  mkdirSync(dirname(repositoryHook), { recursive: true });
  copyFileSync(scriptPath, repositoryScript);
  copyFileSync(docsScriptPath, repositoryDocsScript);
  copyFileSync(hookPath, repositoryHook);
  chmodSync(repositoryHook, 0o755);
  git(repository, "config", "core.hooksPath", ".githooks");

  const note = "src-tauri/src/agent/runtime/notes.txt";
  write(repository, note, "A staged module change.\n");
  git(repository, "add", note);

  const rejected = run("git", ["commit", "-m", "test: unreviewed module"], repository);
  assert.equal(rejected.status, 1);
  assert.match(
    rejected.stdout + rejected.stderr,
    /UNREVIEWED\s+src-tauri\/src\/agent\/runtime\/README\.md/,
  );

  assert.equal(readmeTool(repository, "review", "src-tauri/src/agent/runtime").status, 0);
  git(repository, "add", "src-tauri/src/agent/runtime/README.md");
  const accepted = run("git", ["commit", "-m", "test: reviewed module"], repository);
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
});

test("review fails when a module README owns no tracked files", (t) => {
  const repository = fixture(t);
  write(repository, "src/empty/README.md", "# Empty module\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "test: add empty module");

  const reviewed = readmeTool(repository, "review", "src/empty");
  assert.equal(reviewed.status, 1);
  assert.match(reviewed.stderr, /module README owns no tracked files: src\/empty\/README\.md/);
});
