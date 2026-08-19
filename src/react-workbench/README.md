# React Workbench
<!-- tinybot-module-fingerprint: sha256:519e7ef2b1705cfeba3016a9dd75902541176628c9d2ab8187032940200bb6fb -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- [`sidecar/`](sidecar/README.md) owns the docked resource shell and its Browser,
  Terminal, and Artifact resource presentations.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.

The retired TinyOS desktop and its embedded files, terminal, and monitor
applications are not renderer routes. Chat now hosts Sidecar, whose Browser
resources attach directly to the shared native WebView2 session used by Agent
web tools. Terminal resources attach to a separate user-only PTY runtime;
switching or hiding resources preserves the process, while closing the
Terminal tab ends it. Regular chats share the native default-workspace Sidecar
scope even though their Thread metadata has no explicit working directory.
Docked Sidecar widths are measured against the Chat workspace so persisted
sizes and live resizing cannot displace the resource surface beyond its
container; narrow windows retain the overlay gutter instead.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Its diagnostic export method
accepts no page parameters: the service owns renderer-log, locale, time-zone,
and diagnostic-mode collection before delegating ZIP creation to native code.
Browser-only runs retain the same service shape but surface native-runtime
unavailability explicitly.
