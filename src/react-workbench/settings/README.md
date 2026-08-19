# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:3d5e1dc180284bb1d83741d8eb815480e4246de8b1582fbd8984553d7aa32407 -->

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
and exact-hash trust actions. Hand-written hooks remain visible as advanced,
read-only catalog entries.

`SettingsChoiceList.tsx` is the canonical fixed-choice control for settings
pages. App preferences, appearance fonts, Agent defaults, and fixed config
options reuse its trigger, popover, selected state, and keyboard navigation
instead of rendering platform-native select menus.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.
