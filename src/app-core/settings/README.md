# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:f72f1a67adad029c0834c861e89543feb02a3dfe8a74b731909cc3b53a89e831 -->

`settings` owns framework-independent settings contracts, metadata, value
semantics, validation, pane models, and persistence patch construction.

`composerPreferences` persists the device-local rich-text composer preference,
enabled when unset. Same-window change events and storage events keep settings,
chat, and quick-chat subscribers current without adding a native config field.

Built-in cloud provider presets carry their official API-key console URL into
the provider card model; keyless local and custom providers omit this link.
The DeepSeek preset lists `deepseek-flash` first, matching the native default.

It is the source of truth for secret handling, defaults, commit behavior, and
dirty-state semantics. React pages present these models, while the desktop
Settings adapter performs native reads and writes.

Web/browser tools and Exec tools default to enabled when their configuration
flags are absent; explicit disabled values remain disabled in the settings form.

`experimentalSettings.ts` validates the Labs flag snapshot and builds a narrow
`experiments.actionFusion` patch. Action Fusion defaults to disabled; malformed
flag values are errors rather than implicit false values.

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
Memory-LLM patches similarly persist `memory.activeProfile` and `memory.model`
as one optional pair. Selecting the global-default mode emits explicit remove
operations for both fields instead of copying the current global values.
The retired general Provider Auto selector is not projected or persisted;
Provider routing is presented through the Profile-based Provider & Models flow.

Agent Defaults exposes runtime limits and an IANA time-zone value, but does not
duplicate Provider routing or model temperature controls. Max output tokens is
optional: missing or cleared values stay absent so the selected Provider applies
its own model default. New defaults use the host system time zone reported by
the renderer, with UTC as the validation-safe fallback, and persisted zones must
belong to the runtime-supported IANA catalog.

Provider model settings keep the discovered `models` catalog separate from
`enabledModels`, which controls every shared model selector. Model rows also
persist image-input overrides through `modelCapabilities`; the known defaults
for `glm-5.3-flash`, `deepseek-flash`, and the legacy Flash aliases stay aligned with the
Rust provider resolver.

The default light appearance uses a near-white canvas, cooler navigation chrome,
and graphite emphasis. Loading the unchanged previous default palette upgrades
it to these defaults; customized palettes and the dark theme are preserved.
