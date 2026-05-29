# Desktop WebUI Parity Inventory

This document is the phase-1 routing artifact for `mirror-webui-in-desktop-app`.
The desktop app hosts the root WebUI; it does not maintain a second desktop-only
copy of the WebUI screens. Keep this inventory current when a root WebUI module
adds a route, modal, static asset, or gateway contract that the desktop shell
must preserve.

## Root WebUI Source Inventory

| Surface | Source of truth | Desktop parity contract |
| --- | --- | --- |
| HTML shell and page metadata | `webui/index.html` | Install the root body, `lang`, `data-theme`, local stylesheet links, and local icon links before importing `/assets/src/main.js`. |
| App startup and state | `webui/assets/src/main.js`, `webui/assets/src/state.js`, `webui/assets/src/legacy/app.js` | Import the root WebUI entrypoint after desktop gateway and render globals are installed. |
| Styles and image assets | `webui/assets/styles.css`, `webui/assets/styles/**`, `webui/assets/logo*.svg`, `webui/assets/social-preview.svg` | Serve and bundle `/assets/**` from root `webui/assets`; leave those requests on the desktop static origin. |
| Docs pages | `webui/docs/index.html`, `cli.html`, `config.html`, `gateway.html`, `knowledge.html`, `providers.html`, `quickstart.html`, `skills.html`, `tasks.html`, `tools.html`, `webui.html` | Serve and bundle `/docs` plus `/docs/**` from root `webui/docs`; leave docs requests on the desktop static origin. |
| i18n dictionaries | `webui/assets/src/i18n/en-US.js`, `webui/assets/src/i18n/zh-CN.js`, `webui/assets/src/i18n/index.js` | Load the same dictionaries through `/assets/src/i18n/**` and verify language switching updates static and dynamic labels. |
| Shared WebUI helpers | `agent-ui-events.js`, `cowork-chat.js`, `knowledge-traceability.js`, `provider-cards.js`, `utils/**` | Serve helper modules through `/assets/src/**`; exclude root WebUI `*.test.*` files from desktop build output. |

## Root WebUI Routes and Entry Points

| Module | Root entry points | Gateway/API families |
| --- | --- | --- |
| Chat and sessions | session list, new chat, composer, message list, status/usage, run-chain inspector, `/cowork` deep link | `/webui/bootstrap`, `/webui/refresh-token`, `/ws`, `/api/sessions/**`, `/api/status` |
| Approvals and Agent UI forms | approval panel, approval list, form request rendering, submit/cancel continuation | `/api/approvals/**`, `/api/agent-ui/forms/**` |
| Temporary session files | temporary file upload button, file strip, persistent RAG toggle | `/api/sessions/{session_key}/temporary-files`, session metadata/message routes |
| Knowledge | knowledge sidebar panel, knowledge modal, document detail modal, graph/GraphRAG tabs, traceability inspector | `/v1/knowledge/stats`, `/documents`, `/documents/upload`, `/jobs/**`, `/graphrag`, `/graph`, `/query`, `/rebuild-index` |
| Workspace files | workspace panel and modal, file list, load, dirty state, save | `/api/workspace/files/**` |
| Tools | tools sidebar panel, tools modal, tool detail modal, config hint | `/api/tools`, `/api/config` |
| Skills | skills sidebar panel, skills modal, skill detail modal, create/edit/delete/validate flows | `/api/skills/**` |
| Config and providers | settings modal, grouped config sections, provider catalog/settings/model discovery | `/api/config`, `/api/providers`, `/api/provider-models` |
| Cowork console | sidebar sessions, Cowork modal/page, graph, focus strip, tabs, filters, branch/task/work-unit controls | `/api/cowork/sessions/**`, `/api/cowork/blueprints/**`, branch, task, summary, and action endpoints |
| Docs, help, language, theme | docs link, page help, help tour, language toggle, theme toggle, highlight theme links | static `/docs/**`, static `/assets/**`, local storage-backed preferences |

## Desktop Shell Inventory

| Concern | Current implementation | Existing coverage |
| --- | --- | --- |
| Startup shell | `apps/desktop/index.html` is a compact diagnostics shell with retry. | Manual Tauri smoke still pending. |
| Root WebUI injection | `apps/desktop/src/desktopBootstrap.ts` fetches `/webui/bootstrap`, starts/attaches gateway when possible, installs bridge/render globals, injects `webui/index.html`, then imports `/assets/src/main.js`. | `desktopWebUiShell.test.ts` covers `lang`, `data-theme`, local head assets, script exclusion, and body replacement. |
| Gateway lifecycle | `apps/desktop/src-tauri/src/lib.rs` checks `127.0.0.1:18790`, starts `uv run tinybot gateway`, tracks shell/external ownership, and stops only shell-owned gateways on explicit stop. | `desktopGatewayStartup.test.ts`, `desktopStartupView.test.ts`, `cargo test`, and `cargo check` cover startup decisions, diagnostics, retry wiring, and shell-owned child shutdown. |
| HTTP bridge | `apps/desktop/src/desktopGatewayBridge.ts` rewrites `/webui/**`, `/api/**`, and `/v1/knowledge/**` to `http://127.0.0.1:18790`. | `desktopGatewayBridge.test.ts` covers known path rewrites, request semantics, auth refresh, and non-gateway requests. |
| WebSocket bridge | `desktopGatewayBridge.ts` rewrites same-page `/ws` URLs to `ws://127.0.0.1:18790/ws` with query preservation. | `desktopGatewayBridge.test.ts` covers relative, absolute desktop-origin, local Vite-origin, and external socket URLs. |
| Static WebUI serving | `apps/desktop/vite.config.ts` serves `/assets`, `/docs`, `/docs/*.html`, and root docs extensionless routes from root `webui` in dev/preview and emits those files during build. | `viteStaticPlugin.test.ts`, `npm run build`, and build-output probes cover route resolution, docs local assets, and emitted assets. |
| WebUI test exclusion | `vite.config.ts` skips root WebUI `*.test.js`, `*.test.cjs`, and `*.test.mjs` files when emitting assets. | `viteStaticPlugin.test.ts` plus build-output probes cover source test exclusion. |
| Desktop-native fallback modules | `apps/desktop/src/main.ts`, `nativeChat.ts`, `agentUiEvents.ts`, gateway clients | Kept as fallback/reference; the default route is the injected root WebUI. Existing tests cover native reducers and gateway clients. |

## Existing Automated Checks

| Check | Current target |
| --- | --- |
| `npm test` from `apps/desktop` | Runs `vitest` over `src/**/*.test.ts`. |
| `apps/desktop/src/desktopGatewayBridge.test.ts` | Gateway HTTP/WebSocket rewriting for `/webui/**`, `/api/**`, `/api/cowork/**`, `/v1/knowledge/**`, tools/skills module endpoints, static/docs/icon exclusions, request semantics, and auth refresh preservation. |
| `apps/desktop/src/desktopGatewayStartup.test.ts` | External attach, no-Tauri recoverable failure, Tauri external status attach, shell-owned start, bootstrap wait, and startup timeout diagnostics. |
| `apps/desktop/src/desktopStartupView.test.ts` | Startup status text, recoverable diagnostics visibility, retry hiding, and retry click binding. |
| `apps/desktop/src/desktopWebUiShell.test.ts` | Root WebUI shell metadata, local head asset, and script-free body installation before entrypoint import. |
| `apps/desktop/src/viteStaticPlugin.test.ts` | Static `/assets/**`, `/docs`, `/docs/*.html`, extensionless docs page resolution, docs local asset bundle coverage, traversal rejection, content types, and root WebUI test-file exclusion. |
| `webui/assets/src/app-startup.test.mjs` | Root WebUI entrypoint starts immediately when dynamically imported after `DOMContentLoaded`, which is required by the desktop bootstrap sequence. |
| `apps/desktop/src/gateway.test.ts` | Gateway config, bootstrap/status clients, shared route clients, WebSocket frames. |
| `apps/desktop/src/gatewayStatusView.test.ts` | Gateway status view mapping for external/reachable and partial health states. |
| `apps/desktop/src/nativeChat.test.ts` | Desktop fallback chat/session reducers and streaming state. |
| `apps/desktop/src/agentUiEvents.test.ts` | Desktop fallback Agent UI event normalization and form lifecycle. |

## Verification Evidence

| Command | Evidence |
| --- | --- |
| `npm test` from `apps/desktop` | Passed with 9 test files and 36 tests, covering desktop gateway startup, startup diagnostics/retry, gateway bridge, tools/skills bridge endpoints, WebUI shell install, static asset/docs routing, gateway clients, status view, native chat reducers, and Agent UI fallback events. |
| `node webui/assets/src/app-startup.test.mjs` | Passed; covers the root WebUI entrypoint helper used when the desktop shell imports the WebUI after `DOMContentLoaded`. |
| Browser smoke at `http://localhost:1420` with gateway on `127.0.0.1:18790` | Passed for the reported startup issue: WebSocket opened to `ws://127.0.0.1:18790/ws`, received `ready`, status loaded provider/model/channel, and New Chat sent `new_chat` then received `chat_created`. |
| `npm run build` from `apps/desktop` | Passed; emitted root WebUI assets/docs including `dist/assets/src/main.js`, `dist/docs/index.html`, and extensionless docs routes such as `dist/docs/quickstart`, with root WebUI source test files excluded. |
| `cargo check` from `apps/desktop/src-tauri` | Passed for `tinybot-desktop` dev profile. |
| `cargo test` from `apps/desktop/src-tauri` | Passed with the shell-owned gateway child shutdown unit test. |
| `npm run tauri -- info` from `apps/desktop` | Passed; reported WebView2 `148.0.3967.83`, MSVC Visual Studio Community 2026, Rust/Cargo `1.96.0`, Node `24.14.0`, npm `11.9.0`, Tauri `2.11.2`, and frontend dist/dev URL readiness. |
| `openspec validate mirror-webui-in-desktop-app --strict` | Passed for the current OpenSpec artifacts. |

## Module Parity Checklist

| Module | Automated check | Manual desktop workflow | Current blocker / status |
| --- | --- | --- | --- |
| Shell metadata and root DOM | `desktopWebUiShell.test.ts`; `webui/assets/src/app-startup.test.mjs`; `npm test`; `npm run build`. | Launch Tauri, confirm root WebUI body replaces startup shell after gateway readiness. | Automated shell installation and dynamic entrypoint startup coverage present; manual Tauri smoke pending. |
| Static assets and docs | `viteStaticPlugin.test.ts`, `npm test`, `npm run build`, and probes for `dist/assets/src/main.js`, `dist/docs/index.html`, extensionless `dist/docs/<page>` routes, local docs styles/assets, and absent `dist/assets/src/*.test.*` files. | Open docs link and inspect local styles/icons in desktop. | Automated package coverage for `/docs` and each root docs page is present; manual desktop docs navigation pending. |
| Gateway bridge | `desktopGatewayBridge.test.ts`; `npm test`. | Send chat/config/knowledge requests from desktop and confirm gateway receives original path/query/body semantics. | Automated adapter coverage present; runtime smoke pending. |
| Gateway lifecycle | `desktopGatewayStartup.test.ts`, `desktopStartupView.test.ts`, `cargo test`, `cargo check`; `npm test`. | Test external gateway attach, shell-owned startup, retry diagnostics, explicit stop, and close behavior in a real Tauri window. | Automated lifecycle coverage present; manual Tauri smoke pending. |
| Chat and sessions | Existing fallback reducer tests; root WebUI runtime parity still manual. | List sessions, create/select/delete/clear, send message, stream deltas, interrupt, inspect status/usage. | Pending desktop runtime pass. |
| Run chain and inspector | No desktop-specific adapter expected unless bridge gaps appear. | Open reasoning/tool/browser/citation/reference items and compare inspector detail to browser WebUI. | Pending desktop runtime pass. |
| Approvals and Agent UI forms | `agentUiEvents.test.ts` covers fallback reducer only. | Trigger approval and schema form flows, then submit/cancel/retry through root WebUI. | Pending desktop runtime pass. |
| Temporary files and RAG toggle | No desktop-specific adapter expected unless file input gaps appear. | Upload/list/clear temporary files and toggle persistent RAG for a session. | Pending desktop runtime pass. |
| Knowledge and traceability | Root helper tests remain under `webui/assets/src`; desktop bridge covers `/v1/knowledge/**`. | Open stats/docs, upload/delete/rebuild, query, graph, GraphRAG, and traceability inspector. | Pending desktop runtime pass. |
| Workspace files | Gateway client fallback tests cover route shape only. | List/load/edit/save files, verify dirty state and protected path errors. | Pending desktop runtime pass. |
| Tools and skills | `desktopGatewayBridge.test.ts` covers `/api/tools`, `/api/skills`, and skill validate request rewriting with method/header/body preservation; gateway route fallback tests cover list/detail shapes. | Open tools/skills modals, create/edit/delete/validate skills, inspect tool schema rendering. | Focused bridge coverage present; desktop runtime UI pass pending. |
| Config and providers | Gateway route fallback tests cover shared route construction only. | Open/save config, validate masked secrets, provider catalog, profiles, model refresh, and selectors. | Pending desktop runtime pass. |
| Cowork console | No desktop-specific adapter expected unless bridge gaps appear. | Open Cowork modal/page, create/run/control sessions, inspect graph, trace, tasks, mailbox, outputs, branches, and work units. | Pending desktop runtime pass. |
| Help, language, and theme | No desktop-specific adapter expected unless static asset gaps appear. | Exercise sidebar collapse, modal close/navigation, help tour, language toggle, theme/highlight persistence. | Pending desktop runtime pass. |

## Update Rules

- Keep root WebUI as the source of truth unless an OpenSpec task explicitly calls for a desktop adapter.
- Mark a module complete only when the task evidence names both automated checks and the manual desktop workflow.
- If desktop cannot reproduce a root WebUI behavior, keep the module incomplete and document the exact missing behavior here.
- Update this inventory before marking OpenSpec checklist items complete for parity-critical modules.
