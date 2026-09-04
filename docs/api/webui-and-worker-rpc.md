# WebUI and Worker RPC API
<!-- tinybot-doc-watch:
src-tauri/src/desktop_commands/webui.rs
src-tauri/src/protocol/capability.rs
src-tauri/src/protocol/params.rs
src-tauri/src/rpc/method.rs
src-tauri/src/rpc/runtime.rs
-->
<!-- tinybot-doc-fingerprint: sha256:f7ba40c0c3ab5d698667ad5f0d9cc3c73bb0537d938cb08431be43b3dfe2c148 -->

This document covers the Rust-owned WebUI route wrapper and Worker RPC protocol.
It is part of the [Rust backend API reference](rust-backend-api.md), which
defines the shared invocation conventions and source-backed freshness policy
for this reference set.

## WebUI Route Wrapper

Call:

```ts
const response = await invoke("worker_webui_route", {
  input: {
    method: "GET",
    path: "/api/tools",
    headers: {},
    body: null
  }
});
```

Response:

```json
{
  "status": 200,
  "body": {},
  "headers": {
    "x-tinybot-route-owner": "rust",
    "x-tinybot-route-group": "tools"
  }
}
```

The frontend helper `createDesktopNativeWebuiApi().route()` unwraps 2xx responses and throws for non-2xx responses.
Use `routeResponse()` if the status and headers are needed.

### Rust-owned WebUI Routes

| Method | Path | Group | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/tools` | tools | Effective built-in, MCP, and workspace Agent Graph capability catalog |
| `GET` | `/api/tools/skills/{id}` | tools | Full detail for one cataloged workspace or enabled-plugin Skill |
| `GET` | `/api/providers` | providers | Provider catalog |
| `POST` | `/api/provider-models` | providers | Async provider model resolution, including optional live OpenAI-compatible `GET /models` discovery |
| `POST` | `/api/agent-ui/forms/{form_id}/submit` | agent-ui | Form continuation |
| `POST` | `/api/agent-ui/forms/{form_id}/cancel` | agent-ui | Form cancellation |
| `GET` | `/api/skills` | skills | List skills |
| `POST` | `/api/skills` | skills | Create skill |
| `GET` | `/api/skills/{name}` | skills | Skill detail |
| `PATCH` | `/api/skills/{name}` | skills | Update skill |
| `DELETE` | `/api/skills/{name}` | skills | Delete skill |
| `POST` | `/api/skills/{name}/validate` | skills | Validate skill |
| `GET` | `/api/workspace/files` | workspace | List workspace files |
| `GET` | `/api/workspace/directory` | workspace | Revision-bound directory page; optional query `path` (defaults to `.`), `cursor`, and `nameQuery` |
| `GET` | `/api/workspace/read` | workspace | Revision-bound file chunk; optional query `path` (defaults to `.`) and `cursor` |
| `GET` | `/api/workspace/files/{path:.+}` | workspace | Read workspace file |
| `PUT` | `/api/workspace/files/{path:.+}` | workspace | Write workspace file |

Unknown routes return status `404`.

## Worker RPC Protocol

The lower-level worker RPC router uses this request shape:

```json
{
  "protocol_version": "1",
  "id": "req-1",
  "trace_id": "trace-1",
  "method": "workspace.read_file",
  "params": {
    "path": "README.md"
  }
}
```

It is primarily used internally by Rust command handlers through `call_rust_state_service`.
External callers should usually prefer the Tauri commands above.

The `mcp.config.write` capability belongs to the native Agent's restricted
`mcp.config.*` tools. It does not add a Worker RPC method and does not authorize
the generic `config.apply_operations` method, which continues to require
`config.write`.

### Supported Worker RPC Methods

| Namespace | Methods |
| --- | --- |
| `background.run` | `complete`, `list`, `upsert` |
| `background.subagent` | `enqueue_input` |
| `background.trace` | `append`, `get_artifact`, `get_delegate_trace`, `list` |
| `channel.connector` | `login`, `send_delta`, `send_text`, `send_usage`, `start`, `stop`, `transcribe_audio` |
| `config` | `apply_operations`, `apply_patch_result`, `get`, `snapshot_public` |
| `cron.job` | `add`, `due`, `list`, `record_runs`, `remove` |
| `diagnostics` | `append` |
| `form` | `request` |
| `mcp` | `call_tool`, `capability_catalog`, `diagnostics`, `list_tools`, `server_status`, `shutdown` |
| `permission_profile` | `current`, `evaluate_tool` |
| `provider` | `resolve_secret` |
| `runtime` | `metrics`, `now`, `restart` |
| `shell` | `execute`, `start`, `poll`, `write_stdin`, `resize`, `interrupt`, `terminate`, `terminate_owner`, `list`, `shutdown` |
| `skills` | `list`, `webui_create`, `webui_delete`, `webui_detail`, `webui_list`, `webui_update`, `webui_validate` |
| `subagent` | `cancel`, `close`, `list`, `query`, `resume`, `send_input`, `spawn`, `wait` |
| `task.plan` | `delete`, `get`, `list`, `save` |
| `task.store` | `load` |
| `thread` | `activity`, `agent_registry`, `append_items`, `append_messages`, `append_turn_context`, `apply_op`, `archive`, `clear`, `clear_latest_checkpoint`, `commit_context_checkpoint`, `context`, `continue_turn`, `create`, `delete`, `events`, `fork`, `history`, `interrupt`, `latest_checkpoint`, `list`, `persistence.check`, `persistence.repair`, `read`, `resolve`, `restore_checkpoint`, `resume`, `rollback`, `search`, `start_turn`, `status`, `task_progress.upsert`, `unarchive`, `update_metadata` |
| `thread.turn` | `append_semantic_batch`, `clear_checkpoint`, `get`, `get_checkpoint`, `list`, `mark_cancelled`, `mark_completed`, `mark_failed`, `mark_interrupted`, `runtime_state`, `set_checkpoint`, `start` |
| `tool_executor` | `execute` |
| `tool_registry` | `list`, `search` |
| `tools` | `webui_catalog` |
| `workspace` | `apply_patch`, `create_dir`, `delete_file`, `list_dir`, `list_dir_page`, `list_files`, `read_bootstrap_files`, `read_file`, `read_file_chunk`, `resolve_path`, `write_file` |

`thread.turn.start` atomically appends the minimal turn seed, turn context, changed materialized
instructions, and current user message. `thread.turn.append_semantic_batch` accepts only stable events
that can be materialized as typed message, reasoning, tool, usage, or terminal records;
delta, phase, status, provider-start, and generic trace envelopes are rejected or kept live-only.
Agent-turn reads are derived from the thread JSONL and never fall back to the in-memory thread store.

### MCP Runtime RPC

The Native Runtime owns one long-lived MCP runtime shared by Worker RPC adapters and native agent turns.
Short-lived adapters do not own child processes or HTTP sessions. A configuration update with the
`mcpConfigChanged` side effect reconciles changed, disabled, and removed servers; Native Runtime shutdown
closes HTTP sessions and terminates stdio children before stopping the worker.

Accepted transport values:

- `stdio`: starts the configured command directly without a shell;
- `http`, `streamable_http`, and `streamable-http`: use MCP Streamable HTTP;
- `sse`: rejected; there is no fallback.

Configured server maps are normalized from `tools.mcp_servers`, `tools.mcpServers`, or
`mcp.servers`. All MCP status, discovery, reconciliation, Worker RPC, and native-agent dispatch
paths use the same normalized map.

For a workspace-backed native turn, Tinybot additionally reads `mcp.json`, `.mcp.json`, and
`.github/mcp.json` from the nearest Git root through the effective working directory. Documents may
use a `mcpServers` or `servers` object. Inner scopes override same-named outer or global servers,
relative stdio working directories resolve from the declaring scope, and the merge remains
turn-local. `.codex` is not scanned.

`mcp.capability_catalog` and `GET /api/tools` expose one effective snapshot containing configured
servers, runtime status, discovered tools, allowlist state, callable state, denial reasons, input
schemas, and a separate Skill catalog. Skill entries include enabled Agent Plugin skills and
`.agents/skills/*/SKILL.md` and `.codex/skills/*/SKILL.md` files for the catalog workspace. One failed or disabled server remains
visible without hiding tools from healthy servers. The list contains Skill metadata and paths, not
full documents; `GET /api/tools/skills/{id}` reads the selected `SKILL.md` on demand and returns
`404` when the ID is no longer cataloged. Renderer callers can add a URL-encoded
`workingDirectory` query to either Tools route so workspace entries resolve against the active
conversation directory instead of the configured backend default.

The Tools & Plugins resource page additionally sends `skillScope=allWorkspaces` to both routes.
That scope reads the `WorkspaceRegistry` once, scans every existing imported workspace, and
de-duplicates Skill files by normalized path while preserving same-named files from different
workspaces. Aggregate workspace Skill IDs include the file path so each detail request remains
unambiguous. The `workingDirectory` still scopes MCP, callable Tool, and Agent Graph discovery.
Chat omits `skillScope`, so its slash menu continues to receive only global plugin Skills plus the
active conversation's effective workspace Skills.

When `/api/tools` receives an explicit `workingDirectory`, it also includes one
deferred `agent_graph` tool for each saved Graph whose definition belongs to
that exact canonical workspace. A request without an explicit working
directory receives no Agent Graph tools; this prevents the backend default
workspace from leaking into workspace-less Chat sessions. Each Graph tool
accepts only a non-empty runtime `input` string. Invalid Graph files are skipped
without hiding valid tools or failing the request and are reported in the
top-level `agentGraphDiagnostics` array with their path and parse or validation
error. The Graph management list remains strict.

Stdio configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "local-search": {
        "enabled": true,
        "transport": "stdio",
        "command": "node",
        "args": ["server.js"],
        "env": { "LOG_LEVEL": "info" },
        "envVarRefs": { "SEARCH_API_TOKEN": "TINYBOT_SEARCH_API_TOKEN" }
      }
    }
  }
}
```

`env` may contain non-sensitive process settings. Keys ending in token, secret, password,
authorization, credentials, or API key are rejected when supplied inline. `envVarRefs` maps child
environment names to host environment-variable names and resolves them only at server startup.
Missing, empty, or non-Unicode referenced values fail explicitly without echoing the value.
Snake-case `env_var_refs` is also accepted.

Streamable HTTP configuration example:

```json
{
  "tools": {
    "mcpServers": {
      "docs": {
        "enabled": true,
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerToken": "<token>",
        "httpHeaders": { "X-Tenant": "tinybot" },
        "envHttpHeaders": { "X-Trace-Token": "DOCS_TRACE_TOKEN" },
        "startupTimeoutSeconds": 10,
        "timeoutSeconds": 30,
        "enabledTools": ["search"]
      }
    }
  }
}
```

`bearerToken` stores a bearer token directly in Tinybot's local configuration;
`bearerTokenEnvVar` stores an environment-variable name instead. Configure at most one of them.
`envHttpHeaders` also contains environment-variable names rather than secret values. Missing,
empty, or non-Unicode environment values fail startup explicitly. Direct bearer tokens and
sensitive header values are omitted from public settings and diagnostic projections. URL
credentials and fragments are rejected. Snake-case aliases are accepted for these fields. Plugin
packages should continue to use environment-backed secret fields rather than embedding credentials.

`mcp.list_tools` takes no params and returns enabled servers, normalized real tool schemas, and live
status:

```json
{
  "servers": [
    {
      "name": "docs",
      "status": {
        "state": "ready",
        "transport": "http",
        "toolCount": 4,
        "elapsedMs": 18,
        "lastError": null
      },
      "tools": [{ "name": "search", "inputSchema": { "type": "object" } }]
    }
  ]
}
```

`mcp.call_tool` params and response:

```json
{
  "server": "docs",
  "tool": "search",
  "arguments": { "query": "runtime ownership" }
}
```

```json
{
  "server": "docs",
  "tool": "search",
  "content": [],
  "structuredContent": {},
  "isError": false,
  "result": {}
}
```

The server and tool must be enabled and allowlisted. Discovery and calls support startup/call
timeouts and request cancellation. Cancellation before or during client startup, initialization,
or `tools/list` closes the partial transport, marks the server failed with a cancelled diagnostic,
and stops discovery promptly. Cancellation during an active call uses the same cleanup path. The
next discovery or call starts a clean client.

Additional methods:

- `mcp.server_status` params: `{ "serverId": "docs" }`;
- `mcp.diagnostics`: returns a bounded transition list containing `serverId`, `transport`, `state`,
  `phase`, `elapsedMs`, `errorCode`, and a sanitized `message`;
- `mcp.shutdown`: closes every managed server and returns `{ "stopped": true }`.
