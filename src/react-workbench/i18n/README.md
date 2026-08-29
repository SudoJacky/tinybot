# Renderer Internationalization
<!-- tinybot-module-fingerprint: sha256:d22fb68d6ca49e44682baf7f5a3760d04e3f86aabc4565f9985edc21f1c522a9 -->

`i18n` configures `i18next` for the React renderer and owns the typed English
and Chinese resource bundles.

The standalone Agent Graph route keeps node kinds, the transient Run input,
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
language-neutral. Chat also localizes the slash-menu Skills heading, workspace
source label, inline Skill removal label, and Skill-only fallback prompt.
Context-window usage and latest-call cache-hit labels are localized here while
their Token counts and computed percentage remain language-neutral values.
Provider model settings also localize automatic, fallback, and custom
context-window modes, enabled-model counts, image-input controls, and the
unsupported-image composer message while model IDs and numeric limits stay
language-neutral.
Language-picker option names and descriptions use each target language's own
copy (endonyms) instead of following the currently active interface language.
Sidecar copy lives under the owning `chat` route namespace, including Terminal shell
selection, process state, availability, user-only ownership labels, and
Artifact file-preview boundary, binary, truncation, Office loading, sheet, and
failure states. Spreadsheet cell labels, selection announcements, change
actions, shortcut hints, anchored change-editor controls, and visible composer
annotation cards are localized while paths, sheet names, addresses, cell values,
and requested changes remain user data. PowerPoint slide-navigation labels and
page actions are localized while rendered slide content remains document data.
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
Desktop-pet appearance names and preview descriptions live under the Settings
appearance bundle; persisted `classic` and `dimensional` values remain
language-neutral preference identifiers. Visibility, size, and position-reset
copy lives beside those previews while stored booleans, size IDs, and the null
position remain language-neutral requests.

Session-sidebar whole-row keyboard instructions and live-region move
announcements are localized here. Persisted container and item IDs remain
language-neutral so changing the interface language cannot reset user order.
