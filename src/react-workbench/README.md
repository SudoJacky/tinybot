# React Workbench
<!-- tinybot-module-fingerprint: sha256:03d522b129942473a0622c3992044dbb80414bbab62690f50697a585023ce8fd -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.

The retired TinyOS desktop and its embedded files, terminal, monitor, and
browser applications are not renderer routes. Chat retains only normal
conversation controls and the native browser-session bridge needed by a future
desktop browser surface.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Its diagnostic export method
accepts no page parameters: the service owns renderer-log, locale, time-zone,
and diagnostic-mode collection before delegating ZIP creation to native code.
Browser-only runs retain the same service shape but surface native-runtime
unavailability explicitly.
