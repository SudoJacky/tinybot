import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./customize-updater-manifest.mjs", import.meta.url));

function customize(manifest, environment = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tinybot-updater-manifest-"));
  const manifestPath = join(directory, "latest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

  const result = spawnSync(process.execPath, [scriptPath, manifestPath], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

test("writes custom release and display notes without changing updater artifacts", () => {
  const manifest = customize(
    {
      version: "0.3.0",
      notes: "Generated notes",
      platforms: { "windows-x86_64": { url: "https://example.com/update.zip", signature: "signed" } },
    },
    {
      UPDATE_RELEASE_NOTES: "  Added a custom workflow.\n\nFixed update prompts.  ",
      UPDATE_DISPLAY_NOTES: "  Save active work before installing.  ",
    },
  );

  assert.equal(manifest.notes, "Added a custom workflow.\n\nFixed update prompts.");
  assert.equal(manifest.display_notes, "Save active work before installing.");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "signed");
});

test("keeps generated notes when custom inputs are blank", () => {
  const manifest = customize(
    { version: "0.3.0", notes: "Generated notes" },
    { UPDATE_RELEASE_NOTES: "  ", UPDATE_DISPLAY_NOTES: "" },
  );

  assert.equal(manifest.notes, "Generated notes");
  assert.equal("display_notes" in manifest, false);
});
