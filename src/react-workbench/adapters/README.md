# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:a20a6cabee5d223246ca65ceb2c9ec145b2ca8577a9c7738a736b52a246f24fb -->

`adapters` implements renderer store interfaces over Tinybot's native and
app-core modules. It owns event projection and the Settings, Tools, and
Workspace store adapters used by `createDesktopAppServices()`.

Adapters may translate transport data into renderer contracts, but they do not
render React views or become a second authority for chat, settings, or
workspace state.

The native event bridge records opt-in lifecycle stages through
`tinybot.desktop.nativeDebug`. Entries contain only correlation identities,
revisions, counts, statuses, durations, and bounded error messages. Native
payload content is never copied into the debug ring; malformed events and
listener failures also emit an always-visible structured renderer error, which
is persisted by the native backend when Tauri is available.
