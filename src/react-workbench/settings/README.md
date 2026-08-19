# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:897d54193573f9520819ca40fbd423e57bfe34ae2cabe6afb2b7aea2740540af -->

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

`SettingsChoiceList.tsx` is the canonical fixed-choice control for settings
pages. App preferences, appearance fonts, Agent defaults, and fixed config
options reuse its trigger, popover, selected state, and keyboard navigation
instead of rendering platform-native select menus.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.
