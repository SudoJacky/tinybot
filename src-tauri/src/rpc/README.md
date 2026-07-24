# Worker RPC Router

`rpc` is the versioned method-routing boundary for native backend services.
The module root is `mod.rs`; protocol envelopes and parameter validation live
in the sibling `protocol/` module.

## Responsibilities

- Validate every `WorkerRequest` before dispatch.
- Route stable method namespaces to the service that owns the operation.
- Parse method parameters into typed request structures.
- Return exactly one correlated `WorkerResponse` with either `result` or
  `error`.
- Preserve capability checks, approval boundaries, cancellation handles, and
  trace correlation while composing multiple services.
- Provide compatibility facades where session- and Thread-backed data must be
  merged for existing callers.

The router should coordinate services, not become the implementation of every
service. `workspace/`, `tools/`, `threads/`, and `memory/` own their domain
behavior.

## Dispatch flow

1. `WorkerRpcRouter::dispatch` validates protocol version and request shape.
2. `dispatch_result` chooses a dispatch group from the method prefix.
3. The group parses `params`, calls the owning service, and serializes its
   typed result.
4. Success and failure are wrapped with the original request ID and trace ID.
5. Unknown methods return a structured protocol error that includes the
   classified namespace.

Method families currently include workspace/skills, configuration/provider,
session persistence, Thread persistence, agent turns, interactions, memory,
background work, subagents, tools/MCP/permissions, and runtime operations.

## Internal layout

- `../protocol/params.rs`: request validation and typed parameter parsing.
- `method.rs`, `errors.rs`: namespace classification and unknown-method errors.
- `workspace_dispatch.rs`, `config_dispatch.rs`: workspace, skills,
  configuration, and provider-secret requests.
- `persistence_facade.rs`, `thread_dispatch.rs`: session, agent-turn, and typed
  Thread methods, including compatibility projections.
- `interaction_dispatch.rs`, `approval.rs`, `form.rs`, `channel.rs`: shell,
  approval, form, diagnostics, and channel interactions.
- `memory_dispatch.rs`, `background_dispatch.rs`, `subagent_dispatch.rs`:
  durable background and collaboration services.
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
   persistence or approval behavior specific to the method.
7. Document frontend-visible methods in
   `docs/api/rust-backend-api.md` rather than duplicating the full payload here.

## Invariants

- Request and trace IDs in a response match the request.
- Protocol failures, capability denials, and service failures remain distinct
  structured errors.
- Unknown methods fail explicitly; dispatch must not silently no-op.
- Sensitive operations keep their approval and sandbox validation boundary.
- Session/Thread compatibility reads may merge projections, but canonical
  writes still go through the owning persistence service.
- Shared runtimes such as shell and MCP must be injected rather than recreated
  per request.
