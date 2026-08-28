# Desktop Adapters
<!-- tinybot-module-fingerprint: sha256:ce686f8d65519f6a643a373e606ed9bff9eb630434d233712b5fd995886aff14 -->

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
`available` or `ready` contribute selectable models, and only their
`enabledModels` entries are exposed. The projection also carries resolved
image-input capability into the shared model contract, so Chat, quick chat, and
Agent Graph cannot select disabled models or models from unavailable
connections.

The same adapter is the only renderer boundary that persists the default Chat
Provider/model selection. It writes the native `activeProfile`/`model` pair
before mirroring the renderer preference. Model-catalog loading also reconciles
an explicitly selected native Profile whose model belongs to another Provider,
using a valid renderer preference first and the active Profile's default model
second; the repair is logged and persistence failures remain visible.

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
