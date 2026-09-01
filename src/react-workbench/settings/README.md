# Settings Workbench
<!-- tinybot-module-fingerprint: sha256:1969a0bdca5b6c43afcacae70ecc55f8de77cea0a09744a76f519ec535cdb276 -->

`settings` owns the Settings route, its navigation, pages, sheets, appearance
and language contexts, and form presentation. `SettingsRoute.tsx` is loaded as
an optional desktop route together with `SettingsRoute.css`. The route's content
row grows to its minimum content height so long forms retain the shared bottom
inset instead of overflowing across it.

The Appearance page owns the complete desktop-pet settings surface: visibility,
three-step size, safe-position recovery, and classic or dimensional style. All
controls write through the shell-owned desktop-pet callbacks, so the embedded
fallback and independent native pet window stay synchronized. The pet itself
retains compact resize and hide shortcuts, but the System menu does not expose a
second configuration surface.

Settings contracts, metadata, validation, value semantics, and persistence
patches live in `app-core/settings`. Native reads and writes are exposed through
the Settings store adapter.

The Profile module loads `tinybot.token_usage.v2` from the native Settings-store
adapter and shows filterable Provider/model totals, a 30-day daily trend, a
ranked model chart, and exact daily and model tables. Historical v1 rows without
dimensions are labeled Unknown. Cached input remains a subset of input tokens,
and reasoning output remains a subset of output tokens; the UI labels those
relationships instead of summing the breakdown columns into a misleading
second total. The charts share the Lieflat Porcelain palette with Chat data
views: the daily trend separates ordinary and peak values, while model rank
moves through one blue luminance scale without relying on color alone. Charts
reveal when they enter the viewport and replay when clicked or activated from
the keyboard, while reduced-motion preferences render them without animation.

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
Profile usage filters, fixed config options, and Agent Graph workspace choices
reuse its trigger, popover, selected state, keyboard navigation, and co-located
stylesheet instead of rendering platform-native select menus. App-language
choices keep their names and descriptions in each target language so they remain
discoverable regardless of the currently selected interface language.

`SettingsSheet.tsx` owns settings-specific layout and close animation while
delegating modal focus, keyboard, dismissal, and scroll-lock behavior to the
shared `components/ui/useModalDialog` seam.

The Provider & Models page exposes reasoning-effort support only for custom
providers. New custom profiles start enabled; users can disable it while
creating or configuring the profile when an endpoint rejects effort fields.
The built-in Z.ai provider presents its static GLM models and Chat Completions
mode without offering the unsupported Responses choice.
The built-in Ollama provider starts at `http://127.0.0.1:11434/v1`, does not
require an API key, and opens model management directly so a first-time user can
discover locally installed models before choosing a default. Its Provider card
uses the packaged Ollama brand SVG instead of the generated initials fallback.
The new-conversation default selector persists `agents.defaults.activeProfile`
and `agents.defaults.model` together through the shared native Settings-store
operation before updating the renderer's recently-used preference. Chat and
desktop-pet quick chat use that same operation for empty conversations, so no
renderer surface can update only the local preference. Activating a Provider also
requires and persists that Provider's enabled default model, so background
model work cannot combine one Profile's endpoint with another Provider's model.
Its model manager configures context windows per model with the shared
`SettingsChoiceList`: known models default to Tinybot's automatic value,
unknown models show the runtime fallback, and either can store a custom positive
Token limit. Agent Defaults retains the compaction strategy but no longer
presents one editable window as if it applied to every model.
Each model row uses a dedicated enable checkbox for shared selectors and a
compact image capability button; a lit image icon means the profile declares
image input for that model. A compact radio control selects the Provider's
backup model without repeating a full action label in every row. Existing
profiles remain enabled by default; newly discovered models enter the catalog
disabled so large Provider listings do not flood Chat and Agent Graph controls.
Known vision models receive their automatic image capability, which users can
override per profile.
