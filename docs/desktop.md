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

The desktop shell starts the Rust native backend in-process. The runtime exposes WebUI-compatible status and WebSocket endpoints at `http://127.0.0.1:18790` and `ws://127.0.0.1:18790/ws`. Routes or commands that are not implemented in Rust return explicit unsupported responses.

## Current Boundary

- Frontend workspace: `src/`
- Desktop shell: `src-tauri/`
- Runtime endpoint: `http://127.0.0.1:18790`
- WebSocket endpoint: `ws://127.0.0.1:18790/ws`
- Runtime backend: Rust native backend
- Optional compatibility path: none
- Primary UI source: repository `index.html` plus `src/native-workbench/`
- Static assets and docs: repository `public/`
- Browser mode: external browser only

## Launch Flow

1. Open the desktop app.
2. A compact startup state waits for the Rust native backend to become ready.
3. The Tauri shell initializes the native runtime and exposes WebUI-compatible routes.
4. When `/webui/bootstrap` is ready, the desktop window installs the native workbench shell.
5. Use the desktop app through native workbench modules for chat, sessions, approvals, temporary files, settings, providers, tools, skills, knowledge, workspace files, browser frames, Cowork, language toggle, and theme toggle where Rust support exists.

The app owns the native runtime lifecycle. The configured exit policy applies to managed native backend state.

## Desktop Adapters

The desktop route keeps the Rust backend contract as the source of truth and layers native capabilities around it:

- WebUI HTTP and WebSocket requests are routed through the Rust native backend or native WebUI route bridge;
- menu and keyboard commands route through native workbench navigation and actions;
- native file picking feeds native workbench upload actions;
- OS notifications observe native approval and task progress surfaces;
- external links open through the operating system.

## External Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform WebView. Browser automation, browser snapshots, and browser bridge status are optional runtime capabilities and should not block native backend startup or the native workbench shell.
