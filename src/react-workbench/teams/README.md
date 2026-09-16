# Teams workbench
<!-- tinybot-module-fingerprint: sha256:c73fdca9f5e324ac2c106b553a6c16a6ed2814a299c262e77feab26394f6e0eb -->

`TeamsRoute` owns the independent Team home and selected run. It uses the shared
workspace registry and a `TeamStore`; native persistence and scheduling remain
in Rust. The home supplies three editable roles using the application default
model. It prepares a plan before any worker can run. Attachments and file lists
are not synthesized.

Home lists runs for the selected workspace and identifies their workspace in each
row. Workspace and member configuration precede submission; expanded member
fields use the full form width. Planning exposes an explicit busy state.

`TeamDetail` keeps one page through plan confirmation, execution and results.
Dependency rows retain topological order. The inspector exposes real task
instructions, prerequisites, output, errors and every attempt's standard Thread.
File links open that owning execution record using the existing Chat navigation.
The result tab renders the successful final task output, including when the
run stopped after producing that output.

`TeamPlanEditor` changes titles, assignments, instructions, dependencies and
final-task selection for an idle run. Attempted definitions are locked. The
editor captures its starting revision and preserves edits on save conflicts;
backend validation enforces an acyclic plan and complete final synthesis.
Editing focuses the first field, keeps Save/Discard visible in short windows,
and disables the Result tab until editing ends. Closing restores trigger focus.

`useTeamRuns` separates long-running execute invocations from polling and
revision-checked controls. Older snapshots cannot replace newer revisions.
Controls show their locally accepted intent until scheduling settles. Polling
failures are visible and Refresh restarts polling. All known running runs are
polled, including from Home. The shell retains the Team surface across navigation,
preserving drafts, pending operations, selection and scroll during the app session.
Leaving the route does not stop the native scheduler. Pause intent
itself is not durable across reloads. Retry is explicit, preserves history and
requeues one failed/interrupted/cancelled task; all such tasks must be handled
before Resume becomes available.

`teamPresentation` derives pending labels from the containing run and dependency
states. No estimated progress, invented activity or live tool stream is shown.
Running task rows show a reduced-motion-aware spinner and actual attempt elapsed
time. Member and running-count shortcuts select and reveal the task. A polite
status summary announces progress without announcing every timer tick.
Tests cover payloads, revision races, pending execution controls, dependency
ordering, explicit start/retry, locked attempts and preserved plan edits.

## Shared appearance

Teams uses `lib/FormControls.css` for buttons, primary actions, text inputs,
focus and disabled states. Workspace, member assignment and final-task pickers
use `SettingsChoiceList`, including its shared popover and keyboard behavior.
The sidebar reuses Chat's `react-session-list` styles and resize/collapse
component, including saved width, theme background and transparency. Page and
header chrome reuse `react-workbench-page` and session-tab styles. Route CSS
retains Team layout, task selection and state presentation; it does not define
another generic control skin or fixed role palette.

## Content sizing and desktop navigation

The detail route reserves the remaining window height for independently scrolling
list and inspector panes; task count and report length do not grow the page.
The bounded header exposes the full goal through a disclosure, and the roster
keeps long member names inside a horizontally scrolling strip. Projects scroll
inside the sidebar while navigation and Settings remain available.

A container query uses the available main-pane width, including sidebar resizing.
Below 680px, selecting a task opens its detail in the same area. Back restores
focus to the selected task. Result and plan editing use the full workspace width;
plan fields scroll above persistent Save/Discard controls. Shared fixed-position
choice menus choose an opening direction without being clipped by the panes.
Task panes narrower than 460px put state below the title rather than squeezing
the title between columns. Completed states mix semantic green with foreground
ink to remain readable in both light and dark themes.
Markdown continues to use the existing Chat renderer and its table/code scrolling.
