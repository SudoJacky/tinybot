# Tinybot Desktop

Desktop host for Tinybot's native workbench. The desktop app uses Tauri and the platform WebView, runs the Rust native backend as the default runtime, and presents native TypeScript workbench surfaces inside the desktop shell. Desktop-specific code owns startup, runtime readiness, the window frame, OS notifications, native file picking, external link handling, and WebUI-compatible routing.

## Prerequisites

All platforms:

- Node.js and npm for the TypeScript frontend.
- Rust and Cargo for the Tauri shell.
- Tauri 2 prerequisites for the target platform.
- A development checkout of this repository for the current native runtime startup path.

Windows:

- Microsoft Visual Studio Build Tools with MSVC and Windows SDK.
- Microsoft Edge WebView2 Runtime.
- PowerShell or Windows Terminal with UTF-8 output recommended.

macOS:

- Xcode Command Line Tools.
- The system WebKit WebView provided by macOS.

Linux:

- WebKitGTK and native build dependencies required by Tauri for the target distribution.
- Platform packages vary by distro; follow the Tauri Linux prerequisites for WebKitGTK, GTK, AppIndicator, and librsvg.

## Setup

From the repository root:

```bash
npm install
```

## Runtime Commands

Run only the frontend checks:

```bash
npm test
npm run build
```

Start the desktop shell with the Rust native backend from the repository root:

```bash
npm run tauri -- dev
```

Build a desktop package from the repository root:

```bash
npm run tauri -- build
```

The desktop shell starts the Rust native backend in-process. Tauri mode does not bind a local HTTP
or WebSocket listener. Chat uses typed Thread commands and typed Tauri events directly; the native WebUI
route wrapper remains available only for non-chat HTTP-compatible surfaces. Routes or commands that
are not implemented in Rust return explicit errors.

## Current Boundary

- Frontend workspace: `src/`
- Desktop shell: `src-tauri/`
- Runtime backend: Rust native backend
- Desktop chat contract: typed Thread commands plus `agent.timeline.patch` and `agent.awaiting_form` Tauri events
- Primary UI source: repository `index.html` plus `src/native-workbench/`
- Static assets and docs: repository `public/`
- Browser mode: external browser only

## Launch Flow

1. Open the desktop app.
2. A compact startup state waits for the Rust native backend to become ready.
3. The Tauri shell initializes and checks the in-process native runtime directly.
4. The desktop window installs the workbench shell without an HTTP bootstrap probe or a local TCP
   port.
5. Use the desktop app through native workbench modules for chat, sessions, approvals, settings, providers, tools, Agent Plugins, workspace files, browser frames, language toggle, and theme toggle where Rust support exists.

The app owns the native runtime lifecycle. The configured exit policy applies to managed native backend state.

## Agent Plugins

The **Tools & Plugins** page imports local directories that conform to Agent Plugins 1.0.0. Tinybot validates `plugin.json`, discovers immediate child skills from `skills/*/SKILL.md`, and loads MCP definitions from `mcp.json` when present. Imported plugins start disabled and must be enabled explicitly.

Plugins are global rather than workspace-specific:

- managed package copies are stored under `~/.tinybot/plugins/cache/<plugin-name>`;
- persistent plugin data is stored under `~/.tinybot/plugins/data/<plugin-name>`;
- enablement state is stored in `~/.tinybot/plugins/state.json`;
- every enabled plugin is available in every Tinybot workspace;
- uninstalling removes the package cache but retains its persistent data.

Tinybot supports Agent Plugin MCP servers using `stdio` and `streamable-http`. Unsupported or invalid MCP entries are reported or skipped independently so valid skills and sibling servers remain usable. Tinybot does not scan or load legacy workspace skill directories into this plugin store.

The page also offers an explicit Agent-assisted migration for standalone Skills, MCP configurations, and recognized client-plugin layouts. Tinybot copies the selected source into an isolated job under `~/.tinybot/plugins/migrations/<job-id>/source`, gives the Agent an empty `output` directory, and starts a normal chat turn scoped to that job. The original source is not modified, the Agent cannot install the result directly, and the generated output must still pass the normal strict plugin import before it can be enabled.

## Desktop Adapters

The desktop route keeps the Rust backend contract as the source of truth and layers native capabilities around it:

- chat creation, turns, interruption, approvals, and forms use the native Thread API;
- live chat rendering consumes typed native Tauri events without an intermediate transport-frame projection;
- non-chat WebUI-compatible requests use the native WebUI route wrapper where needed;
- menu and keyboard commands route through native workbench navigation and actions;
- native file picking feeds native workbench upload actions;
- OS notifications observe native approval and task progress surfaces;
- external links open through the operating system.

## External Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform WebView. Browser automation, browser snapshots, and browser bridge status are optional runtime capabilities and should not block native backend startup or the native workbench shell.
