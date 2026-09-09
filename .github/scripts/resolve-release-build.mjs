import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";

function github(path) {
  return JSON.parse(execFileSync("gh", ["api", path], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 60_000,
  }));
}

export async function resolveReleaseBuild({ repository, commit }, {
  api = github, sleep = setTimeout, now = Date.now, log = console.log,
  timeoutMs = 70 * 60_000,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("A GitHub repository is required");
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("An exact release commit SHA is required");
  const root = `repos/${repository}/actions`;
  const deadline = now() + timeoutMs;
  let selected;
  while (now() < deadline) {
    if (!selected) {
      const { workflow_runs: runs } = await api(
        `${root}/workflows/ci.yml/runs?head_sha=${commit}&branch=master&per_page=100`,
      );
      selected = runs.filter((run) => run.head_sha === commit && run.head_branch === "master"
        && run.head_repository?.full_name === repository
        && ["push", "workflow_dispatch"].includes(run.event))
        .sort((a, b) => b.id - a.id)[0];
    }
    if (selected) {
      const run = await api(`${root}/runs/${selected.id}`);
      if (run.head_sha !== commit || run.head_branch !== "master"
        || run.head_repository?.full_name !== repository
        || !["push", "workflow_dispatch"].includes(run.event)) {
        throw new Error("CI run does not match the trusted release source");
      }
      log(`CI ${run.html_url}: ${run.status} / ${run.conclusion ?? "pending"}`);
      if (run.status === "completed") {
        if (run.conclusion !== "success") throw new Error(`CI failed (${run.conclusion}): ${run.html_url}`);
        const { artifacts } = await api(`${root}/runs/${run.id}/artifacts?per_page=100`);
        const name = `windows-x64-${commit}-${run.run_attempt}`;
        const artifact = artifacts.find((entry) => entry.name === name && !entry.expired);
        if (!artifact) {
          throw new Error(`Missing or expired ${name}. Re-run all jobs of CI for ${commit} before releasing.`);
        }
        log(`Using artifact ${artifact.id} (${artifact.size_in_bytes} bytes) from ${run.html_url}`);
        return { runId: run.id, artifactId: artifact.id };
      }
    } else {
      log(`Waiting for master CI to appear for ${commit}`);
    }
    await sleep(30_000);
  }
  throw new Error(`Timed out waiting for master CI for ${commit}. Run CI for that commit and retry the release.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await resolveReleaseBuild({
    repository: process.env.GITHUB_REPOSITORY, commit: process.env.RELEASE_COMMIT,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${result.runId}\nartifact-id=${result.artifactId}\n`);
}
