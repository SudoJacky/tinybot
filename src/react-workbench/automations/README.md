# Automations
<!-- tinybot-module-fingerprint: sha256:8e8f556a9a5f947ddf3a27d6ffe0951318f26da3b3d26ebef69c937ea48e71c5 -->

The lazy Automations route owns definition forms, run selection, and report
presentation. Native storage and execution belong to
[`automation`](../../../src-tauri/src/automation/README.md).

The list supports text search and filters by the most recent run status.
Typography follows the workbench's 18px page titles and 12-13px controls;
compact list rows and 44px setting rows preserve desktop information density.
`AutomationTaskRow` opens the separate `AutomationEditor` dialog; its menu links
to run history. Suggestions populate editable drafts without saving or running.
The editor groups execution and frequency settings and retains the saved
revision if a subsequent run fails. `AutomationSettings` limits conversation
choices to the workspace and models to enabled models under available profiles.

The form saves name, instructions, workspace identity, optional conversation,
provider/profile/model and reasoning effort, schedule, and revision preconditions.
Frequency choices are manual, once, daily, weekdays, and weekly, with a local
start datetime. Scheduling remains in the desktop backend; the UI only displays
the persisted next-run cursor. Provider/session catalogs load before saving;
unavailable paths, catalogs and native failures remain visible.
No draft or canonical execution state is stored in browser local storage.

History refreshes sequentially every three seconds while mounted. Refresh
failure stops polling and exposes an explicit refresh action. Route unmount
does not cancel backend execution. Opening a Thread refreshes the session
catalog and navigates through the desktop shell's existing Chat activation path.

`AutomationReport` loads canonical output on demand and reuses Chat Markdown
and workspace-contained file-link resolution. Text file previews are paginated
and reject revision changes between chunks. Non-text previews are available in
the owning Chat's Artifact sidecar. Errors never become empty successful reports.

`AutomationsRoute.test.tsx` covers creation, execution, file opening, deletion
with history retention, search/status filtering, suggestion drafts, and preserving
the draft and revision after a native failure, and all execution/schedule choices.
