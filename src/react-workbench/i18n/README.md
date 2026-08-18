# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:1d3f358e1d4e488343065cb5baec4d5b195658c27accca671584e49d32cfdb36 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The retired TinyOS application namespace is intentionally absent. Sidecar copy
lives under the owning `chat` route namespace.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
