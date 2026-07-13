import { readFileSync } from "node:fs";

function fail(message) {
  console.error(`release version check failed: ${message}`);
  process.exit(1);
}

const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (!tag) {
  fail("pass a v<semver> tag as the first argument or GITHUB_REF_NAME");
}

const tagMatch = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!tagMatch) {
  fail(`tag ${tag} must use v<semver>`);
}

const expected = tagMatch[1];
const tauriConfig = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const npmPackage = JSON.parse(readFileSync("package.json", "utf8"));
const cargoManifest = readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoPackage = /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(cargoManifest);

if (!cargoPackage) {
  fail("could not read [package] version from src-tauri/Cargo.toml");
}

const versions = new Map([
  ["src-tauri/tauri.conf.json", tauriConfig.version],
  ["package.json", npmPackage.version],
  ["src-tauri/Cargo.toml", cargoPackage[1]],
]);

for (const [source, version] of versions) {
  if (version !== expected) {
    fail(`${source} is ${version ?? "missing"}, expected ${expected} from ${tag}`);
  }
}

console.log(`release version check passed: ${tag}`);
