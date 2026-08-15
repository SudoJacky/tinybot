# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:6df4c8272446cc22cea9cbefa581f446994980ff6947749b3cb193a9b9f789d4 -->

`settings` owns the Settings route, its navigation, pages, sheets, appearance
and language contexts, and form presentation. `SettingsRoute.tsx` is loaded as
an optional desktop route together with `SettingsRoute.css`.

Settings contracts, metadata, validation, value semantics, and persistence
patches live in `app-core/settings`. Native reads and writes are exposed through
the Settings store adapter.
