# React Workbench
<!-- tinybot-module-fingerprint: sha256:d8b33464e437e628b53ab12e7b36da079bf99e8c509db18592fc552f3827d256 -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.

`defaultServices.ts` exposes Performance Trace through a small route-facing
store backed by the typed app-core native adapter. Browser-only runs retain the
same service shape but surface native-runtime unavailability explicitly.
