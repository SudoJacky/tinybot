# Run a saved workspace task

1. Import a project workspace in Chat and configure a working default model.
2. Open **Scheduled** below Tinybot in the Chat sidebar (or **Resources >
   Automations**), then **New automation**. Suggestions also open editable drafts.
3. Name the task "Project change report", select the imported workspace, and
   enter: "Inspect recent Git changes. Write a concise report to
   reports/project-changes.md and include a Markdown link to that file in your
   final response." Specify a different output path when previous reports must
   remain separate files.
4. Choose **Runs in**: a new conversation each time, or an existing conversation
   in the selected workspace. Changing workspaces resets the conversation choice.
   Select an available **Provider**, one of its enabled **Model** choices, and
   **Reasoning effort**, or retain application/provider defaults.
5. Under **Frequency**, choose manual, once, daily, weekdays, or weekly, and a
   start date/time. Weekly repeats on the starting weekday; weekdays skip weekends.
   Save, or choose **Save and run** to also run immediately. **Run now** remains
   available on the row independently of the schedule.
6. Switch to another route, then return. The run continues in the native backend.
   Open **Run history**, then **Instructions and configuration used** to inspect
   its saved inputs. The list supports search and latest-run status filters.
7. After completion, select **View report** and click the generated file link.
   Text files open in a bounded preview with **Load more** where needed. Use
   **Open conversation and report** for the complete timeline, errors, questions,
   and Office/image Artifact previews.
8. Edit the definition and run again. Check that each invocation uses the selected conversation behavior and earlier
   history retains the original instructions and model.
9. Restart Tinybot and verify that the definition, history, and report remain
   accessible. A run interrupted by process exit is shown as interrupted on first
   access; explicitly choose **Run now** to start a new invocation.
10. Delete the definition through **Edit > Delete task**. Its runs remain under
   **All runs**, and its conversations and output files remain intact.

For failure checks, make the selected workspace unavailable before running or
select unavailable default model configuration. The error must be visible before
execution. A provider failure after dispatch must retain the run and owning
Thread with error details. Restore the workspace/configuration and explicitly
start a new run. Deleting a definition does not stop an already running invocation.

The desktop backend checks schedules every five seconds while Tinybot is running.
Closing a page or hiding the window keeps schedules active; exiting Tinybot stops
them. Times follow this computer's local clock. On startup, overdue occurrences
are skipped. A gap longer than 15 seconds between successful scheduler checks
(including sleep) also skips occurrences that became due during the gap. Shorter
delays are treated as normal timer jitter. Each recovery records one **Missed**
history entry per affected task, with the earliest skipped scheduled time, and
advances recurring schedules to a future occurrence. A missed once-only task
has no next occurrence. Nothing is automatically replayed. Use **Run now** on
the task or its missed history entry to start a new invocation; the missed record
remains in history. The **Needs attention** filter includes tasks whose latest
entry is missed. An already running/waiting task will not overlap; an occurrence
already blocked by that work retains its existing delayed-dispatch behavior.
On daylight-saving gaps, nonexistent occurrences are skipped; repeated local
times use the first occurrence. Switch to manual frequency to stop future triggers.
Ordinary edits preserve the next-run cursor; change the schedule/start time to
rearm a completed once-only task. Scheduled preflight errors appear in run history.
Notifications and execution budgets are separate work. Output files follow normal Agent workspace
semantics; automation history does not make immutable copies of generated files.

Automated verification uses a deterministic provider with the real Thread and
tool execution path; it does not consume a user's live model quota:

```text
cargo test --manifest-path src-tauri/Cargo.toml --lib automation::saved_tests
npx vitest run src/react-workbench/automations/AutomationsRoute.test.tsx
```

Missed-run walkthrough:

1. Save a once-only task a minute in the future, then exit Tinybot before it is due.
2. Restart after that time. Confirm the task shows **Missed**, its original scheduled
   time, no generated conversation, and a visible **Run now** button.
3. Restart again. Confirm the same history entry remains and no execution starts.
4. Choose **Run now** and verify the report is generated in a new normal run.
   The missed history entry must remain inspectable.
5. Repeat with a weekly task, checking that its next occurrence is in the future
   and stays unchanged by Run now. Repeat by sleeping the machine across the due
   time for more than 15 seconds while Tinybot is running.
