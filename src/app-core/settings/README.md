# Settings Application Core
<!-- tinybot-module-fingerprint: sha256:72d1cc4537bd38988b0d5d640a10500fe59ef209035e0df4ba997951f292ec1b -->

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
Chat-Completions-only protocol choice. The dynamic desktop catalog preserves
backend default API bases and model-discovery support so both settings entry
points present the same connection contract.
