# Configuration
<!-- tinybot-module-fingerprint: sha256:e07de5bbcffa1560dbfdcc280569c3e46ca46f72d2d4737b1a6c4375999bac79 -->

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
