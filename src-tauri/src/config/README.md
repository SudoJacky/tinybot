# Configuration
<!-- tinybot-module-fingerprint: sha256:ce76f776fd55a7accbded72c0e417347680e09bc3f71d5ef72da87c6e7fbc442 -->

`config` owns loading, validating, and persisting Tinybot configuration.

It separates application settings, registry entries, runtime configuration,
secret handling, and the underlying configuration store.

Provider Profile `enabledModels`, `modelContextWindows`, and
`modelCapabilities` are canonical camelCase configuration. The store accepts
their snake_case aliases on input, and the registry exposes each per-model
collection as profile-scoped JSON.
