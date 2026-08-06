import { readFileSync, writeFileSync } from "node:fs";

function optionalText(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function fail(message) {
  console.error(`updater manifest customization failed: ${message}`);
  process.exit(1);
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  fail("pass the latest.json path as the first argument");
}

try {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const releaseNotes = optionalText(process.env.UPDATE_RELEASE_NOTES);
  const displayNotes = optionalText(process.env.UPDATE_DISPLAY_NOTES);

  if (releaseNotes) {
    manifest.notes = releaseNotes;
  }
  if (displayNotes) {
    manifest.display_notes = displayNotes;
  }

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`customized updater manifest: ${manifestPath}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
