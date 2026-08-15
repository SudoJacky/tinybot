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
unrelated working-tree changes do not enter the fingerprint.

The fingerprint proves that the README was reviewed against a specific set of
module files. It cannot determine whether the prose is correct; semantic review
is still required.

## Enforcement

- The tracked pre-commit hook checks the affected staged modules and rejects
  missing, malformed, or stale fingerprints.
- CI tests the freshness tool itself, then checks every module README against
  the clean checkout. This covers commits made without the local hook.
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
