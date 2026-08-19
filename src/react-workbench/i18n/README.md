# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:5d97a9a4af1ed5b795cf13475fa4996f5c0ff233f24f2a0d1613a0687138e1c8 -->

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
Managed-hook form, test-result, and recoverable-remove copy follows the same
boundary, as do inline script-editor status and conflict instructions.
