# Tinybot Desktop

Desktop host for Tinybot's WebUI. The desktop app uses Tauri and the platform WebView, keeps the existing Python gateway as the runtime backend, and presents the same WebUI surface users see in the browser. Desktop-specific code is limited to startup, gateway readiness, the window frame, OS notifications, native file picking, and external link handling.

## Prerequisites

All platforms:

- Node.js and npm for the TypeScript frontend.
- Rust and Cargo for the Tauri shell.
- `uv` for running the existing Tinybot Python gateway.
- A development checkout of this repository for the current sidecar startup path.

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

Run the Tinybot gateway manually from the repository root:

```bash
uv run tinybot gateway
```

Start the desktop shell from the repository root:

```bash
npm run tauri dev
```

The shell can also start the gateway with `uv run tinybot gateway` from the repository root. If `http://127.0.0.1:18790/api/status` is already reachable at startup, the shell labels that gateway as externally owned and does not stop it on exit.

Build a desktop package from the repository root:

```bash
npm run tauri build
```

## Current Boundary

- Frontend workspace: `src/`
- Desktop shell: `src-tauri/`
- Runtime endpoint: `http://127.0.0.1:18790`
- WebSocket endpoint: `ws://127.0.0.1:18790/ws`
- Primary UI source: repository `webui/index.html` plus `webui/assets`
- Browser mode: external browser only

## Launch Flow

1. Open the desktop app.
2. A compact startup state waits for the local gateway to become ready.
3. If an external gateway is already running, the app attaches to it and treats it as externally owned.
4. If no gateway is running inside Tauri, the app starts a shell-owned gateway with `uv run tinybot gateway`.
5. When `/webui/bootstrap` is ready, the desktop window installs the WebUI shell and imports the existing WebUI entry module.
6. Use the desktop app the same way as the browser WebUI: chat, sessions, approvals, temporary files, settings, providers, tools, skills, knowledge, workspace files, browser frames, Cowork, language toggle, and theme toggle all remain WebUI-owned surfaces.

The app stops only shell-owned gateway processes on exit. Externally owned gateway processes are left running.

## Desktop Adapters

The desktop route keeps WebUI behavior as the source of truth and layers native capabilities around it:

- gateway HTTP and WebSocket requests are routed to the local gateway;
- menu and keyboard commands click existing WebUI controls;
- native file picking feeds the WebUI's upload inputs;
- OS notifications observe existing WebUI approval and task progress surfaces;
- external links open through the operating system.

## External Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform WebView. Browser automation, browser snapshots, and browser bridge status are treated as optional gateway-provided capabilities and should not block gateway startup or the WebUI shell.
