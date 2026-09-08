import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareRelease, publishRelease, validateRelease } from "./windows-release.mjs";

const options = {
  tag: "v1.2.3",
  repository: "example/tinybot",
  commit: "a".repeat(40),
};
const installer = "Tinybot Desktop_1.2.3_x64-setup.exe";
const assetName = installer.replaceAll(" ", ".");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "tinybot-release-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "nsis");
  const destination = join(root, "release artifacts");
  mkdirSync(source);
  writeFileSync(join(source, installer), "signed installer fixture");
  writeFileSync(join(source, `${installer}.sig`), "signature fixture\n");
  return { source, destination };
}

function fakeGitHub(directory, { draft = null, uploadFails = false, missingAsset = false } = {}) {
  const calls = [];
  let release = draft === null ? null : { id: 123, tag_name: options.tag, draft };
  return {
    calls,
    gh(args, input) {
      calls.push({ args, input });
      if (args.includes("--slurp") && args[1].endsWith("/releases")) {
        return JSON.stringify([release ? [release] : []]);
      }
      if (args[1].endsWith("/generate-notes")) return JSON.stringify({ body: "Generated changes" });
      if (args[0] === "api" && args.includes("--input")) {
        release = { id: 123, ...JSON.parse(input) };
        return JSON.stringify(release);
      }
      if (args[0] === "release" && args[1] === "upload") {
        if (uploadFails) throw new Error("Upload failed");
        return "";
      }
      if (args[1].endsWith("/assets")) {
        return JSON.stringify([missingAsset ? [] : readdirSync(directory).map((name) => ({
          name, state: "uploaded", size: statSync(join(directory, name)).size,
        }))]);
      }
      if (args[0] === "release" && args[1] === "edit") return "";
      throw new Error(`Unexpected GitHub command: ${args.join(" ")}`);
    },
  };
}

test("prepares compatible NSIS updater entries and preserves installer and signature bytes", (t) => {
  const { source, destination } = fixture(t);
  prepareRelease(source, destination, options);
  const { manifest } = validateRelease(destination, options);
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.platforms["windows-x86_64"], {
    url: `https://github.com/example/tinybot/releases/download/v1.2.3/${assetName}`,
    signature: "signature fixture",
  });
  assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], manifest.platforms["windows-x86_64"]);
  for (const suffix of ["", ".sig"]) {
    assert.deepEqual(readFileSync(join(destination, assetName + suffix)), readFileSync(join(source, installer + suffix)));
  }
});

for (const [name, mutate] of [
  ["missing signature", (source) => rmSync(join(source, `${installer}.sig`))],
  ["empty signature", (source) => writeFileSync(join(source, `${installer}.sig`), " \n")],
  ["empty installer", (source) => writeFileSync(join(source, installer), "")],
  ["ambiguous installers", (source) => writeFileSync(join(source, "other.exe"), "other")],
]) {
  test(`rejects ${name} before preparing artifacts`, (t) => {
    const { source, destination } = fixture(t);
    mutate(source);
    assert.throws(() => prepareRelease(source, destination, options));
  });
}

test("rejects an installer from a different version", (t) => {
  const { source, destination } = fixture(t);
  assert.throws(() => prepareRelease(source, destination, { ...options, tag: "v1.2.4" }), /Expected exactly one/);
});

test("rejects a mismatched manifest before contacting GitHub", (t) => {
  const { source, destination } = fixture(t);
  prepareRelease(source, destination, options);
  const manifestPath = join(destination, "latest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.platforms["windows-x86_64"].url = "https://example.com/wrong.exe";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const remote = fakeGitHub(destination);
  assert.throws(() => publishRelease(destination, options, remote.gh), /does not match/);
  assert.equal(remote.calls.length, 0);
});

test("publishes only after upload verification and uses generated notes in the updater", (t) => {
  const { source, destination } = fixture(t);
  prepareRelease(source, destination, options);
  const remote = fakeGitHub(destination);
  publishRelease(destination, options, remote.gh);
  const manifest = JSON.parse(readFileSync(join(destination, "latest.json"), "utf8"));
  assert.equal(manifest.notes, "Generated changes");
  const creation = remote.calls.find(({ args }) => args.includes("POST"));
  assert.equal(JSON.parse(creation.input).draft, true);
  assert.equal(JSON.parse(creation.input).target_commitish, options.commit);
  assert.deepEqual(remote.calls.at(-1).args, [
    "release", "edit", options.tag, "--repo", options.repository, "--draft=false", "--latest",
  ]);
  assert.match(remote.calls.at(-2).args[1], /\/assets$/);
});

test("resumes an existing draft and preserves custom notes literally", (t) => {
  const { source, destination } = fixture(t);
  prepareRelease(source, destination, options);
  const remote = fakeGitHub(destination, { draft: true });
  const releaseNotes = "Changes\n\nKeep `code`, $variables and quotes: \"hello\".";
  publishRelease(destination, { ...options, releaseNotes, displayNotes: " Save your work. " }, remote.gh);
  assert.ok(remote.calls.some(({ args }) => args.includes("PATCH")));
  assert.ok(!remote.calls.some(({ args }) => args[1].endsWith("/generate-notes")));
  const manifest = JSON.parse(readFileSync(join(destination, "latest.json"), "utf8"));
  assert.equal(manifest.notes, releaseNotes);
  assert.equal(manifest.display_notes, "Save your work.");
});

for (const [name, state, message] of [
  ["published release", { draft: false }, /already published/],
  ["upload failure", { uploadFails: true }, /Upload failed/],
  ["incomplete remote assets", { missingAsset: true }, /missing or incomplete/],
]) {
  test(`does not publish after ${name}`, (t) => {
    const { source, destination } = fixture(t);
    prepareRelease(source, destination, options);
    const remote = fakeGitHub(destination, state);
    assert.throws(() => publishRelease(destination, options, remote.gh), message);
    assert.ok(!remote.calls.some(({ args }) => args[0] === "release" && args[1] === "edit"));
    if (state.draft === false) assert.equal(remote.calls.length, 1);
  });
}

test("propagates GitHub failures without treating them as a missing release", (t) => {
  const { source, destination } = fixture(t);
  prepareRelease(source, destination, options);
  assert.throws(() => publishRelease(destination, options, () => {
    throw new Error("GitHub authentication failed");
  }), /authentication failed/);
});
