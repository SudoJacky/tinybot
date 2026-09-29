import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("PR version consistency and release tags use the same strict check", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "tinybot-version-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src-tauri"));
  writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "1.4.0" }));
  writeFileSync(join(cwd, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "1.4.0" }));
  writeFileSync(join(cwd, "src-tauri/Cargo.toml"), '[package]\nversion = "1.4.0"\n');
  const check = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("check-release-version.mjs", import.meta.url)), ...args], { cwd, encoding: "utf8" });
  assert.equal(check().status, 0);
  assert.equal(check("v1.4.0").status, 0);
  assert.notEqual(check("v1.5.0").status, 0);
  assert.notEqual(check("master").status, 0);
  writeFileSync(join(cwd, "src-tauri/Cargo.toml"), '[package]\nversion = "1.3.0"\n');
  const mismatch = check();
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /Cargo.toml is 1.3.0/);
});
