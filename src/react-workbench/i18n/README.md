# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:862d0524a538164fe3a531f5524d4302a40ca0e4915ae974adc032253ec4e9b9 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

The standalone Agent Graph route keeps node kinds, the Input node prompt,
workspace, Agent instructions, Provider/model/effort configuration, catalog
and persistence failures, Edit/View mode guidance, save and Run state, node
execution status, and validation guidance in these bundles, while persisted
schema identifiers, Provider/model values, paths, revisions,
Thread IDs, and node-kind values remain language-neutral.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
Language-picker option names and descriptions use each target language's own
copy (endonyms) instead of following the currently active interface language.
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
Editor shortcut hints use the platform modifier label while persisted script
content, event names, paths, and trust identifiers remain untranslated.
