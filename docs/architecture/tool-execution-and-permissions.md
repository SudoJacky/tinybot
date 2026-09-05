# Tool Execution and Permissions
<!-- tinybot-doc-watch:
src-tauri/src/agent/bridge/tool_dispatcher.rs
src-tauri/src/agent/runtime/README.md
src-tauri/src/agent/runtime/tool_router.rs
src-tauri/src/agent/runtime/tool_runtime.rs
src-tauri/src/tools/executor.rs
src-tauri/src/tools/permissions/README.md
src-tauri/src/tools/permissions/mod.rs
src-tauri/src/tools/registry/README.md
src-tauri/src/tools/registry/mod.rs
src-tauri/src/workspace/README.md
-->
<!-- tinybot-doc-fingerprint: sha256:b5cdecb5a15bca338405547c20652ac6154de9fb95d7202732e4fdb9fbe60ee3 -->

Tinybot exposes one protocol-neutral tool registry to the Agent Runtime. Tool
metadata, per-Turn exposure, capability policy, execution routing, lifecycle,
and result projection remain separate concerns joined through narrow seams.

The independent first-Turn title request reuses the Agent Runtime's Provider
request and response adapters without entering the Agent Loop. It never receives
the tool registry and remains a single tool-free Provider call.

## Tool flow

```text
Tool contributors
    |
    v
Registry entries + capability/config availability
    |
    v
Per-Turn selection and deferred activation
    |
    v
Provider adapter encodes visible tool definitions
    |
    v
Model tool-call batch
    |-- resolve provider name
    |-- reject any disallowed call before batch execution
    |-- prepare arguments or return one error result per call ID
    |-- run trusted PreToolUse hooks (deny or replace arguments)
    |-- plan parallel read waves and exclusive mutation waves
    v
Injected dispatcher
    |-- runtime-control tool
    |-- workspace Agent Graph Run
    |-- Worker RPC tool executor
    |-- MCP runtime
    |-- native browser
    |-- shell or runtime-only subagent control adapter
    v
Typed result + runtime events + durable projection
    |-- run trusted PostToolUse hooks (model feedback/context only)
    |
    v
Next provider iteration
```

## Registry Interface

Every registry entry declares:

- stable tool ID, method, namespace, title, and description;
- provider-visible input schema and backend output shape;
- exposure: `model`, `deferred`, `direct`, or `hidden`;
- required capabilities and current availability;
- execution target;
- parallelism, mutation, cancellation, and cleanup policy.

Provider-visible schemas describe nested argument contracts, not only their
top-level names. For example, `publish_data_view` exposes the supported view
kinds and requires table `defaultSort` to use `{field, direction}` so providers
can construct the same shape the native validator accepts.

Ordered contributors assemble built-in, workspace, MCP, runtime-control, and
eligible project-group tools. For ordinary workspace-backed Chat Turns, they
also assemble one deferred tool per saved Agent Graph in that exact canonical
working directory. The configured backend workspace fallback alone does not
make a Turn workspace-backed. Per-file Graph parse or validation failures are
diagnosed and skipped at this discovery boundary so valid tools remain usable;
Graph management operations retain strict validation. Duplicate contributor
IDs, tool IDs, or methods fail registry construction.

## Exposure and availability

- `model` tools are visible to the provider when available.
- `deferred` tools become visible only after backend policy activates them for
  the Turn.
- `direct` and `hidden` tools are not provider-visible.
- A tool is available only when its required capabilities are granted and its
  configuration enables it.

Provider-specific adapters encode the same tool definitions into their wire
format. They do not own registry policy or permission decisions.

The MCP capability catalog keeps four states separate: runtime `available`,
policy/config `allowed`, initial `defaultSelected`, and current UI `selected`.
Its length-prefixed IDs are opaque and are reused unchanged when a Turn creates
concrete MCP registry entries. The generic deferred `mcp.call_tool` fallback is
not selected by default; a concrete MCP selection suppresses it defensively.

## Permission enforcement

The active permission profile supplies a `CapabilityPolicy`. The registry uses
that policy to mark tools available, and the executor evaluates the registered
tool again before performing the protected operation. Permission evaluation
reports missing capabilities and normalized filesystem, network, process, and
session effects.

This is an allow/deny capability model. A denied or unavailable tool fails
explicitly; it is not executed through a fallback path. Workspace path guards,
MCP allowlists, and service-specific authorization remain enforced by the
owning execution module after generic capability checks.

Model-visible subagent lifecycle tools use their registered dotted methods and
the Worker RPC executor so lifecycle changes restore from and commit to the
canonical Thread store. The direct subagent adapter is limited to the
runtime-only `subagent.query` and `subagent.cancel` controls. Unregistered
alternative tool names are rejected instead of being normalized into that
fallback path.

MCP discovery and calls are keyed by the Turn's effective working directory,
not Tinybot's backend state directory. WebUI and Turn preparation use the same
revisioned registry snapshot for that workspace and effective MCP configuration.
Each Turn captures it atomically before provider dispatch. Discovery runs per
server; a failure preserves same-configuration last-known-good definitions as
unavailable metadata or disables only that server when no prior definitions
exist.

Global MCP configuration is a separate, narrow capability. `mcp.config.list`
returns a redacted projection, while `mcp.config.upsert` accepts only typed
stdio or Streamable HTTP fields and requires the revision from the latest
list. Literal credentials are excluded from its schema. Successful writes are
reconciled against the shared runtime and connection failures remain distinct
from persistence success. No model-visible tool routes arbitrary
`config.apply_operations` requests.

Agent Graph execution uses a bound registry target containing the definition
workspace, Graph ID, and revision. The provider can supply only a non-empty
runtime `input`, so it cannot redirect a call to another Graph or workspace.
The dispatcher waits for completion and projects only the Graph's final output
as model-visible content while retaining the Run ID and status in structured
tool data. Graph node Turns suppress Graph contributors to prevent recursion;
parent cancellation propagates into the active Run.

Project-coordinator Turns intentionally have no local workspace or shell
authority. Their persistent cross-workspace Thread tools perform separate
project-group authorization before targeting a workspace.

Trusted command hooks are user automation, not Agent tools. Their processes
inherit the desktop user's operating-system authority and are outside the
`CapabilityPolicy` sandbox, which is why definitions are disabled until their
exact hashes are reviewed. A `PreToolUse` replacement does not bypass the tool
executor: the owning module still validates the final arguments and protected
effects at execution time.

## Execution and cancellation

The runtime rejects an entire provider tool-call batch before execution when
any call is not permitted. Prepared calls are then scheduled according to
registry policy: compatible read-only calls may run in parallel, while
workspace or session mutations form exclusive waves. A provider response that
contains several calls does not require simultaneous dispatch: the runtime,
not the provider, owns their concrete schedule. An exclusive classification is
therefore an ordering barrier rather than a rejection. In particular,
`update_plan` may share a batch with ordinary tools; it updates the Turn plan
alone, then the scheduler continues with later waves in model order.

Provider-authored argument preparation is also a recoverable batch boundary.
If any call contains malformed JSON or a non-object argument, no call in that
batch is dispatched. The invalid call retains its parser error, otherwise-valid
calls receive an explicit batch-rejection error, and every provider call ID is
committed as a model-visible tool result before the next provider iteration.

`request_user_input` is a checkpointed interaction rather than a long-running
tool execution. A valid request ends the active invocation in `awaiting_form`
without a human-response timeout. Submit resumes the same provider chain with
the selected values as the original tool call's result; cancel resolves the
checkpoint with a distinct cancelled outcome.

Cancellation behavior is part of the registry entry. Tools may cooperate,
terminate an owned process, or require bounded cleanup. A timeout, cancellation,
runtime failure, and ordinary tool error remain distinct outcomes so the model,
trace, and terminal Turn state do not report false success.

`PostToolUse` runs only after dispatch completes. Blocking feedback replaces
the model-visible observation and cannot roll back workspace, process, network,
or session side effects. Hook-added context is emitted after the complete tool
result block so both Chat Completions and Responses preserve call/result
pairing.

## Invariants

- All model-requested execution crosses the runtime dispatcher.
- Tool IDs and tool-call IDs remain stable across provider, runtime, executor,
  trace, and persistence seams.
- Capability checks occur at or below the module performing the protected
  operation.
- Provider adapters cannot widen tool visibility.
- Model-visible output is bounded independently from richer live projection
  data.
- A tool batch is fully recorded before the next provider request.
- Every provider tool-call ID has exactly one model-visible result, including
  pre-dispatch batch rejection.
- User command hooks cannot widen registry exposure or capability grants.

## Source modules and verification

- [Agent runtime](../../src-tauri/src/agent/runtime/README.md)
- [Tool registry](../../src-tauri/src/tools/registry/README.md)
- [Tool permissions](../../src-tauri/src/tools/permissions/README.md)
- [Workspace module](../../src-tauri/src/workspace/README.md)
- [RPC router](../../src-tauri/src/rpc/README.md)
- [Tools and processes API](../api/tools-and-processes.md)
