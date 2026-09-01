# Contributing to Tinybot

## Development setup

Install the frontend dependencies and enable the repository's tracked Git
hooks from the repository root:

```bash
npm install
npm run hooks:install
```

The hook installation is per checkout. Platform prerequisites and desktop
runtime commands are documented in [the desktop development guide](docs/desktop.md).

## Reporting issues

Use the [issue chooser](https://github.com/SudoJacky/tinybot/issues/new/choose)
to submit a bug report or feature request. Bug reports should include the
Tinybot and Windows versions, reproducible steps, expected behavior, and any
relevant logs with credentials and private data removed. Feature requests
should describe the underlying problem before the proposed solution.

## Documentation system

Start with the [engineering documentation map](docs/README.md). Tinybot keeps
one authoritative home for each kind of engineering knowledge:

| Change | Documentation to review |
| --- | --- |
| Module responsibility, interface, lifecycle, or invariant | Nearest module `README.md` |
| Cross-module flow, seam, or authority | `docs/architecture/` |
| Durable choice with meaningful alternatives | `docs/decisions/` |
| Command, event, RPC, configuration, or payload shape | Reference documentation |
| Development or recovery procedure | Guide or runbook |

Maintainer documentation uses English as its canonical language. Public entry
documentation may be translated. Formal documentation must not depend on local
scratch notes or present archived documents as current behavior.

Do not create a README for every directory. A directory needs its own module
README only when it owns a meaningful interface, invariant, lifecycle, or
authority. Otherwise its implementation remains documented by the nearest
parent README.

A useful module README normally covers:

- the capability the module provides;
- responsibilities and explicit non-responsibilities;
- the interface callers and tests use;
- invariants, failure behavior, persistence, and concurrency where relevant;
- dependencies and adapters at its seams;
- verification entry points and related architecture or reference links.

Prefer stable contracts over file-by-file inventories. Update architecture
only when a cross-module relationship changes; ordinary internal refactors
should not create documentation churn.

Architecture and API documents declare a focused `tinybot-doc-watch` list.
Architecture watches follow cross-module seams; API watches prefer public
contract definitions and contract tests. When a watched source changes, review
the affected document and refresh its fingerprint:

```bash
git add <watched source files>
npm run docs:review -- --staged docs/<architecture-or-api>/<document>.md
git add docs/<architecture-or-api>/<document>.md
npm run docs:check -- --staged
```

Use `npm run docs:review -- --all` only after reading every architecture and API
document and its declared watch sources. `npm run docs:check` also validates
formal local links and heading structure. It does not read local scratch notes
or archived documentation.

## Keep module READMEs current

Module READMEs under `src/` and `src-tauri/` contain a fingerprint of the
tracked files they describe. A source file normally belongs to the nearest
ancestor `README.md`. When an owned file changes, the recorded fingerprint no
longer matches and the README must be reviewed.

For each changed module:

1. Stage the implementation files.
2. Read the module README and update its prose when responsibilities,
   behavior, boundaries, or important operational details changed.
3. Refresh the fingerprint from the staged implementation.
4. Stage the reviewed README.

```bash
git add <module files>
npm run readme:review -- --staged <module directory>
git add <module directory>/README.md
npm run readme:check -- --staged
```

Use `npm run readme:review -- --staged --all` only after reviewing every module
README. To check the complete working tree without writing files, run:

```bash
npm run readme:check
```

`review --staged` deliberately reads module contents from the Git index, so
unrelated working-tree changes do not enter the fingerprint. `docs:check`
also validates the heading structure and local links of module READMEs.

The fingerprint proves that the README was reviewed against a specific set of
module files. It cannot determine whether the prose is correct; semantic review
is still required.

## Enforcement

- The tracked pre-commit hook validates staged engineering documentation and
  checks affected modules for missing, malformed, or stale fingerprints.
- CI tests both freshness tools, validates formal and module documentation,
  then checks every module README against the clean checkout. This covers
  commits made without the local hook.
- A module README that owns no tracked files is rejected rather than being
  accepted with an empty fingerprint.

## Relevant checks

Run the checks that match the files you changed:

```bash
# Frontend
npm test
npm run build

# Rust backend
cargo check --manifest-path src-tauri/Cargo.toml
```

The pre-commit hook selects the applicable checks from the staged paths.
