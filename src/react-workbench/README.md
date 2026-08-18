# React Workbench
<!-- tinybot-module-fingerprint: sha256:f3bf784d8761fd56f603b058cc52ea99d8f2b804df3edc0068ef2bdfbf8f19e5 -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- `sidecar/` owns the docked resource shell and its Browser, Terminal, and
  Artifact resource presentations.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.

The retired TinyOS desktop and its embedded files, terminal, and monitor
applications are not renderer routes. Chat now hosts Sidecar, whose Browser
resources attach directly to the shared native WebView2 session used by Agent
web tools. Terminal resources attach to a separate user-only PTY runtime;
switching or hiding resources preserves the process, while closing the
Terminal tab ends it.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Its diagnostic export method
accepts no page parameters: the service owns renderer-log, locale, time-zone,
and diagnostic-mode collection before delegating ZIP creation to native code.
Browser-only runs retain the same service shape but surface native-runtime
unavailability explicitly.
