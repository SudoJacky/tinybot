# Tinybot Engineering Documentation

This is the entry point for Tinybot's current, maintained engineering
documentation. Start here when locating an architectural fact, a module owner,
or the correct document to update with a code change.

The public product overview remains in the repository [README](../README.md).
Local scratch notes are not part of this documentation system and must not be
used as a source of truth.

## Reading paths

### New contributors

1. Read the [system overview](architecture/system-overview.md).
2. Follow the setup and runtime commands in the [desktop guide](desktop.md).
3. Read the [backend maintainer map](../src-tauri/README.md) or the
   [React workbench map](../src/react-workbench/README.md) for the area you will
   change.
4. Read the nearest module `README.md` before editing its implementation.

### Agent harness

- [Agent turn lifecycle](architecture/agent-turn-lifecycle.md)
- [Context and instructions](architecture/context-and-instructions.md)
- [Tool execution and permissions](architecture/tool-execution-and-permissions.md)
- [Thread and Rollout persistence](architecture/thread-rollout-persistence.md)
- [Rust backend API reference](api/rust-backend-api.md)

### Frontend and desktop integration

- [React workbench](../src/react-workbench/README.md)
- [Framework-independent application core](../src/app-core/chat/README.md)
- [Agent Graph definitions, runs, and Threads](decisions/0001-agent-graph-definitions-runs-and-threads.md)
- [Native renderer adapters](../src/app-core/native/README.md)
- [Desktop host guide](desktop.md)
- [Windows desktop smoke test](guides/desktop-smoke-test.md)

## Document classes

| Class | Purpose | Location |
| --- | --- | --- |
| Project entry | Product overview and first-run commands | Root `README.md` |
| Architecture | Current cross-module flows and authority relationships | `docs/architecture/` |
| Module contract | A module's interface, responsibilities, and invariants | Nearest module `README.md` |
| Decision record | Why a durable architectural choice was made | `docs/decisions/` |
| Guide | How to complete a normal development task | `docs/` today; use `docs/guides/` when the first focused guide is added |
| Runbook | How to diagnose or recover an operational failure | Add under `docs/runbooks/` when needed |
| Reference | Exact commands, events, configuration, and data shapes | `docs/api/` and future `docs/reference/` |
| Archive | Superseded or historical material | `docs/archive/` |

Do not create an empty directory or placeholder document for a category. Add a
category when it has a real document to own.

## Source-of-truth rules

Keep one authoritative home for each fact and link to it elsewhere.

| Change | Authoritative documentation |
| --- | --- |
| Module responsibility, interface, lifecycle, or invariant | Module `README.md` |
| Cross-module flow, ownership, or authority | Architecture document |
| Long-lived choice with meaningful alternatives | Architecture decision record |
| Command, event, RPC, configuration, or payload shape | Reference document |
| Development procedure | Guide |
| Failure diagnosis or recovery procedure | Runbook |

Architecture documents explain relationships. They should link to module
contracts for implementation detail and to reference documents for exact wire
shapes. Avoid maintaining file-by-file inventories or copying configuration
tables across documents.

## Maintenance policy

- Maintainer documentation is written in English so code, GitHub discussion,
  and engineering documentation share one canonical vocabulary. Public entry
  documentation may be translated.
- A module needs its own README only when it owns a meaningful interface,
  invariant, lifecycle, or authority. Otherwise its nearest parent README owns
  the implementation.
- Update architecture only when a cross-module flow, seam, or authority
  changes. Ordinary internal refactors should not create documentation churn.
- Record durable reasoning in an ADR; do not use ADRs for routine parameter or
  presentation changes.
- Archived documents must identify themselves as historical and must not be
  linked as current behavior.
- Formal documentation must not depend on local scratch notes.
- Link important behavior to the tests that verify it whenever a stable test
  entry point exists.

Architecture and API documents declare focused `tinybot-doc-watch` sources and
record a content fingerprint after human review. API watch lists should prefer
public contract definitions and contract tests over internal implementation
details. Check the complete formal documentation set with:

```bash
npm run docs:check
```

After reading an affected architecture or API document and its watch sources,
refresh the review marker with `npm run docs:review -- <document>`. For staged
source changes, use `--staged` before staging the reviewed document. The checker
never reads local scratch notes, archived documentation, or unrelated planning
artifacts. The same structural check covers module READMEs under `src/` and
`src-tauri/`; their source fingerprints remain owned by `readme:check`.

The contribution workflow and module README review commands are documented in
[CONTRIBUTING.md](../CONTRIBUTING.md).
