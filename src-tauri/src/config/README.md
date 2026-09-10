# Configuration
<!-- tinybot-module-fingerprint: sha256:0f5462ff22fc533ebbc47c53d522cf57a45e3b13a211b0012b20df0f95e75499 -->

`config` owns loading, validating, and persisting Tinybot configuration.

It separates application settings, registry entries, runtime configuration,
secret handling, and the underlying configuration store.

New native configuration snapshots explicitly enable Web/browser and Exec tools.
Existing configuration values are preserved when loading user settings.

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
