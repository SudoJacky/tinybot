# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:505cf24c8acab1a94281c30e9e9393608fede0d354958737bcc998bad83df6e5 -->

`adapters` implements renderer store interfaces over Tinybot's native and
app-core modules. It owns event projection and the Settings, Tools, and
Workspace store adapters used by `createDesktopAppServices()`.

Adapters may translate transport data into renderer contracts, but they do not
render React views or become a second authority for chat, settings, or
workspace state.

The workspace Adapter keeps default-workspace directory and chunk browsing
separate from Thread-scoped file preview reads. For the latter it forwards only
the Thread ID and file path to the native API, preserving Rust as the authority
for workspace selection and path containment.

The desktop Settings adapter projects the native Provider catalog into the
shared Chat model catalog. Only enabled Providers whose runtime status is
`available` or `ready` contribute selectable models, so Chat and Agent Graph
cannot select models from configured-but-unavailable connections.

The desktop Tools adapter normalizes callable tools, MCP server source/status,
and Skill summaries into the renderer-facing `ToolCatalogSummary`. It uses the
dedicated Skill-detail route when the UI requests one entry; filesystem reads
remain in Rust. Catalog callers may provide a conversation working directory,
which the adapter URL-encodes for Rust-owned workspace Skill and MCP discovery.

The native event bridge records opt-in lifecycle stages through
`tinybot.desktop.nativeDebug`. Entries contain only correlation identities,
revisions, counts, statuses, durations, and bounded error messages. Native
payload content is never copied into the debug ring; malformed events and
listener failures also emit an always-visible structured renderer error, which
is persisted by the native backend when Tauri is available.

The bridge listens for native browser snapshots and diagnostics but no longer
projects the retired `tinyos:host-operation` event into Chat state.
