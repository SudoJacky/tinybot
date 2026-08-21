# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:1c37c2db658cd39c6a67a88a96157aa4c5c6d290507315f6f0111751549be924 -->

`adapters` implements renderer store interfaces over Tinybot's native and
app-core modules. It owns event projection and the Settings, Tools, and
Workspace store adapters used by `createDesktopAppServices()`.

Adapters may translate transport data into renderer contracts, but they do not
render React views or become a second authority for chat, settings, or
workspace state.

The desktop Settings adapter projects the native Provider catalog into the
shared Chat model catalog. Only enabled Providers whose runtime status is
`available` or `ready` contribute selectable models, so Chat and Agent Graph
cannot select models from configured-but-unavailable connections.

The native event bridge records opt-in lifecycle stages through
`tinybot.desktop.nativeDebug`. Entries contain only correlation identities,
revisions, counts, statuses, durations, and bounded error messages. Native
payload content is never copied into the debug ring; malformed events and
listener failures also emit an always-visible structured renderer error, which
is persisted by the native backend when Tauri is available.

The bridge listens for native browser snapshots and diagnostics but no longer
projects the retired `tinyos:host-operation` event into Chat state.
