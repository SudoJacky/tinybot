import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function classifyChanges(files) {
  const scope = { frontend: false, windows: false };
  for (const file of files) {
    if (/^(README(?:_[A-Z]+)?\.md|LICENSE(?:\..*)?|CHANGELOG\.md)$/.test(file)
      || file.startsWith("docs/") || file.startsWith("website/")) continue;
    // Module READMEs are checked separately. Other Markdown can be embedded in the app.
    if (/^(src|src-tauri)\/(?:.*\/)?README\.md$/.test(file)) continue;
    if (/^(src-tauri\/|\.cargo\/|tools\/ripgrep\/|rust-toolchain(?:\.toml)?$)/.test(file)) {
      scope.windows = true;
    } else if (/^(src\/|workers\/|public\/|tools\/frontend-analysis\/|vite\.config\.|tsconfig.*\.json$|index\.html$)/.test(file)) {
      scope.frontend = true;
    } else {
      // Shared configuration and new, unclassified paths require both checks.
      scope.frontend = true;
      scope.windows = true;
    }
  }
  return scope;
}

export function changedFiles(event, eventName, git = (args) => execFileSync("git", args, { encoding: "utf8" })) {
  const base = eventName === "pull_request" ? event.pull_request?.base?.sha : event.before;
  if (!/^[a-f0-9]{40}$/.test(base ?? "") || /^0+$/.test(base)) {
    throw new Error("Cannot determine the CI comparison commit");
  }
  // Include both sides of renames so moving a file across scopes checks both areas.
  return git(["diff", "--name-only", "--no-renames", "-z", base, "HEAD"])
    .split("\0").filter(Boolean);
}

export function requireChecks(needs) {
  if (needs.checks?.result !== "success") throw new Error("CI preflight did not succeed");
  for (const job of ["frontend", "windows"]) {
    const required = needs.checks.outputs?.[job];
    if (!["true", "false"].includes(required)) throw new Error(`Missing CI scope for ${job}`);
    const result = needs[job]?.result;
    if (result !== "success" && !(required === "false" && result === "skipped")) {
      throw new Error(`${job}: ${result ?? "missing"} (required: ${required})`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === "check") {
    requireChecks(JSON.parse(process.env.CI_NEEDS));
    console.log("All required CI checks passed.");
  } else if (process.argv[2] === "detect") {
    const full = process.env.CI_FULL === "true";
    const files = full ? [] : changedFiles(JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")), process.env.GITHUB_EVENT_NAME);
    const scope = full ? { frontend: true, windows: true } : classifyChanges(files);
    console.log(JSON.stringify({ full, files, scope }, null, 2));
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([job, required]) => `${job}=${required}\n`).join(""));
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `CI scope: frontend **${scope.frontend}**, Windows **${scope.windows}** (${full ? "full validation" : `${files.length} changed paths`}).\n`);
  } else {
    throw new Error("Usage: node ci-scope.mjs <detect|check>");
  }
}
