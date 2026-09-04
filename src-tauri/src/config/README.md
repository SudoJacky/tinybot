# Configuration
<!-- tinybot-module-fingerprint: sha256:e5a85df4cde69db91832c8019c647c55117d3af00f8e4b8e7d9bd8ac764e1462 -->

`config` owns loading, validating, and persisting Tinybot configuration.

It separates application settings, registry entries, runtime configuration,
secret handling, and the underlying configuration store.

The Rust store is the schema migration boundary. Schema v1 files are backed up
once as `config.json.v1.bak` and migrated atomically to schema v2. Provider Auto
routing is retired in v2: a legacy Auto value is removed only when a valid
`agents.defaults.activeProfile` exists; otherwise the store reports an invalid
configuration and leaves the file untouched for repair.

Provider Profile `enabledModels`, `modelContextWindows`, and
`modelCapabilities` are canonical camelCase configuration. The store accepts
their snake_case aliases on input, and the registry exposes each per-model
collection as profile-scoped JSON.

Long-term Memory may optionally set `memory.activeProfile` and `memory.model`
as one Provider/model override. Removing both fields restores the global Agent
defaults; changing or clearing either field refreshes Provider runtime state.
