import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ROOT_DIR, TOOL_DIR } from "./config.mjs";

for (const failedStage of ["tooling-tests", "typecheck"]) {
  test(`CI stops after failed ${failedStage} and preserves its diagnostics`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tinybot-analysis-cli-"));
    const modules = path.join(root, "node_modules");
    t.after(() => {
      // Remove the junction itself before removing the fixture, never its target.
      if (fs.existsSync(modules)) fs.unlinkSync(modules);
      fs.rmSync(root, { recursive: true, force: true });
    });
    fs.symlinkSync(path.join(ROOT_DIR, "node_modules"), modules, process.platform === "win32" ? "junction" : "dir");
    const toolkit = path.join(root, "tools/frontend-analysis");
    fs.mkdirSync(toolkit, { recursive: true });
    for (const name of fs.readdirSync(TOOL_DIR).filter((name) => name.endsWith(".mjs"))) {
      fs.copyFileSync(path.join(TOOL_DIR, name), path.join(toolkit, name));
    }
    for (const name of ["analysis", "cli", "performance-analysis", "window-entry"]) {
      fs.writeFileSync(path.join(toolkit, `${name}.test.mjs`), name === "analysis" && failedStage === "tooling-tests" ? 'throw new Error("intentional tooling failure");\n' : "");
    }
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { types: [], noEmit: true }, files: ["invalid.ts"] }));
    fs.writeFileSync(path.join(root, "invalid.ts"), "const invalid: string = 123;\n");
    fs.writeFileSync(path.join(toolkit, "baseline.json"), JSON.stringify({ schemaVersion: 1 }));
    const environment = { ...process.env };
    // The fixture launches its own test runner, outside this runner's child context.
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.join(toolkit, "cli.mjs"), "ci"], {
      cwd: root, env: environment, encoding: "utf8", timeout: 60_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    const diagnostic = failedStage === "tooling-tests" ? /intentional tooling failure/ : /TS2322/;
    assert.match(result.stderr + result.stdout, diagnostic);
    assert.doesNotMatch(result.stdout, /starting (vitest|vite-build)/);
    if (failedStage === "tooling-tests") assert.doesNotMatch(result.stdout, /starting typecheck/);
    const reports = path.join(toolkit, "reports/latest");
    const summary = JSON.parse(fs.readFileSync(path.join(reports, "summary.json"), "utf8"));
    assert.equal(summary.overallStatus, "failed");
    assert.deepEqual(summary.stages.map(({ name, status }) => ({ name, status })),
      failedStage === "tooling-tests" ? [{ name: "tooling-tests", status: "failed" }]
        : [{ name: "tooling-tests", status: "passed" }, { name: "typecheck", status: "failed" }]);
    assert.match(fs.readFileSync(path.join(reports, `logs/${failedStage}.log`), "utf8"), diagnostic);
    assert.ok(fs.existsSync(path.join(reports, "report.html")));
  });
}
