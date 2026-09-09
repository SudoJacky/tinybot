import assert from "node:assert/strict";
import test from "node:test";
import { resolveReleaseBuild } from "./resolve-release-build.mjs";

const options = { repository: "example/tinybot", commit: "a".repeat(40) };
const run = {
  id: 42, head_sha: options.commit, head_branch: "master",
  head_repository: { full_name: options.repository }, event: "push",
  status: "completed", conclusion: "success", run_attempt: 2,
  html_url: "https://github.com/example/tinybot/actions/runs/42",
};
const artifact = {
  id: 99, name: `windows-x64-${options.commit}-2`, expired: false, size_in_bytes: 100,
};

function fixture({ runs = [run], states = [run], artifacts = [artifact] } = {}) {
  let elapsed = 0;
  const calls = [];
  return {
    calls,
    api: async (path) => {
      calls.push(path);
      if (path.includes("/workflows/")) return { workflow_runs: runs };
      if (path.includes("/artifacts?")) return { artifacts };
      return states.length > 1 ? states.shift() : states[0];
    },
    sleep: async (ms) => { elapsed += ms; },
    now: () => elapsed, log: () => {}, timeoutMs: 90_000,
  };
}

test("waits for the exact master CI to succeed before selecting its current-attempt artifact", async () => {
  const deps = fixture({ states: [{ ...run, status: "in_progress", conclusion: null }, run] });
  assert.deepEqual(await resolveReleaseBuild(options, deps), { runId: 42, artifactId: 99 });
  assert.equal(deps.calls.filter((path) => path.endsWith("/runs/42")).length, 2);
  assert.match(deps.calls[0], new RegExp(`head_sha=${options.commit}&branch=master`));
});

test("never releases from PR, tag, fork, or another commit", async () => {
  for (const change of [
    { event: "pull_request" }, { head_branch: "v1.0.0" },
    { head_repository: { full_name: "fork/tinybot" } }, { head_sha: "b".repeat(40) },
  ]) {
    const deps = fixture({ runs: [{ ...run, ...change }] });
    await assert.rejects(resolveReleaseBuild(options, deps), /Timed out/);
    assert.ok(deps.calls.every((path) => path.includes("/workflows/")));
  }
});

test("failed or cancelled CI blocks publishing even when an installer exists", async () => {
  for (const conclusion of ["failure", "cancelled", "timed_out"]) {
    const deps = fixture({ states: [{ ...run, conclusion }] });
    await assert.rejects(resolveReleaseBuild(options, deps), /CI failed/);
    assert.ok(deps.calls.every((path) => !path.includes("/artifacts?")));
  }
});

test("rejects missing, expired, or previous-attempt artifacts", async () => {
  for (const artifacts of [[], [{ ...artifact, expired: true }], [{ ...artifact, name: `windows-x64-${options.commit}-1` }]]) {
    await assert.rejects(resolveReleaseBuild(options, fixture({ artifacts })), /Missing or expired/);
  }
});

test("accepts manually dispatched master CI", async () => {
  const manual = { ...run, event: "workflow_dispatch" };
  assert.deepEqual(await resolveReleaseBuild(options, fixture({ runs: [manual], states: [manual] })), { runId: 42, artifactId: 99 });
});

test("waits for a newly pushed commit's CI to appear", async () => {
  const deps = fixture();
  const original = deps.api;
  let first = true;
  deps.api = async (path) => {
    if (first) { first = false; return { workflow_runs: [] }; }
    return original(path);
  };
  assert.deepEqual(await resolveReleaseBuild(options, deps), { runId: 42, artifactId: 99 });
});

test("API errors surface immediately", async () => {
  await assert.rejects(resolveReleaseBuild(options, {
    ...fixture(), api: async () => { throw new Error("HTTP 403"); },
  }), /HTTP 403/);
});

test("a newer failed run is not bypassed using an older successful run", async () => {
  const newer = { ...run, id: 43, conclusion: "failure" };
  const deps = fixture({ runs: [run, newer], states: [newer] });
  await assert.rejects(resolveReleaseBuild(options, deps), /CI failed/);
  assert.ok(deps.calls.some((path) => path.endsWith("/runs/43")));
});

test("revalidates the selected run's source before using its artifacts", async () => {
  await assert.rejects(resolveReleaseBuild(options, fixture({
    states: [{ ...run, head_sha: "b".repeat(40) }],
  })), /does not match/);
});
