# Automations
<!-- tinybot-module-fingerprint: sha256:f10d1bce6ce0429d5adc47423fd19d2586785bde640efdb0818c7090d71f96aa -->

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
Unsaved editor values and their saved baseline persist in localStorage across
route changes and restarts. Closing or replacing a dirty editor asks before
discarding. Canonical definitions and execution state remain native. The editor
can register and select a workspace folder without leaving the form. Deleting
a saved task requires confirmation and retains its execution history.

History refreshes sequentially every three seconds while mounted. Refresh
failure stops polling and exposes an explicit refresh action that restarts polling. Route unmount
does not cancel backend execution. Opening a Thread refreshes the session
catalog and navigates through the desktop shell's existing Chat activation path.

`AutomationReport` loads canonical output on demand and reuses Chat Markdown
and workspace-contained file-link resolution. The shared inline Artifact preview supports text, images and Office files.
Text pages reject revision changes; binary reads bind to the observed revision,
and closing releases resources. Errors never become empty successful reports.

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
