# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:a56ceda2cb03bc0e6ffc7ab0ef7eb4b1ff6a787430b0fff9c3d9a852ede224dc -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

The standalone Agent Graph route keeps node kinds, the Input node prompt,
workspace, Agent instructions, Provider/model/effort configuration, catalog
and persistence failures, Edit/View mode guidance, save and Run state, node
execution status, unbounded-canvas guidance, fit-view controls, and validation
guidance in these bundles, while persisted
schema identifiers, Provider/model values, paths, revisions,
Thread IDs, and node-kind values remain language-neutral.
The persisted `condition` node kind is presented as Router in both languages;
route task, label, description, connection, validation, and selected-decision
copy remains renderer-owned while stable route IDs and generated route tokens
remain untranslated.

User-visible copy belongs in `resources/`. Domain identifiers, persisted
values, protocol fields, and diagnostic codes must remain language-neutral.
The Tools & Plugins resource-view labels, Skill/MCP descriptions, and empty
states are localized here; Skill names, MCP IDs, and source paths remain
language-neutral.
Context-window usage and latest-call cache-hit labels are localized here while
their Token counts and computed percentage remain language-neutral values.
Provider model settings also localize automatic, fallback, and custom
context-window modes while model IDs and numeric limits stay language-neutral.
Language-picker option names and descriptions use each target language's own
copy (endonyms) instead of following the currently active interface language.
The retired TinyOS application namespace is intentionally absent. Sidecar copy
lives under the owning `chat` route namespace, including Terminal shell
selection, process state, availability, user-only ownership labels, and
Artifact file-preview boundary, binary, truncation, and failure states.
The Performance Trace route, diagnostic-mode controls, local-export status, and
privacy warning follow the same English and Simplified Chinese resource
boundary; metric and event identifiers remain untranslated.
The Hooks settings copy translates trust state and safety guidance while
retaining event names, hashes, paths, commands, and diagnostic codes verbatim.
Managed-hook form, test-result, and recoverable-remove copy follows the same
boundary, as do inline script-editor status and conflict instructions.
Editor shortcut hints use the platform modifier label while persisted script
content, event names, paths, and trust identifiers remain untranslated.

Desktop pet quick-chat copy also lives in the common renderer bundle so the
pet drop affordance and the independent panel use the same locale. File chips
and file-only prompts reuse the canonical Chat composer bundle instead of a
pet-specific unsupported state. Draft text, filenames, Thread IDs, model
identifiers, and the `desktop-pet` entry-point value remain untranslated
protocol or user content.
