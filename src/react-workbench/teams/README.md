# Teams workbench
<!-- tinybot-module-fingerprint: sha256:66e2945d4a8352ae81e43401348cdb675823c46b639faba28d25ae389da8da29 -->

`TeamsRoute` owns the independent Team home and selected run. It uses the shared
workspace registry and a `TeamStore`; native persistence and scheduling remain
in Rust. The home supplies three editable roles using the application default
model. It prepares a plan before any worker can run. Attachments and file lists
are not synthesized.

Home lists runs for the selected workspace and identifies their workspace in each
row. The workspace chooser can register and select a folder directly.
Workspace and member configuration precede submission. `TeamMemberPicker`
opens a searchable selection panel from overlapping pixel portraits. At least
one member stays selected; only selected members and their concurrency count
are submitted. Inline name and responsibility edits survive deselection.
The panel is portaled to the document body to avoid container clipping, restores
trigger focus on Escape, and closes on outside interaction. Planning disables
the picker and exposes an explicit busy state.

`TeamMemberAvatar` uses the bundled twelve-portrait atlas. Default roles have
fixed portraits; other member IDs map deterministically into the same atlas.
Renaming or reordering members preserves their portraits in Home and details.
Picker tests cover keyboard search, selection bounds, edit retention and busy
state; the route test verifies the selected roster reaches plan preparation.

`TeamDetail` keeps one page through plan confirmation, execution and results.
`TeamTaskFeed` presents overall progress in dependency order, with reported
summaries, artifact counts, attempt times and explicit dependency/member/capacity
wait reasons. The inspector exposes real task
instructions, prerequisites, output, errors and every attempt's standard Thread.
The latest attempt is visible by default; earlier attempts are folded with their
original errors and Thread links. `useTeamActivity` observes only running tasks
and the inspected task through Chat's canonical timeline and shared event
subscription. Its read path does not select a Chat session. `TeamActivity` reuses
Chat Markdown, reasoning disclosures, tool activity and patch diff components.
The projection retains recorded reasoning, tool arguments/results/timing, plan
steps and data views in execution order. Tool details expand in place; long
previews can reveal their full recorded content. It retains full messages and
shows the last five entries, loading earlier entries into the view in groups of
20 on request. The complete execution record remains one click away. User input
is excluded; reasoning is shown only when present in the canonical projection.
Live patches supersede late initial reads;
read and stream errors remain visible with an explicit refresh action.
Updates are batched and subscriptions are disposed when the observed attempts
change or the view unmounts. Activity file links use the same inline current-file
preview as results, scoped to the selected attempt.

`TeamMemberDock` stays below the workspace and selects active work or the member's
most recently started attempt, falling back to the first assigned task. Completed
members remain selectable. A member with pending work is not labeled completed.
The inspector's member-task disclosure selects earlier assignments. Explicit
selection survives live updates. Task/attempt scroll positions and activity
disclosure state survive switching tasks within this detail view; retries get
their own reading state. Assignment details collapse once an attempt exists.
Markdown file links open a shared inline Artifact preview in the result surface.
The Message board tab lists all completed attempts with author, time, summary,
unresolved issues, artifact references, and execution-record navigation.
TeamMessage also renders final/task results. Artifact buttons explicitly load
verified byte pages; no file is fetched on render. Next section replaces the
preview, and failures remove stale content and show the backend error. A separate
Preview current file action supports images, Office documents and paginated text
through the shared workspace reader; it does not replace verified historical
artifact reads. Result previews omit Chat editing and restoration actions.
The Files tab aggregates reported artifacts by task and attempt, including the
producer, attempt number and completion time. Latest-attempt artifacts are
visible first; historical attempts are collapsed. Task links return to the
inspector. It reuses `TeamArtifacts` for verified reads and current-file previews,
performs no eager file reads, and discards late reads after changing preview mode.
The result tab renders the successful final task output, including when the
run stopped after producing that output.

The Usage tab queries the shared token-usage ledger for this run. It shows
reported totals and task/purpose breakdowns, including planning and eligible
background work, missing usage and retries, plus paginated request origins.
It reuses Settings' usage components rather than accumulating Thread counters.

`TeamPlanEditor` changes titles, assignments, instructions, dependencies and
final-task selection for an idle run. Attempted definitions are locked. The
editor captures its starting revision and preserves edits on save conflicts;
backend validation enforces an acyclic plan and complete final synthesis.
Editing focuses the first field, keeps Save/Discard visible in short windows,
and disables Files, Message board, Result and Usage until editing ends. Closing restores trigger focus.

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
states. No estimated progress or invented coordinator messages are shown. Running rows display
an excerpt of the latest reported activity; the inspector exposes the full public activity
without navigating away from Teams.
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
The bounded header exposes the full goal through a disclosure, and the bottom
member dock keeps long names inside a horizontally scrolling strip. Projects scroll
inside the sidebar while navigation and Settings remain available.

A container query uses the available main-pane width, including sidebar resizing.
Below 680px, selecting a task opens its detail in the same area. Back restores
focus to the selected task. Result and plan editing use the full workspace width;
plan fields scroll above persistent Save/Discard controls. Shared fixed-position
choice menus choose an opening direction without being clipped by the panes.
Progress cards put state below the title and summary. Completed states mix semantic green with foreground
ink to remain readable in both light and dark themes.
Markdown continues to use the existing Chat renderer and its table/code scrolling.

`ChatTeamCard` embeds a recruitment roster in the Chat timeline. Its collapsed
state does no Team I/O. Expansion loads the board; selecting an employee opens
a thread-scoped Team tab in the shared Sidecar and reads the selected attempt through the canonical
timeline projection. The inspector reuses `TeamActivity`, `TeamMessage`, task
statuses, portraits and the member dock from the independent Team route. It shows
role/task instructions, dependency navigation, activity and reported results.
Open boards refresh every two seconds while running and every five seconds while
idle, so later recruitment waves appear. Only running worker history is refreshed;
failures expose explicit retry and late
reads are discarded after selection changes. Activity disclosure and reading
positions survive employee switches. No employee history enters the parent
conversation or ordinary session list. `ChatTeamPanel` owns the employee content;
Sidecar owns tabs, width, expansion, hiding and narrow-window overlay geometry.
Escape/Hide restores roster focus. Browser, Artifact and Terminal tabs coexist
with Team tabs; returning to a Team tab retains the selected employee. Switching
conversations scopes out its Team tabs. Closing a Team tab never cancels the run.

The Chat header also lists durable Team runs, including independent runs without
`parentThreadId`. Opening one assigns only the Sidecar display scope; it never
rewrites ownership or inserts employee messages into Chat. A draft Chat has a
temporary display scope so this history remains reachable before a Thread exists.
The Sidecar inspector exposes every recorded attempt, task output and error.
Files reuse `TeamFiles` and its verified historical artifact reads alongside the
separate current-file preview; Usage reuses `UsageHistory` filtered by run ID.
Pause, cancel, resume and per-task retry use the same native revision-checked
operations as the independent route. A long-running execute request does not
block pause or cancel. Failed, interrupted or cancelled tasks require explicit
retry before resume; successful work is not replayed. Control errors remain
visible for their run, and older polls cannot replace newer control snapshots.

Member editing exposes Research, Execution and Review tool presets. The selected
profile travels with the member into plan preparation and the durable run;
recruitment cards also show its capabilities in assignment details. Research
defaults to browsing/search/patches, Execution inherits permitted work tools,
and Review reads files and Team handoffs. All employee outputs are internal
handoffs; only the main Agent publishes final conclusions and data views.
