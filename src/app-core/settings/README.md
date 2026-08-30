# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:c9e38fcb308ab0a51b3ac87446c9bb509b15ea9e4fccdffd63dac3778ae243b6 -->

`settings` owns framework-independent settings contracts, metadata, value
semantics, validation, pane models, and persistence patch construction.

It is the source of truth for secret handling, defaults, commit behavior, and
dirty/reconcile semantics. React pages present these models, while the desktop
Settings adapter performs native reads and writes.

Agent context-window defaults must remain aligned with the Rust runtime.
Provider model settings persist `modelContextWindows` per profile and model;
known models use their automatic capability while unknown models display the
configured legacy fallback or 128K default. The former global window value
remains read-only compatibility data for unknown models. Missing or cleared
strategy values resolve to `compact`.

Custom provider patches declare `supportsReasoningEffort: true` by default and
preserve an explicit `false`, allowing the native request adapters to omit
effort for endpoints that reject it.

Built-in provider presets include Z.ai with a static GLM model list and a
Chat-Completions-only protocol choice, plus Ollama with a keyless local default
endpoint and an initially empty, discoverable model catalog. Presets state
whether an API key is required, so local Providers can become available without
fabricating a credential. The dynamic desktop catalog preserves backend default
API bases, model-discovery support, and the non-secret API-key-configured signal
so both settings entry points present the same connection contract without
exposing credentials.

Default-LLM patches treat `agents.defaults.activeProfile` and
`agents.defaults.model` as one pair. Provider activation builders require a
non-empty enabled/default model and fail instead of persisting a Profile with a
stale model inherited from another Provider.

Provider model settings keep the discovered `models` catalog separate from
`enabledModels`, which controls every shared model selector. Model rows also
persist image-input overrides through `modelCapabilities`; the known defaults
for `glm-5.3-flash` and `deepseek-v4-flash-vision-exp` stay aligned with the
Rust provider resolver.
