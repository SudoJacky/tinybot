# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:21a9cc60e0e3ea09adbd56c214463ce1a39746175ad55a7fbb4c0e61ac81f8b4 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
