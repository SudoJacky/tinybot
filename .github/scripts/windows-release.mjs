import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function readBundle(directory, tag, repository) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? "")) {
    throw new Error("A v<semver> release tag is required");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
    throw new Error("A GitHub owner/repository is required");
  }
  const version = tag.slice(1);
  const installers = readdirSync(directory).filter((name) => name.endsWith(".exe"));
  if (installers.length !== 1 || !installers[0].endsWith(`_${version}_x64-setup.exe`)) {
    throw new Error(`Expected exactly one Windows x64 NSIS installer for ${tag}`);
  }
  const installer = installers[0];
  if (statSync(join(directory, installer)).size === 0) {
    throw new Error("The Windows installer is empty");
  }
  const signature = readFileSync(join(directory, `${installer}.sig`), "utf8").trim();
  if (!signature) throw new Error("The updater signature is empty");
  // Match the existing GitHub asset names, where spaces are replaced by dots.
  const assetName = installer.replaceAll(" ", ".");
  const platform = {
    signature,
    url: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`,
  };
  return { version, installer, assetName, platform };
}

export function prepareRelease(source, destination, { tag, repository }) {
  const bundle = readBundle(source, tag, repository);
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(source, bundle.installer), join(destination, bundle.assetName));
  copyFileSync(join(source, `${bundle.installer}.sig`), join(destination, `${bundle.assetName}.sig`));
  const manifest = {
    version: bundle.version,
    notes: "",
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": bundle.platform,
      "windows-x86_64-nsis": bundle.platform,
    },
  };
  writeManifest(destination, manifest);
  console.log(`Prepared signed Windows x64 artifacts for ${tag}`);
}

function writeManifest(directory, manifest) {
  writeFileSync(join(directory, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function validateRelease(directory, { tag, repository }) {
  const bundle = readBundle(directory, tag, repository);
  const manifest = JSON.parse(readFileSync(join(directory, "latest.json"), "utf8"));
  if (manifest.version !== bundle.version || !Number.isFinite(Date.parse(manifest.pub_date))) {
    throw new Error("Updater manifest version or publication date is invalid");
  }
  for (const target of ["windows-x86_64", "windows-x86_64-nsis"]) {
    const platform = manifest.platforms?.[target];
    if (platform?.signature !== bundle.platform.signature || platform?.url !== bundle.platform.url) {
      throw new Error(`Updater manifest ${target} does not match the signed installer`);
    }
  }
  return { bundle, manifest };
}

function runGh(args, input) {
  return execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
}

export function publishRelease(directory, options, gh = runGh) {
  const { tag, repository, commit, releaseNotes = "", displayNotes = "" } = options;
  const { bundle, manifest } = validateRelease(directory, options);
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("The built commit SHA is required");

  const releasesPath = `repos/${repository}/releases`;
  // Listing includes drafts and distinguishes an absent release from an API failure.
  const releases = JSON.parse(gh(["api", releasesPath, "--paginate", "--slurp"])).flat();
  let release = releases.find((entry) => entry.tag_name === tag);
  if (release && !release.draft) {
    throw new Error(`${tag} is already published; refusing to replace live updater artifacts`);
  }

  const notes = releaseNotes.trim() || JSON.parse(gh([
    "api", `${releasesPath}/generate-notes`, "--input", "-",
  ], JSON.stringify({ tag_name: tag, target_commitish: commit }))).body;
  if (typeof notes !== "string") throw new Error("GitHub did not return release notes");
  manifest.notes = notes;
  if (displayNotes.trim()) manifest.display_notes = displayNotes.trim();
  writeManifest(directory, manifest);

  const body = JSON.stringify({
    tag_name: tag,
    target_commitish: commit,
    name: `Tinybot Desktop ${tag}`,
    body: notes,
    draft: true,
    prerelease: false,
  });
  release = JSON.parse(gh([
    "api", release ? `${releasesPath}/${release.id}` : releasesPath,
    "--method", release ? "PATCH" : "POST", "--input", "-",
  ], body));

  gh([
    "release", "upload", tag, "--repo", repository, "--clobber",
    join(directory, bundle.assetName), join(directory, `${bundle.assetName}.sig`),
    join(directory, "latest.json"),
  ]);

  const assets = JSON.parse(gh([
    "api", `${releasesPath}/${release.id}/assets`, "--paginate", "--slurp",
  ])).flat();
  for (const name of [bundle.assetName, `${bundle.assetName}.sig`, "latest.json"]) {
    const asset = assets.find((entry) => entry.name === name);
    if (!asset || asset.state !== "uploaded" || asset.size !== statSync(join(directory, name)).size) {
      throw new Error(`Release asset ${name} is missing or incomplete`);
    }
  }
  gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
  console.log(`Published ${tag} from ${commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory, destination] = process.argv.slice(2);
  const options = {
    tag: process.env.RELEASE_TAG,
    repository: process.env.GITHUB_REPOSITORY,
    commit: process.env.RELEASE_COMMIT,
    releaseNotes: process.env.UPDATE_RELEASE_NOTES,
    displayNotes: process.env.UPDATE_DISPLAY_NOTES,
  };
  if (command === "prepare" && directory && destination) {
    prepareRelease(directory, destination, options);
    validateRelease(destination, options);
  } else if (command === "publish" && directory) {
    publishRelease(directory, options);
  } else {
    throw new Error("Usage: windows-release.mjs prepare <bundles> <output> | publish <artifacts>");
  }
}
