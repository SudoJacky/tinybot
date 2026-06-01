# Desktop WebUI Parity Migration Design

## Goal

Make `apps/desktop` present and operate almost exactly like the current gateway-hosted `webui`.

The existing `webui` remains the source of truth for layout, visual style, interaction behavior, i18n, chat, approvals, temporary files, settings, providers, skills, knowledge, workspace files, browser frames, and Cowork surfaces. The desktop app should stop treating the hosted WebUI as a secondary iframe fallback and instead use the WebUI surface as its primary desktop UI.

## Current State

The gateway WebUI is a static frontend rooted at `webui/index.html`. It loads `webui/assets/styles/main.css`, `webui/assets/src/main.js`, i18n modules, and a large `legacy/app.js` module that owns most browser-side UI behavior.

The current desktop app is a Tauri 2 + Vite app under `apps/desktop`. Its UI is a simplified TypeScript shell with runtime status, hosted iframe fallback, and partial native slices for chat, settings, knowledge, workspace files, and Cowork. It already has useful Tauri commands for starting, stopping, and inspecting the local gateway.

These two surfaces are intentionally different today. The migration target is visual and behavioral parity with `webui`, not continued expansion of the simplified desktop-native shell.

## Chosen Approach

Use the current WebUI as the desktop UI source.

The desktop app will load a desktop-adapted copy of the `webui/index.html` shell and expose `webui/assets` and `webui/docs` through Vite using the same public paths expected by the WebUI. The existing WebUI JavaScript should continue to run with minimal targeted adaptation.

This avoids reimplementing a large, coupled UI in desktop TypeScript and reduces behavior drift. Refactoring can happen after parity is visible and covered by tests.

## Non-Goals

This change does not rewrite `webui/assets/src/legacy/app.js` into desktop-native TypeScript components.

This change does not remove the Python gateway or duplicate durable domain state into Tauri.

This change does not make the hosted iframe fallback the primary answer. An iframe can remain as an emergency fallback during migration, but the desktop primary route should be the WebUI surface itself.

## Architecture

`apps/desktop/index.html` becomes a desktop WebUI shell. It should preserve the important DOM structure from `webui/index.html` so existing selectors, modals, panels, and renderer code continue to work.

A new desktop bootstrap script runs before the WebUI entry module. Its responsibilities are narrow:

- detect whether the app is running inside Tauri;
- call the existing `start_gateway` command when appropriate;
- poll gateway readiness using `/webui/bootstrap` or existing desktop status commands;
- configure request routing for gateway APIs;
- load or expose browser globals required by the WebUI, including Markdown and syntax highlighting support;
- then import the existing WebUI entry module.

The desktop bootstrap must not take ownership of chat, settings, knowledge, or Cowork state. That remains in the existing WebUI modules and the backend services.

## Request And WebSocket Routing

The gateway WebUI currently assumes same-origin requests such as:

- `/webui/bootstrap`
- `/webui/refresh-token`
- `/api/status`
- `/api/sessions`
- `/api/approvals`
- `/api/config`
- `/api/providers`
- `/api/provider-models`
- `/api/tools`
- `/api/skills`
- `/api/workspace/files`
- `/api/agent-ui/forms/*`
- `/api/cowork/*`
- `/v1/knowledge/*`
- `/ws`

In desktop, the Vite/Tauri page origin is not the gateway origin. The desktop bootstrap will install a narrow `fetch` adapter that rewrites only known gateway-relative paths to `http://127.0.0.1:18790`. Other requests, including static assets served by Vite, should continue normally.

The bootstrap will also install a WebSocket adapter or provide an equivalent URL resolution hook so `/ws?...` connections target `ws://127.0.0.1:18790/ws?...`.

The adapter should preserve headers, methods, request bodies, abort signals, and token refresh behavior. It should not rewrite third-party absolute URLs or static asset requests.

## Static Assets

Desktop should serve the existing WebUI assets without manual duplication.

Vite will be configured to expose repository-level `webui/assets` and `webui/docs` using the public paths expected by the WebUI:

- `/assets/*`
- `/docs/*`

The WebUI logo files, CSS imports, component CSS, i18n modules, and docs pages should therefore resolve in desktop the same way they resolve through the gateway.

External CDN dependencies currently used by `webui/index.html` for `marked` and `highlight.js` should be replaced or mirrored in the desktop build so the app can work reliably offline. The desktop path can use npm packages and assign the same globals expected by `legacy/app.js`.

## Runtime Status UX

The desktop app should show the WebUI as the main screen. Gateway startup status should be a compact blocking or overlay state only when the gateway is not ready.

Expected startup flow:

1. desktop window opens;
2. desktop bootstrap starts or detects the local gateway;
3. while waiting, a small status state explains that Tinybot is starting;
4. when `/webui/bootstrap` succeeds, the WebUI initializes normally;
5. if startup fails, show a recoverable error with retry and a concise diagnostic.

The existing runtime dashboard can remain in code during migration but should not be the primary route.

## Existing Desktop Modules

The current desktop-native TypeScript modules for simplified chat, settings, knowledge, workspace, and Cowork should remain temporarily as implementation fallback and test references. They should not be expanded as part of this parity migration.

Once the WebUI parity path is working, a later cleanup can remove or archive the simplified native UI if it is no longer useful.

## Testing And Verification

Run the existing desktop tests:

```bash
npm test
npm run build
```

Run focused WebUI/API tests when request routing or bootstrap assumptions change:

```bash
uv run pytest tests/api/test_webui.py
```

Run frontend syntax or unit checks when WebUI modules are touched:

```bash
node --check webui/assets/src/legacy/app.js
node webui/assets/src/agent-ui-events.test.mjs
```

Manual verification should compare desktop against the current gateway WebUI for:

- startup and gateway readiness;
- session list loading;
- new chat and message send;
- streaming response rendering;
- approvals;
- temporary file upload controls;
- settings modal;
- provider cards and model discovery;
- tools and skills panels;
- knowledge stats, documents, graph/query/traceability surfaces;
- workspace file load/save;
- browser frame display;
- Cowork console, summaries, graphs, mailbox/activity panels;
- language and theme toggles.

## Risks

The WebUI has many global DOM assumptions. The safest route is to preserve IDs, class names, and load order instead of recreating markup piecemeal.

Request rewriting can break file upload, streaming, or abort behavior if implemented too broadly. The adapter must preserve `Request` objects and only rewrite known gateway paths.

Desktop offline behavior depends on replacing CDN-only Markdown and syntax highlighting dependencies.

Tauri CSP and asset serving can differ from the gateway. The migration should keep CSP permissive until parity is proven, then tighten it separately.

## Implementation Order

1. Add the desktop bootstrap and gateway routing adapter.
2. Rework `apps/desktop/index.html` to use the WebUI shell and load the bootstrap before the WebUI entry.
3. Configure Vite to serve `webui/assets` and `webui/docs` at WebUI-compatible paths.
4. Add local Markdown and syntax-highlight globals for desktop.
5. Keep or adapt current desktop tests around gateway startup and routing.
6. Run build/tests and perform side-by-side manual parity checks.
