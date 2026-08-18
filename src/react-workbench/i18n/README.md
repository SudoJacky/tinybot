# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:f19aa7072186b3de87ad5194cd6809c8815e12c4e7f86da0fd4b5f2c9a639369 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The retired TinyOS application namespace is intentionally absent; future
Sidecar surfaces should add copy under their owning route namespace.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
