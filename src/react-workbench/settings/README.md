# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:968436084d143e4bb4b27fcd52a149e7b048ed0ad5d5237ff5b192aa49e52960 -->

`settings` owns the Settings route, its navigation, pages, sheets, appearance
and language contexts, and form presentation. `SettingsRoute.tsx` is loaded as
an optional desktop route together with `SettingsRoute.css`. The route's content
row grows to its minimum content height so long forms retain the shared bottom
inset instead of overflowing across it.

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
isolated sample test, recoverable remove, and definition trust actions. Windows
verbatim path prefixes are normalized before workspace choices are deduplicated.
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

`SettingsChoiceList.tsx` is the canonical fixed-choice control for workbench
configuration surfaces. App preferences, appearance fonts, Agent defaults,
fixed config options, and Agent Graph workspace choices reuse its trigger,
popover, selected state, keyboard navigation, and co-located stylesheet instead
of rendering platform-native select menus. App-language choices keep their
names and descriptions in each target language so they remain discoverable
regardless of the currently selected interface language.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.

The Provider & Models page exposes reasoning-effort support only for custom
providers. New custom profiles start enabled; users can disable it while
creating or configuring the profile when an endpoint rejects effort fields.
The built-in Z.ai provider presents its static GLM models and Chat Completions
mode without offering the unsupported Responses choice.
Its model manager configures context windows per model with the shared
`SettingsChoiceList`: known models default to Tinybot's automatic value,
unknown models show the runtime fallback, and either can store a custom positive
Token limit. Agent Defaults retains the compaction strategy but no longer
presents one editable window as if it applied to every model.
