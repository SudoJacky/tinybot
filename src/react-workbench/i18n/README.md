# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:1b398b924b44b8ec5968c70073b0f2b14d405c3f8c7c472ad8e09f1ea8ac07b7 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The retired TinyOS application namespace is intentionally absent. Sidecar copy
lives under the owning `chat` route namespace, including Terminal shell
selection, process state, availability, and user-only ownership labels.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
The Hooks settings copy translates trust state and safety guidance while
retaining event names, hashes, paths, commands, and diagnostic codes verbatim.
