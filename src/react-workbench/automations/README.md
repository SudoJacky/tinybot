# Automations
<!-- tinybot-module-fingerprint: sha256:ce74947a79ac2ad6dd7ac6b031968a2f78dcb7be0673d644bd09b262eec1fef4 -->

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
the persisted next-run cursor and missed history entries. A missed task shows
its earliest skipped time and a visible Run now action, also available in history.
Manual execution preserves the missed record. Run buttons check all active runs
so a newer missed entry cannot hide running or waiting work. Provider/session catalogs load before saving;
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

Editor choices reuse `SettingsChoiceList`, including keyboard navigation, selected indicators and disabled items. Its fixed menu placement avoids clipping within the scrollable dialog. Buttons and text inputs reuse `lib/FormControls.css`; an unavailable workspace disables saving.

`useMissedAutomationNotice` runs at the main-window shell, independent of the
current route. While visible, it checks the native store every ten seconds and
on window focus. New unresolved misses are grouped into one warning with a
View tasks action. The last notified run ID per definition is renderer-only
local storage, so returning to a route or restarting does not repeat the notice.
A newer manual/scheduled run suppresses reminders for older misses, and deleted
definitions are excluded. Read/storage failures log and show an error; polling
stops until the window is focused again. Canonical history stays in native storage.
