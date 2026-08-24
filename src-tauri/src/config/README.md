# Configuration
<!-- tinybot-module-fingerprint: sha256:c74cc0b89d78d0ae24e03fb5e17935c6a6efeac05414ca885cf8f6f11474d166 -->

`config` owns loading, validating, and persisting Tinybot configuration.

It separates application settings, registry entries, runtime configuration,
secret handling, and the underlying configuration store.

Provider Profile `modelContextWindows` is canonical camelCase configuration;
the store accepts `model_context_windows` on input and the registry exposes the
per-model entries as profile-scoped JSON.
