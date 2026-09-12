# Memory Route
<!-- tinybot-module-fingerprint: sha256:6a03efe89722e9858588c5105efef9efaf6eb8f926649d30bcdfd8fc87a85082 -->

`memory` provides the lazy desktop manager for Tinybot's active long-term
memory. `MemoryPage` loads revisioned entries through `MemoryStore`, groups them
by scope, and owns search, scope filtering, selection, and mutation feedback.

`MemoryEditor` handles adding and editing a single fact, choosing user or
workspace scope, and confirming single or batch deletion. Dialogs share the
focus trap and focus restoration hook. Errors retain the draft; mutations use
the revision captured when the dialog opens and never optimistically remove
entries. Successful responses replace the displayed snapshot.

Scope filtering and editing reuse `SettingsChoiceList` and its shared popover
styles. Main inputs and buttons share a 40px height; compact row actions are
32px square. Narrow layouts put search on its own row. Memory button rules
exclude shared choice controls so their selected, hover, and focus styles remain
owned by the shared component.

SQLite remains authoritative. User-created or edited entries are protected
from automatic consolidation. The page explains that changes apply to new
independent chats, existing snapshots remain fixed, and deleted facts may be
learned again. Native validation and revision checks live in `memory/store`.
