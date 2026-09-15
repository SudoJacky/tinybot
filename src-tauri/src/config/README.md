# Configuration
<!-- tinybot-module-fingerprint: sha256:07f5d606c3502578db8e702bd064cc184a78ff8ed489cec4d13bd6e2a47d25f8 -->

`config` owns loading, validating, and persisting Tinybot configuration.

It separates application settings, registry entries, runtime configuration,
secret handling, and the underlying configuration store.

New native configuration snapshots explicitly enable Web/browser and Exec tools.
Existing configuration values are preserved when loading user settings.

`experiments.rs` defines default-off experimental flags. `experiments.actionFusion`
is a boolean validated on configuration load and mutation; invalid or unknown
experimental fields fail validation. The Agent snapshots these values per Turn.

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

The retired `automations.cron_enabled` setting is no longer exposed. Saved
automation scheduling is owned by the desktop automation lifecycle.
