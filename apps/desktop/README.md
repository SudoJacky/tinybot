# Tinybot Desktop

Lightweight desktop host for Tinybot. The desktop app uses Tauri and the platform WebView, keeps the existing Python gateway as the first runtime backend, and does not bundle Chromium by default. Browser automation remains an optional external capability backed by installed Chrome, Edge, Chromium, or a bridge service.

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

From `apps/desktop`:

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

Start the desktop shell from `apps/desktop`:

```bash
npm run tauri dev
```

The shell can also start the gateway with `uv run tinybot gateway` from the repository root. If `http://127.0.0.1:18790/api/status` is already reachable at startup, the shell labels that gateway as externally owned and does not stop it on exit.

Build a desktop package from `apps/desktop`:

```bash
npm run tauri build
```

## Current Boundary

- Frontend workspace: `src/`
- Desktop shell: `src-tauri/`
- Runtime endpoint: `http://127.0.0.1:18790`
- WebSocket endpoint: `ws://127.0.0.1:18790/ws`
- Hosted WebUI fallback: `http://127.0.0.1:18790`
- Browser mode: external browser only

## Launch Flow

1. Open the desktop app.
2. The local runtime status view appears even when the gateway is offline.
3. If an external gateway is already running, the app connects to it and labels it `External`.
4. If no gateway is running, use `Start Gateway` to launch a shell-owned gateway with `uv run tinybot gateway`.
5. When the gateway is ready, open `Hosted WebUI` to load the existing gateway-served WebUI inside the desktop shell.
6. Use `Chat` for the first native desktop slice: session selection, message history, send, streaming deltas, stream end state, and interrupt.

The app stops only shell-owned gateway processes on exit. Externally owned gateway processes are left running.

## External Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform WebView. Browser automation, browser snapshots, and browser bridge status are treated as optional gateway-provided capabilities and should not block runtime status, hosted WebUI, or native chat work.
