# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:1d45e2fafdd48d20d5978d51cd1ccdf413f79abda30baab603e70372c38b62b4 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
