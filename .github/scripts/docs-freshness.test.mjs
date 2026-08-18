import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./docs-freshness.mjs", import.meta.url));

function run(command, arguments_, cwd) {
  return spawnSync(command, arguments_, { cwd, encoding: "utf8" });
}

function git(repository, ...arguments_) {
  const result = run("git", arguments_, repository);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function write(repository, path, contents) {
  const absolute = join(repository, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents, "utf8");
}

function fixture(t) {
  const repository = mkdtempSync(join(tmpdir(), "tinybot-docs-freshness-"));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, "init");
  git(repository, "config", "user.name", "Tinybot Tests");
  git(repository, "config", "user.email", "tinybot@example.com");
  write(repository, "README.md", "# Fixture\n\n[Engineering docs](docs/README.md)\n");
  write(repository, "CONTRIBUTING.md", "# Contributing\n\nReview documentation.\n");
  write(
    repository,
    "docs/README.md",
    "# Documentation\n\n[Runtime flow](architecture/runtime-flow.md)\n",
  );
  write(
    repository,
    "docs/architecture/runtime-flow.md",
    "# Runtime Flow\n<!-- tinybot-doc-watch:\nsrc/runtime/README.md\nsrc/runtime/loop.rs\n-->\n\nRuntime flow.\n",
  );
  write(
    repository,
    "src/runtime/README.md",
    "# Runtime\n<!-- tinybot-module-fingerprint: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->\n\nRuntime contract.\n",
  );
  write(repository, "src/runtime/loop.rs", "pub fn run() {}\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "test: create fixture");
  return repository;
}

function docsTool(repository, ...arguments_) {
  return run(process.execPath, [scriptPath, ...arguments_], repository);
}

test("freshness review covers working-tree, staged, and normalized module README inputs", (t) => {
  const repository = fixture(t);
  const document = "docs/architecture/runtime-flow.md";
  const source = "src/runtime/loop.rs";

  const unreviewed = docsTool(repository, "check");
  assert.equal(unreviewed.status, 1);
  assert.match(unreviewed.stdout, /UNREVIEWED\s+docs\/architecture\/runtime-flow\.md/);

  assert.equal(docsTool(repository, "review", document).status, 0);
  assert.match(
    readFileSync(join(repository, document), "utf8"),
    /^<!-- tinybot-doc-fingerprint: sha256:[a-f0-9]{64} -->$/m,
  );
  assert.equal(docsTool(repository, "check").status, 0);

  write(
    repository,
    "src/runtime/README.md",
    "# Runtime\n<!-- tinybot-module-fingerprint: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb -->\n\nRuntime contract.\n",
  );
  assert.equal(docsTool(repository, "check").status, 0);

  write(repository, source, "pub fn run() { println!(\"changed\"); }\n");
  const stale = docsTool(repository, "check");
  assert.equal(stale.status, 1);
  assert.match(stale.stdout, /STALE\s+docs\/architecture\/runtime-flow\.md/);
  assert.match(stale.stdout, /changed: src\/runtime\/loop\.rs/);

  assert.equal(docsTool(repository, "review", "--all").status, 0);
  git(repository, "add", document, source, "src/runtime/README.md");
  git(repository, "commit", "-m", "docs: review current architecture");

  write(repository, source, "pub fn run() { println!(\"staged\"); }\n");
  git(repository, "add", source);
  assert.equal(docsTool(repository, "check", "--staged").status, 1);

  assert.equal(docsTool(repository, "review", "--staged", document).status, 0);
  git(repository, "add", document);
  assert.equal(docsTool(repository, "check", "--staged").status, 0);

  write(repository, source, "pub fn run() { println!(\"unstaged\"); }\n");
  assert.equal(docsTool(repository, "check", "--staged").status, 0);
  assert.equal(docsTool(repository, "check").status, 1);
});

test("structural validation rejects broken links, local scratch links, bad H1s, and invalid watches", (t) => {
  const repository = fixture(t);
  const document = "docs/architecture/runtime-flow.md";
  assert.equal(docsTool(repository, "review", "--all").status, 0);

  write(repository, "src/runtime/README.md", "# Runtime\n\n[Missing](missing.md)\n");
  let result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /src\/runtime\/README\.md: broken local link: missing\.md/);
  write(
    repository,
    "src/runtime/README.md",
    "# Runtime\n<!-- tinybot-module-fingerprint: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->\n\nRuntime contract.\n",
  );

  write(repository, "docs/README.md", "# Documentation\n\n[Missing](missing.md)\n");
  result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /broken local link: missing\.md/);

  write(repository, "docs/README.md", "# Documentation\n\n[Scratch](local/private.md)\n");
  result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /must not link local scratch content/);

  write(repository, "docs/README.md", "# Documentation\n\n# Duplicate\n");
  result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /expected exactly one H1, found 2/);

  write(repository, "docs/README.md", "# Documentation\n");
  write(
    repository,
    document,
    "# Runtime Flow\n<!-- tinybot-doc-watch:\ndocs/local/private.md\n-->\n",
  );
  result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /watches excluded content/);

  write(
    repository,
    document,
    "# Runtime Flow\n<!-- tinybot-doc-watch:\nsrc/runtime/missing.rs\n-->\n",
  );
  result = docsTool(repository, "check");
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /watches an untracked or missing file/);
});
