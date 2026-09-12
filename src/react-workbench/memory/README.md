# Memory Route
<!-- tinybot-module-fingerprint: sha256:a27b149e93b94377c536d3356f4cc742eb5e0cf2eb0a901457960ad5e5686db4 -->

`memory` provides the lazy desktop manager for Tinybot's active long-term
memory. `MemoryPage` loads revisioned entries through `MemoryStore`, groups them
by scope, and owns search, scope filtering, selection, and mutation feedback.

`MemoryEditor` handles adding and editing a single fact, choosing user or
workspace scope, and confirming single or batch deletion. Dialogs share the
focus trap and focus restoration hook. Errors retain the draft; mutations use
the revision captured when the dialog opens and never optimistically remove
entries. Successful responses replace the displayed snapshot.

SQLite remains authoritative. User-created or edited entries are protected
from automatic consolidation. The page explains that changes apply to new
independent chats, existing snapshots remain fixed, and deleted facts may be
learned again. Native validation and revision checks live in `memory/store`.
