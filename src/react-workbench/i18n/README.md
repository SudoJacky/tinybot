# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:05a3bf92868fa0441a8547caa6c915cb1fefebc64bfb07c083cc7150cd381de8 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The Performance Trace route follows the same English and Simplified Chinese
resource boundary; metric and event identifiers remain untranslated.
