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
them. Times follow this computer's local clock. Missed occurrences are combined
into one invocation on resume; an already running/waiting task will not overlap.
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
