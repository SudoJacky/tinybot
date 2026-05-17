# Agent Runtime

The agent runtime turns user input, session state, tools, memory, skills, and provider responses into a controlled execution loop. Its central design pressure is balancing rich context with bounded token use and predictable tool behavior.

## Ownership

| Concern | Module |
| --- | --- |
| Main interaction loop | `tinybot/agent/loop.py` |
| Single agent run abstraction | `tinybot/agent/runner.py` |
| Context budgeting and assembly | `tinybot/agent/context.py`, `tinybot/agent/dependencies.py` |
| Tool execution and registry | `tinybot/agent/tool_executor.py`, `tinybot/agent/tools/` |
| Streaming and session persistence | `tinybot/agent/stream_handler.py`, `tinybot/agent/session_handler.py`, `tinybot/session/` |
| Skills and prompt sections | `tinybot/agent/skills.py`, `tinybot/templates/agent/` |
| Experience and Agent Memory support | `tinybot/agent/experience*.py`, `tinybot/agent/memory.py` |
| Subagents | `tinybot/agent/subagent.py`, `tinybot/agent/tools/spawn.py` |

## Design Flow

1. The entry point creates or resumes a session.
2. The runtime builds context from system templates, user content, session messages, selected skills, tool schemas, knowledge snippets, and memory/experience signals.
3. The provider returns assistant text and/or tool calls.
4. Tool calls are dispatched through `ToolRegistry` and `ToolExecutor`.
5. Results are fed back into the loop until completion, max-iteration stop, or an error boundary.
6. Session state and stream events are persisted and emitted to the caller.

## Tool Contract

Tools inherit from the base tool abstraction in `tinybot/agent/tools/base.py`. A tool should expose:

- A stable name and description for model selection.
- A JSON-schema-like parameter shape.
- An async `execute` method that returns text or structured data serializable by the caller.
- Clear safety behavior for file, shell, network, or approval-sensitive operations.

Tool logic should be local to the tool unless it is a service-level feature. For example, `cowork_internal` delegates state changes to `CoworkService` rather than mutating cowork sessions directly.

## Context Design

Context is assembled with a budget. New context sources should answer three questions:

- Is this source always needed, or should it be opt-in?
- Can the source be summarized or capped?
- Does the source contain untrusted content that needs template isolation?

Long-lived memory and experience features should be treated as advisory context. They should not silently override current user instructions or repository state.

## Agent Memory

Agent Memory is owned by `tinybot/agent/memory.py`. Durable memory is stored as structured Memory Notes in `memory/notes.jsonl`; the Markdown files `memory/MEMORY.md`, `USER.md`, and `SOUL.md` are Memory Views for inspection and prompt compatibility.

Memory Notes carry type, status, priority, confidence, source trace-back, timestamps, and lifecycle links. Only active notes participate in default recall and managed Memory View rendering. Rejected and superseded notes remain in JSONL for debugging and traceability.

Dream is the background capture path for durable conversation facts. Explicit memory tools are the foreground path for user or agent corrections. Both paths write Memory Notes before refreshing Memory Views, so direct edits inside managed Markdown sections should be treated as temporary and overwritten by the next refresh.

Memory Recall is a distinct context section selected from active Memory Notes. It stays separate from Experience, which records reusable execution guidance, and from Knowledge, which provides document evidence. Optional vector indexing may accelerate Memory Note search, but JSONL remains the canonical source and indexes must be rebuildable from it.

## Extension Points

- Add a new tool under `tinybot/agent/tools/` and register it through the existing registry path.
- Add a new provider by implementing `LLMProvider` and exposing it through `tinybot/providers/registry.py`.
- Add a new context source by extending the context assembly path and adding tests for budget behavior.
- Add a new skill as Markdown under `tinybot/skills/` when the behavior is instruction-like rather than runtime code.

## Test Strategy

Use `tests/agent/` for loop, context, tool executor, stream, knowledge, memory, and experience behavior. For new tools, prefer focused unit tests around schema shape, parameter handling, and service interaction.
