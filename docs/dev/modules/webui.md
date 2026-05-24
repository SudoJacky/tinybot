# WebUI

The WebUI is a static frontend served by the gateway. It is intentionally close to the gateway API contract: the frontend renders snapshots and sends explicit control commands rather than reimplementing backend state machines.

## Ownership

| Concern | Files |
| --- | --- |
| HTML shell | `webui/index.html` |
| Legacy application logic | `webui/assets/src/legacy/app.js` |
| Modular JS entry/state/helpers | `webui/assets/src/` |
| Styles | `webui/assets/styles.css`, `webui/assets/styles/` |
| Generated docs output | `webui/docs/` |
| Source docs | `docs/` |
| Docs builder | `scripts/build_docs.py` |
| Browser HTTP control plane | `tinybot/api/webui.py` |
| WebSocket transport/static gateway | `tinybot/channels/websocket.py` |

## Design Shape

The WebUI combines chat, settings, knowledge, skills, workspace file editing, and Cowork. State is mostly browser-side view state backed by gateway snapshots. Durable domain state should remain in Python services.

For complex surfaces such as Cowork, the UI should render backend projections: graph, trace, artifact index, scheduler decisions, work queues, and completion decisions. Avoid deriving business state in JavaScript when the backend can expose it explicitly and test it.

## Control Plane

Browser HTTP operations are registered by `tinybot/api/webui.py` through `register_webui_control_routes()`. The registrar receives a `WebUIControlRuntime` with explicit dependencies: token manager, workspace, session manager, agent loop, config object/path, knowledge store, Cowork service/tool, and callbacks such as global WebSocket broadcast.

Protected WebUI control routes use the same browser token manager as the WebSocket endpoint. Public bootstrap and token-refresh routes stay public to loopback requests; session, status/tools, approvals, workspace files, skills, config/provider-models, and Cowork controls require a valid browser token.

Cowork WebUI routes delegate to the shared `tinybot/api/cowork.py` handlers through a WebUI authorization wrapper. The wrapper prepares the app runtime expected by the shared handlers and keeps WebSocket broadcasts for Cowork updates attached to the current gateway runtime.

## Agent UI Event Stream

The home-page chat surface normalizes legacy WebSocket frames into tinybot-owned Agent UI events in `webui/assets/src/agent-ui-events.js`. The browser still receives compatible frames such as `delta`, `message`, `stream_end`, `approval_pending`, `browser_frame`, `usage`, `file_updated`, `error`, and `cowork_updated`; the normalized event model is an internal browser contract used before updating live UI state.

Agent UI events flow through three layers:

- `normalizeAgentUiEvents()` maps legacy transport frames into versioned, JSON-safe event envelopes.
- `reduceAgentUiEventState()` updates browser-owned live state for streaming text, reasoning, tool runs, approvals, browser frames, references, usage, and transient errors.
- the fixed renderer registry in `legacy/app.js` routes known surfaces to existing DOM renderers for messages, reasoning, tool runs, approval refreshes, browser snapshots, memory references, recent-context references, usage status, and error notices.

The renderer registry is an allowlist created by local code at startup. Model or agent output must not register renderers, supply executable component definitions, inject raw DOM, or provide scripts/styles. Unknown Agent UI event types should be ignored or surfaced as safe diagnostics without breaking known controls.

Cowork remains outside this home-page Agent UI event protocol. Cowork rendering continues to use its existing HTTP snapshots, projections, and `cowork_updated` refresh signal.

### Dynamic Form Requests

Agent UI dynamic forms collect structured user input for the home-page chat surface. The agent owns the data need: title, safe field definitions, correlation ids, expiry, and optional continuation mode. The WebUI owns rendering and interaction behavior: field widgets, layout, escaping, validation display, submit/cancel controls, disabled states, and reload restoration.

The canonical runtime schema is tinybot's internal Agent UI form request, validated in `tinybot/agent/forms.py`. It allows only the fixed field set: `text`, `textarea`, `number`, `select`, `multiselect`, `checkbox`, `radio`, `date`, `time`, `datetime`, and `file_path`. The schema validator rejects unsafe keys such as raw HTML, scripts, styles, DOM instructions, component definitions, renderer registration, and event handlers. The browser normalizer repeats the same safety posture before reducing events into `state.agentUi.forms`.

Forms render through the fixed `formRequest` renderer surface. Model output cannot register a renderer, replace the renderer, supply component implementations, or inject HTML/CSS/JS through labels, descriptions, options, help text, or errors. Browser-side validation is ergonomic only; backend validation remains authoritative.

Submissions and cancellations are HTTP control operations:

- `POST /api/agent-ui/forms/{form_id}/submit`
- `POST /api/agent-ui/forms/{form_id}/cancel`

Both routes live in `tinybot/api/webui.py`, require the browser token, check session/chat/run/message/interaction correlation, verify pending registry state, enforce expiry, and emit form lifecycle events for browser synchronization. The pending interaction registry remains authoritative for whether an action is accepted. Session messages may carry `_agent_ui_form_display` metadata so a pending or completed form card can be restored after reload, but the transcript is display metadata, not the continuation authority.

The first continuation modes are explicit:

- `structured_message` records a structured user message in the correlated session when no live paused interaction is available.
- `resume` requires an agent loop with `schedule_form_response()` and rejects the action if that continuation target is missing.

Dynamic forms do not approve tools or grant safety permissions. A submitted form can provide parameters to the agent, but risky tool authorization still flows through approval records and approval routes. Form continuation metadata should not be interpreted as approval scope.

Future AG-UI compatibility should be layered as an adapter around the tinybot event envelope. Keep AG-UI optional: translate to or from the internal event shape at the boundary, do not make the browser depend on an external SDK before the local normalizer, reducer, and renderer registry contract is stable.

Future A2UI adapters should map the internal form request to an adapter surface at the boundary: form request to surface/message, fields to the allowed component subset, submitted values to data model updates, and submit/cancel to actions. Do not make A2UI a required dependency or accept arbitrary A2UI component trees as tinybot's canonical runtime contract.

## API Coupling

The frontend should depend on stable API fields, not internal Python class names. When a field is added for UI needs, add it to the API snapshot and cover it in API tests.

For Cowork, especially preserve:

- `completion_decision`
- `final_draft`
- `agent_steps`
- `trace_spans`
- `artifact_index`
- `scheduler_decisions`
- `run_metrics`
- branch and branch result summaries

## Documentation Build

`scripts/build_docs.py` builds selected Markdown files from `docs/` into `webui/docs/`. It uses a fixed navigation list and does not currently build nested developer docs under `docs/dev/`.

That separation is intentional for now: `docs/dev/` is maintainer documentation and should not appear in the public WebUI docs unless deliberately exposed later.

## Validation

Run JavaScript syntax checks after frontend edits:

```bash
node --check webui/assets/src/legacy/app.js
```

Run the focused Agent UI browser smoke test after normalizer, reducer, or renderer-registry edits:

```bash
node webui/assets/src/agent-ui-events.test.mjs
```

For layout or interaction changes, also run the gateway and inspect the affected route. API tests are still needed when frontend changes depend on new backend payloads.

For WebUI control-plane changes, prefer focused `tests/api/test_webui.py` coverage that registers an aiohttp app without constructing a full `WebSocketChannel`. Keep `tests/channels/test_websocket.py` for transport behavior and mount smoke checks.

Dynamic form coverage lives across `webui/assets/src/agent-ui-events.test.mjs`, `tests/agent/test_forms.py`, `tests/api/test_webui.py`, `tests/channels/test_websocket.py`, and the focused AgentLoop continuation tests in `tests/agent/test_loop.py`.
