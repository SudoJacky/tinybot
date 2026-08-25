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

For repository hooks and contribution checks, see
[CONTRIBUTING.md](../CONTRIBUTING.md).

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

After changing desktop startup, Sidecar, WebView2, PTY, or window layout, run
the relevant sections of the [Windows desktop smoke test](guides/desktop-smoke-test.md).

The desktop shell starts the Rust native backend in-process. Tauri mode does not bind a local HTTP
or WebSocket listener. Chat uses typed Thread commands and typed Tauri events directly; the native WebUI
route wrapper remains available only for non-chat HTTP-compatible surfaces. Routes or commands that
are not implemented in Rust return explicit errors.

## Current Boundary

- Frontend workspace: `src/`
- Desktop shell: `src-tauri/`
- Runtime backend: Rust native backend
- Desktop chat contract: typed Thread commands plus `agent.timeline.patch` and `agent.awaiting_form` Tauri events
- Primary UI source: repository `index.html` plus `src/react-workbench/`
- Static assets and docs: repository `public/`
- Sidecar browser: managed WebView2 session shared with Agent on supported Windows builds
- Sidecar terminal: local PowerShell or Command Prompt PTY for the user only

## Launch Flow

1. Open the desktop app.
2. A compact startup state waits for the Rust native backend to become ready.
3. The Tauri shell initializes and checks the in-process native runtime directly.
4. The desktop window installs the workbench shell without an HTTP bootstrap probe or a local TCP
   port.
5. Use the desktop app through native workbench modules for chat, sessions, approvals, settings, providers, tools, Agent Plugins, workspace files, browser frames, language toggle, and theme toggle where Rust support exists.

The app owns the native runtime lifecycle. The configured exit policy applies to managed native backend state.

## Agent Plugins

The **Tools & Plugins** page imports local directories that conform to Agent Plugins 1.0.0. Tinybot validates `plugin.json`, discovers immediate child skills from `skills/*/SKILL.md`, and loads MCP definitions from `mcp.json` when present. Successfully imported plugins are enabled immediately; reinstalling a plugin preserves its current enablement state.

Tinybot installs and enables the bundled `create-agent-plugin` package during startup. Its `create-agent-plugin:migrate-agent-plugin` skill powers the **Migrate Skill or MCP** flow without requiring a separate download. Users can disable this built-in plugin, but cannot uninstall it. A bundled update preserves the current enablement state, and startup does not overwrite a user-managed replacement with the same plugin name.

Plugins are global rather than workspace-specific:

- managed package copies are stored under `~/.tinybot/plugins/cache/<plugin-name>`;
- persistent data for local stdio MCP servers is created on demand under `~/.tinybot/plugins/data/<plugin-name>` and exposed as `PLUGIN_DATA`;
- enablement state is stored in `~/.tinybot/plugins/state.json`;
- every enabled plugin is available in every Tinybot workspace;
- uninstalling a user-managed plugin removes the package cache but retains its persistent data.

Tinybot supports Agent Plugin MCP servers using `stdio` and `streamable-http`. Unsupported or invalid MCP entries are reported or skipped independently so valid skills and sibling servers remain usable. Plugins remain global, while native turns also discover project-local Skills from `.agents/skills/*/SKILL.md` and MCP servers from `mcp.json`, `.mcp.json`, or `.github/mcp.json`. Discovery walks from the nearest Git root to the effective working directory; deeper definitions override same-named outer definitions. Tinybot does not scan `.codex` directories or load the legacy `<backend-workspace>/skills` directory into native turns.

The **Tools & Plugins** page presents Plugins, Skills, MCP servers, and callable Tools as separate views. Its workspace-scoped entries use the configured backend workspace; an explicitly workspace-bound conversation resolves its own project-local Skills and MCP definitions when the turn starts.

The page also offers an explicit Agent-assisted migration for standalone Skills, MCP configurations, and recognized client-plugin layouts. Tinybot copies the selected source into an isolated job under `~/.tinybot/plugins/migrations/<job-id>/source`, gives the Agent an empty `output` directory, and starts a normal chat turn scoped to that job. The original source is not modified and the Agent cannot install the result directly. Migration prefers lossless, order-preserving normalization of portable metadata (for example, converting an `allowed-tools` YAML sequence to the standard space-separated string) and reports fields that cannot be represented without misleading Tinybot. When the turn finishes, the conversation presents an **Install migrated plugin** action. Tinybot resolves the job by ID, validates the generated output, rejects any invalid generated component, installs and enables the plugin, reconciles MCP runtime state, and removes the temporary migration job. Failed validation keeps the migration workspace available for correction; cleanup failures are reported without hiding a successful installation.

## Conversation Models

Model selection belongs to the conversation rather than a separate editable global default. Tinybot stores the recently used model as the starting choice for a new conversation, then persists the selected model in that Thread's metadata. Switching conversations restores each Thread's model, and changing the Composer model updates both the Thread and the recently used choice.

Desktop turn submission resolves models in this order:

1. a model explicitly supplied by the turn;
2. the target Thread's persisted model;
3. the recently used model for new conversations;
4. the native runtime's configured fallback when no user selection exists.

Automatic turns, including Agent-assisted plugin migration, use the same resolution path. Provider profiles keep a provider-specific fallback model for connection setup and native runtime recovery, but that value is not presented as the user's current conversation model.

## Desktop Adapters

The desktop route keeps the Rust backend contract as the source of truth and layers native capabilities around it:

- chat creation, turns, interruption, approvals, and forms use the native Thread API;
- live chat rendering consumes typed native Tauri events without an intermediate transport-frame projection;
- non-chat WebUI-compatible requests use the native WebUI route wrapper where needed;
- menu and keyboard commands route through native workbench navigation and actions;
- native file picking feeds native workbench upload actions;
- OS notifications observe native approval and task progress surfaces;
- external links open through the operating system.
- Sidecar terminals use a dedicated native PTY runtime that is not exposed to Agent tools.

## Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform
WebView, and external links open through the operating system. The default
Windows build also provides a managed WebView2 session that can be shared by a
desktop browser surface and the Agent's `web.*` tools. Builds without that
feature and non-Windows builds
report browser unavailability explicitly; browser startup must not block the
native backend or workbench shell.

## Sidecar Terminal Policy

On Windows, each Sidecar terminal resource starts either PowerShell or Command
Prompt in the active conversation workspace. The terminal is an interactive
user surface only: it does not share process IDs, input, output, or lifecycle
state with Agent shell tools. Hiding the Sidecar or switching tabs preserves
the PTY. Closing its resource terminates and releases the process, and closing
the desktop app terminates all remaining Sidecar terminal processes. A regular
chat without explicit workspace metadata uses the configured Tinybot default
workspace, matching the native Agent runtime fallback.
