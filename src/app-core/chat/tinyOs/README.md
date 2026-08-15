# TinyOS Runtime Contract
<!-- tinybot-module-fingerprint: sha256:6d7ab0972eb1d40fe81de8da8449a7fb52a7855d5963284de6f772528f4b101c -->

TinyOS presents workspace files, retained terminal executions, the managed
browser session, generated artifacts, and Agent activity as one desktop shared
by the user and Agent. Both participants operate on the same underlying
workspace objects. TinyOS is a product projection of canonical Thread and
native runtime state, not a second persistence authority.

## Contract layering

`tinyOsKernelContracts.ts` owns the shared provenance, process-state, and
resource-access vocabulary. Native snapshot types and the kernel projection
depend on those contracts independently, so native observations never need to
import the higher-level kernel model. `tinyOsKernelModel.ts` remains the owner
of projected process, resource, history, and simulation behavior.

Canonical timeline items and UI turn shapes live in the sibling
`chatTurnContracts.ts`. TinyOS models import those types directly, so their
contract dependency does not load chat payload validation or projection code.

## Chat references

TinyOS transfers selected context through the canonical user-message
`references` array. File, terminal, and plan references retain their source
identity and appear as stable chips after reload. Immediately before a provider
request, `tinyos.*` references are appended to provider-only user content inside
an untrusted-evidence block; stored and visible message text is unchanged.

One message may carry at most 16 TinyOS references and 64 KiB of serialized
reference data. Exceeding either limit fails the request instead of silently
dropping context.

## Agent controls

Pause and resume target the same active Turn. Pause is cooperative and becomes
effective at a safe provider/tool boundary. Resume restores the prior runtime
phase. Cancellation remains available while paused.

Form submission and cancellation target the persisted pending checkpoint.
Completion is represented by a correlated `agent.form.resolution` item.

`operation.retry` separates the new target Turn from the failed source Turn and
item. Reused target IDs, stale sources, and non-failed sources are rejected. A
valid retry hydrates existing Thread history into the new Turn.

`agent.request_change` starts a new live Turn grounded in 1–16 structured file,
terminal, or plan references. It requires a non-empty instruction, enforces the
64 KiB reference bound, and rejects stale observed state or an already-active
Turn. A request made from historical context never mutates the historical
snapshot.

## Historical context

Canonical history indexes raw item revisions as exact event boundaries.
Opening historical context passes its event index with Turn and item identity;
identity mismatch is an error. Native snapshots observed after that boundary do
not leak into the historical view.

Runtime-mutating commands are denied in historical context with
`reasonCode: "history_read_only"`. Return to Live reevaluates current backend
capabilities instead of retaining historical availability.

## Controlled host actions

Controlled actions use `tinybot.command.v1` and dedicated `tinyos-host-*`
operation identities:

| Action | Required data |
| --- | --- |
| `file.save` | `path`, `content`, `create_only`, `confirmed`, and `base_revision` for an existing file |
| `file.move` | source `path`, `target_path`, `base_revision`, and `confirmed` |
| `file.delete` | `path`, `base_revision`, and `confirmed` |
| `terminal.execute` | exact `command` and optional `cwd` |
| `terminal.cancel` | running `tinyos-host-terminal-*` operation |
| `browser.interact` | browser session, tab, control epoch, current observation/capture identity, confirmation, and typed action |

File writes are workspace-bound and revision-guarded. Existing targets,
changed source revisions, and invalid paths fail visibly. Successful and failed
attempts are persisted as canonical host operations.

## Retained terminal execution

TinyOS Terminal uses `retained_execution_v1`. Each command creates one non-TTY
execution; working directory, command history, and foreground process state do
not carry implicitly to the next command.

Output streams through canonical Tool updates, is retained in a bounded tail,
and is sanitized before persistence. Results include process identity,
execution contract, TTY state, exit code, timestamps, duration, byte counts,
truncation, and dropped-byte information. Cancellation targets the correlated
process. After restart, an active persisted host operation without a matching
live process becomes an explicit interrupted-recovery failure.

## Managed browser

TinyOS Browser renders the live managed WebView2 session shared with the Agent.
It does not substitute a timeline raster or stale capture when the native
surface is unavailable. Browser session ownership, control epochs, observations,
protected handoff, profiles, privacy, and cleanup are documented in
[`src-tauri/src/native_browser/README.md`](../../../../src-tauri/src/native_browser/README.md).
