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

The desktop shell starts the Rust native backend in-process. Tauri mode does not require a listener
on port `18790`. Chat uses typed Thread commands and typed Tauri events directly; the native WebUI
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
4. The desktop window installs the workbench shell without probing `/webui/bootstrap` or reserving
   port `18790`.
5. Use the desktop app through native workbench modules for chat, sessions, approvals, settings, providers, tools, skills, workspace files, browser frames, Cowork, language toggle, and theme toggle where Rust support exists.

The app owns the native runtime lifecycle. The configured exit policy applies to managed native backend state.

## Desktop Adapters

The desktop route keeps the Rust backend contract as the source of truth and layers native capabilities around it:

- chat creation, turns, interruption, approvals, and forms use the native Thread API;
- live chat rendering consumes typed native Tauri events without projecting them into Gateway frames;
- non-chat WebUI-compatible requests use the native WebUI route wrapper where needed;
- menu and keyboard commands route through native workbench navigation and actions;
- native file picking feeds native workbench upload actions;
- OS notifications observe native approval and task progress surfaces;
- external links open through the operating system.

## External Browser Policy

The desktop package does not bundle Chromium. The app UI uses the platform WebView. Browser automation, browser snapshots, and browser bridge status are optional runtime capabilities and should not block native backend startup or the native workbench shell.
