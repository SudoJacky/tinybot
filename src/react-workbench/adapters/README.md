# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:ac013ad965758edc8319c7fc451078e7b12adb40f39ecaede1b260c521487d79 -->

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
listener failures also emit an always-visible console error.
