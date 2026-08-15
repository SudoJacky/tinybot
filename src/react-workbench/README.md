# React Workbench
<!-- tinybot-module-fingerprint: sha256:ca9fe71697cf169e636140510efb9dba3aaece7ba1c13c849d411a27d7cac694 -->

`react-workbench` contains the React renderer for Tinybot's desktop application.
`main.tsx` mounts `App`, `DesktopShell` owns the desktop chrome, and
`defaultServices.ts` composes the renderer-facing stores.

## Module seams

- `services.ts` defines the interface consumed by routes.
- `adapters/` connects those interfaces to native and app-core modules.
- Route folders own their React state, presentation, and route-scoped styles.
- Framework-independent contracts and projections belong in `app-core/`.
