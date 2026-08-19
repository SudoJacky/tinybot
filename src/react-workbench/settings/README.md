# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:20e3383de44cc6329a7fe1d64f1d5afb83e744270d82c3a32d846de36427a65b -->

`settings` owns the Settings route, its navigation, pages, sheets, appearance
and language contexts, and form presentation. `SettingsRoute.tsx` is loaded as
an optional desktop route together with `SettingsRoute.css`.

Settings contracts, metadata, validation, value semantics, and persistence
patches live in `app-core/settings`. Native reads and writes are exposed through
the Settings store adapter.

`HooksSettingsPage` is backed by the separate optional Hooks store because its
catalog and trust file are not ordinary config patches. It can inspect another
existing workspace, displays parse diagnostics and exact command definitions,
and requires confirmation before granting trust. It also shows the global
commented configuration template and PowerShell/POSIX script-template paths.
Editing `hooks.json` and copying templates stay explicit filesystem operations
outside the renderer.

For managed hooks, the page derives workspace choices from the same session and
project-group stores used by Chat. The form asks only for name, lifecycle event,
an applicable-tool/compaction preset, language, and timeout. Tinybot creates the
manifest and safe script, while the card exposes reveal, edit, enable/disable,
isolated sample test, recoverable remove, and exact-hash trust actions.
The workspace's managed scripts also appear in a selector and open in a
monospace inline editor. Unsaved changes require confirmation before switching,
and version-conflict handling remains native. Hand-written hooks remain visible
as advanced, read-only catalog entries.

Workspace, script, event, matcher, and language choices reuse the shared
`SettingsChoiceList` interaction instead of native selects. Definition hashes
remain an internal trust identifier and are not rendered. The script editor
supports toolbar actions plus Ctrl/Cmd+/ comment toggling, Tab and Shift+Tab
indentation, and Ctrl/Cmd+S save; pure text transformations are covered in
`hookScriptEditing.test.ts`.

`SettingsChoiceList.tsx` is the canonical fixed-choice control for settings
pages. App preferences, appearance fonts, Agent defaults, and fixed config
options reuse its trigger, popover, selected state, and keyboard navigation
instead of rendering platform-native select menus.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.
