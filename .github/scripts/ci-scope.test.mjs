import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, classifyChanges, requireChecks } from "./ci-scope.mjs";

test("documentation and the separately built website do not compile the desktop", () => {
  assert.deepEqual(classifyChanges(["README.md", "README_ZH.md", "docs/api/rust.md", "website/package-lock.json", "src-tauri/src/teams/README.md"]), { frontend: false, windows: false });
});

test("runtime assets, embedded prompts, dependencies, and CI changes retain coverage", () => {
  for (const file of ["src/main.ts", "public/docs/index.html", "workers/parser.test.ts", "vite.config.ts", "tools/frontend-analysis/cli.mjs"]) {
    assert.deepEqual(classifyChanges([file]), { frontend: true, windows: false }, file);
  }
  for (const file of ["src-tauri/Cargo.lock", "src-tauri/src/teams/assignment_guidance.md", "src-tauri/tauri.conf.json", ".cargo/config.toml", "tools/ripgrep/prepare.mjs"]) {
    assert.deepEqual(classifyChanges([file]), { frontend: false, windows: true }, file);
  }
  for (const file of ["package-lock.json", "package.json", ".github/workflows/ci.yml", ".github/scripts/ci-scope.mjs", "new-build-tool/config.json"]) {
    assert.deepEqual(classifyChanges([file]), { frontend: true, windows: true }, file);
  }
});

test("a cross-scope rename and deletion are detected using the full push range", (t) => {
  const root = mkdtempSync(join(tmpdir(), "tinybot-ci-scope-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "--quiet"]);
  git(["config", "user.name", "CI Test"]);
  git(["config", "user.email", "ci@example.invalid"]);
  for (const directory of ["src", "src-tauri"]) mkdirSync(join(root, directory));
  writeFileSync(join(root, "src", "original.txt"), "same content\n");
  writeFileSync(join(root, "src-tauri", "deleted.rs"), "// deleted\n");
  git(["add", "."]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "initial"]);
  const base = git(["rev-parse", "HEAD"]).trim();
  git(["mv", "src/original.txt", "src-tauri/moved.txt"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "move"]);
  git(["rm", "src-tauri/deleted.rs"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "delete"]);
  const files = changedFiles({ before: base }, "push", git);
  assert.deepEqual(files.sort(), ["src-tauri/deleted.rs", "src-tauri/moved.txt", "src/original.txt"]);
  assert.deepEqual(classifyChanges(files), { frontend: true, windows: true });
  assert.deepEqual(changedFiles({ pull_request: { base: { sha: base } } }, "pull_request", git), files);
});

test("missing comparison data and git errors fail rather than skipping checks", () => {
  assert.throws(() => changedFiles({}, "push"), /comparison commit/);
  assert.throws(() => changedFiles({ before: "0".repeat(40) }, "push"), /comparison commit/);
  assert.throws(() => changedFiles({ before: "a".repeat(40) }, "push", () => { throw new Error("missing object"); }), /missing object/);
});

test("the aggregate gate allows only intentional skips and never masks failures", () => {
  const needs = {
    checks: { result: "success", outputs: { frontend: "true", windows: "false" } },
    frontend: { result: "success" }, windows: { result: "skipped" },
  };
  requireChecks(needs);
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.throws(() => requireChecks({ ...needs, frontend: { result } }), /frontend/);
  }
  for (const result of ["failure", "cancelled", undefined]) {
    assert.throws(() => requireChecks({ ...needs, windows: { result } }), /windows/);
  }
  assert.throws(() => requireChecks({ ...needs, checks: { ...needs.checks, result: "failure" } }), /preflight/);
  assert.throws(() => requireChecks({ ...needs, checks: { result: "success", outputs: {} } }), /Missing CI scope/);
});
