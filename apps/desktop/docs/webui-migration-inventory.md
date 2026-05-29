# WebUI Migration Inventory

This inventory tracks the staged migration from the gateway-hosted WebUI to desktop-native modules. The existing WebUI remains the behavior reference until each module has explicit parity coverage.

| Area | Existing source of truth | Desktop status | Blockers | Parity notes |
| --- | --- | --- | --- | --- |
| Startup and global state | `webui/assets/src/main.js`, `webui/assets/src/state.js`, `webui/assets/src/legacy/app.js` | Parity path | Full manual side-by-side workflow pass is still pending. | Desktop now starts with a bootstrap gate, detects or starts the local gateway through existing Tauri commands, injects the WebUI shell, and then loads the existing WebUI entry module. |
| Protocol, API, and WebSocket | `tinybot/api/webui.py`, `tinybot/channels/websocket.py`, `webui/assets/src/legacy/app.js` | Parity path | Full manual side-by-side workflow pass is still pending. | Desktop installs a focused fetch/WebSocket bridge for `/webui/*`, `/api/*`, `/v1/knowledge/*`, and `/ws`, leaving static, docs, third-party, and unrelated requests on the desktop origin. Adapter tests cover gateway rewrites, token refresh, request semantics, non-gateway requests, and WebSocket query preservation. |
| Sessions and chat | `webui/assets/src/legacy/app.js`, `/api/sessions`, `/ws` | Started | Agent UI forms, tool progress details, approvals, files, and cowork inserts still depend on hosted WebUI or later native slices. | Native desktop now loads sessions and message history, sends messages over the shared WebSocket client, handles deltas, stream completion, and interrupt state. Tests compare the same gateway payload shapes used by the hosted WebUI. |
| Agent UI and browser frames | `webui/assets/src/agent-ui-events.js`, `webui/assets/src/agent-ui-event-fixtures.js`, `webui/assets/src/legacy/app.js` | Started | Tool progress details, approvals, and richer message insertions still depend on hosted WebUI or later native slices. | Desktop has a native Agent UI compatibility reducer, renders browser frames/snapshots and form requests, submits/cancels forms through existing routes, and uses parity fixtures based on the WebUI event fixture shapes. |
| Tools, skills, settings, and providers | `webui/assets/src/provider-cards.js`, `webui/assets/src/legacy/app.js`, `/api/config`, `/api/tools`, `/api/skills` | Started | Editing advanced config and skill CRUD still depend on hosted WebUI. | Native desktop loads settings overview, provider cards, tools, and skills from existing gateway routes; Hosted WebUI remains the fallback for mutation-heavy flows. |
| Knowledge | `webui/assets/src/knowledge-traceability.js`, `tinybot/api/knowledge.py`, `/v1/knowledge/*` | Started | Graph, query, and traceability details remain in hosted WebUI until their native slice is migrated. | Native desktop loads knowledge stats and document overview before graph and traceability. |
| Workspace files | `webui/assets/src/legacy/app.js`, `/api/workspace/files` | Started | Uploads, temporary session files, and richer conflict UI remain in hosted WebUI. | Native desktop lists editable workspace files, loads file content, and saves through the existing version-aware PUT route. |
| Cowork | `webui/assets/src/cowork-chat.js`, `tinybot/api/cowork.py`, `/api/cowork/*` | Started | Full graph, mailbox, trace, and agent activity panels remain in hosted WebUI. | Native desktop lists Cowork sessions and loads the existing summary endpoint as the first native Cowork slice. |
| i18n, theme, help, and docs | `webui/assets/src/i18n/*`, `webui/docs/*`, `webui/assets/docs.js` | Parity path | Full manual docs navigation pass is still pending. | Desktop exposes repository `webui/docs` at `/docs/*` through Vite dev/preview/build and loads the same i18n modules through `/assets/src/i18n/*`. |
| Styles | `webui/assets/styles.css`, `webui/assets/styles/*` | Parity path | Full visual comparison is still pending. | Desktop exposes repository `webui/assets` at `/assets/*`, injects WebUI stylesheet links from `webui/index.html`, and bundles Markdown/highlight dependencies locally instead of using CDN links. |

## Desktop WebUI Parity Path

- `apps/desktop/index.html` is now a compact startup shell only. It no longer loads the simplified desktop-native dashboard by default.
- `apps/desktop/src/desktopBootstrap.ts` waits for `/webui/bootstrap`, starts the gateway through existing Tauri runtime commands when needed, installs render globals and gateway routing, injects the existing WebUI shell, and imports `/assets/src/main.js`.
- `apps/desktop/src/main.ts` and the native preview modules remain available as fallback/reference code during migration, but they are not on the default desktop route.
- `apps/desktop/src/desktopGatewayBridge.ts` rewrites only known gateway control-plane HTTP paths and `/ws` WebSocket URLs to `http://127.0.0.1:18790` / `ws://127.0.0.1:18790`. The WebSocket rewrite handles both relative `/ws?...` and the absolute `ws://<desktop-host>/ws?...` URLs produced by the existing WebUI `websocketUrl()` helper.
- `apps/desktop/vite.config.ts` exposes `webui/assets` and `webui/docs` at WebUI-compatible public paths in development, preview, and production builds.
- Intentional difference: the desktop shell shows a small recoverable startup error with retry before WebUI initialization when the gateway cannot be reached. The gateway-hosted WebUI does not need this preflight state because it is served by the gateway itself.

## Source Of Truth Strategy

The desktop migration should keep copying behavior from these existing WebUI files before introducing desktop-native replacements:

| Desktop concern | WebUI source to mirror | Current desktop approach |
| --- | --- | --- |
| Shell DOM, IDs, modals, control structure | `webui/index.html` | Imported as raw HTML and injected after gateway readiness. |
| Startup order, i18n, global app init | `webui/assets/src/main.js` | Loaded directly from `/assets/src/main.js` after desktop adapters are installed. |
| Chat, sessions, approvals, temporary files, settings, skills, knowledge, workspace, browser, Cowork | `webui/assets/src/legacy/app.js` | Runs unchanged against the desktop origin; bridge routes its gateway requests and WebSocket to the local gateway. |
| Agent UI event reduction/rendering | `webui/assets/src/agent-ui-events.js` | Served through `/assets/src/agent-ui-events.js` and consumed by existing WebUI imports. |
| Cowork chat state/render helpers | `webui/assets/src/cowork-chat.js` | Served through `/assets/src/cowork-chat.js` and consumed by existing WebUI imports. |
| Knowledge traceability helpers | `webui/assets/src/knowledge-traceability.js` | Served through `/assets/src/knowledge-traceability.js` and consumed by existing WebUI imports. |

This keeps functional parity work concentrated in a narrow desktop adapter instead of maintaining a second desktop-native implementation of mature WebUI workflows.

## Update Rules

- Mark a module `Started` when a desktop-native route, client, fixture, or view begins replacing hosted WebUI behavior.
- Mark a module `Parity` only after it has been compared against the existing WebUI for the same gateway responses.
- Keep blockers concrete and remove them when resolved.
- Document intentional behavior differences before removing hosted fallback access.
