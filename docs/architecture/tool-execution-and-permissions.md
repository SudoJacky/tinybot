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
<!-- tinybot-doc-fingerprint: sha256:7f310617d2bc7eb6986a4a0b2b45cf3a0db75606e7914e52f9a1ce64f7485f53 -->

Tinybot exposes one protocol-neutral tool registry to the Agent Runtime. Tool
metadata, per-Turn exposure, capability policy, execution routing, lifecycle,
and result projection remain separate concerns joined through narrow seams.

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
    |-- validate and prepare arguments
    |-- plan parallel read waves and exclusive mutation waves
    v
Injected dispatcher
    |-- runtime-control tool
    |-- Worker RPC tool executor
    |-- MCP runtime
    |-- native browser
    |-- shell or subagent adapter
    v
Typed result + runtime events + durable projection
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

Ordered contributors assemble built-in, workspace, MCP, runtime-control, and
eligible project-group tools. Duplicate contributor IDs, tool IDs, or methods
fail registry construction.

## Exposure and availability

- `model` tools are visible to the provider when available.
- `deferred` tools become visible only after backend policy activates them for
  the Turn.
- `direct` and `hidden` tools are not provider-visible.
- A tool is available only when its required capabilities are granted and its
  configuration enables it.

Provider-specific adapters encode the same tool definitions into their wire
format. They do not own registry policy or permission decisions.

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

Project-coordinator Turns intentionally have no local workspace or shell
authority. Their persistent cross-workspace Thread tools perform separate
project-group authorization before targeting a workspace.

## Execution and cancellation

The runtime rejects an entire provider tool-call batch before execution when
any call is not permitted. Prepared calls are then scheduled according to
registry policy: compatible read-only calls may run in parallel, while
workspace or session mutations form exclusive waves.

Cancellation behavior is part of the registry entry. Tools may cooperate,
terminate an owned process, or require bounded cleanup. A timeout, cancellation,
runtime failure, and ordinary tool error remain distinct outcomes so the model,
trace, and terminal Turn state do not report false success.

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

## Source modules and verification

- [Agent runtime](../../src-tauri/src/agent/runtime/README.md)
- [Tool registry](../../src-tauri/src/tools/registry/README.md)
- [Tool permissions](../../src-tauri/src/tools/permissions/README.md)
- [Workspace module](../../src-tauri/src/workspace/README.md)
- [RPC router](../../src-tauri/src/rpc/README.md)
- [Backend interface reference](../api/rust-backend-api.md)
