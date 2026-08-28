# Worker RPC Router
<!-- tinybot-module-fingerprint: sha256:5ef0ef53427119ba751c4c6012be4252aa386c40c4109c6f9cd487dc42a5ebca -->

`rpc` is the versioned method-routing boundary for native backend services.
The module root is `mod.rs`; protocol envelopes and parameter validation live
in the sibling `protocol/` module.

## Responsibilities

- Validate every `WorkerRequest` before dispatch.
- Route stable method namespaces to the service that owns the operation.
- Parse method parameters into typed request structures.
- Return exactly one correlated `WorkerResponse` with either `result` or
  `error`.
- Preserve capability availability checks, cancellation handles, and trace
  correlation while composing multiple services.

The router should coordinate services, not become the implementation of every
service. `workspace/`, `tools/`, and `threads/` own their domain
behavior.

Desktop boundaries that already resolved an authoritative workspace may build
a router with that explicit root. The Thread Artifact preview command uses
this narrow constructor after loading the canonical Thread projection; path
containment and file reads still belong to the workspace service.

## Dispatch flow

1. `WorkerRpcRouter::dispatch` validates protocol version and request shape.
2. `dispatch_result` chooses a dispatch group from the method prefix.
3. The group parses `params`, calls the owning service, and serializes its
   typed result.
4. Success and failure are wrapped with the original request ID and trace ID.
5. Unknown methods return a structured protocol error that includes the
   classified namespace.

Method families currently include workspace/skills, configuration/provider,
Thread persistence, agent turns, interactions, background work, subagents,
tools/MCP/permissions, and runtime operations.

## Internal layout

- `../protocol/params.rs`: request validation and typed parameter parsing.
- `method.rs`, `errors.rs`: namespace classification and unknown-method errors.
- `workspace_dispatch.rs`, `config_dispatch.rs`: workspace, skills,
  configuration, and provider-secret requests.
- `turn_dispatch.rs`, `thread_dispatch.rs`: agent-turn persistence and typed
  Thread methods.
- `interaction_dispatch.rs`, `form.rs`, `channel.rs`: shell, form,
  diagnostics, and channel interactions.
- `background_dispatch.rs`, `subagent_dispatch.rs`: durable background and
  collaboration services.
- `tool_dispatch.rs`, `mcp.rs`: tool registry/execution, permission profiles,
  and shared MCP state.
- `runtime_dispatch.rs`, `runtime.rs`: runtime metrics and restart operations.

## Adding a method

1. Put domain behavior in the owning service module.
2. Add a typed params/result shape near that service or protocol boundary.
3. Add the method to the narrowest existing dispatch group.
4. Parse with the shared protocol helper; do not manually accept malformed
   payloads.
5. Ensure the service performs its capability check.
6. Add router coverage for success, invalid params, capability denial, and any
   persistence behavior specific to the method.
7. Document frontend-visible methods in the
   [WebUI and Worker RPC API](../../../docs/api/webui-and-worker-rpc.md) rather
   than duplicating the full payload here.

## Invariants

- Request and trace IDs in a response match the request.
- Protocol failures, capability denials, and service failures remain distinct
  structured errors.
- Unknown methods fail explicitly; dispatch must not silently no-op.
- Tool methods validate typed parameters, capability grants, and availability
  before dispatch.
- Runtime-control and Agent Graph targets stay owned by the Agent runtime's
  asynchronous dispatcher and are rejected by the generic Worker RPC tool
  executor.
- Thread creation pins its API mode from an explicit
  `metadata.extra.modelProvider`; only requests without one fall back to the
  active provider profile. Later turns must match that pinned mode.
- Shared runtimes such as shell and MCP must be injected rather than recreated
  per request.
