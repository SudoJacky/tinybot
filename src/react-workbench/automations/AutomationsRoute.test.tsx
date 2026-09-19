import { pickDesktopWorkspaceDirectory } from "../../app-core/native/desktopNativeWorkspacePicker";
// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServices } from "../services";
import type { AutomationSnapshot, SaveAutomation, SavedAutomation } from "../../app-core/native/desktopNativeAutomations";
import AutomationsRoute from "./AutomationsRoute";

vi.mock("../../app-core/native/desktopNativeWorkspacePicker", () => ({ pickDesktopWorkspaceDirectory: vi.fn() }));

afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); });
it("resumes live updates after an explicit refresh recovers a polling failure", async () => {
  vi.useFakeTimers();
  try {
    const { services, appServices } = fixture();
    services.automationStore.list.mockRejectedValueOnce(new Error("Disconnected"));
    render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toContain("Disconnected");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh" })); });
    const recoveredCalls = services.automationStore.list.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(services.automationStore.list.mock.calls.length).toBeGreaterThan(recoveredCalls);
  } finally { cleanup(); vi.useRealTimers(); }
});

it("keeps unsaved automation edits when discarding is declined", async () => {
  const confirm = vi.fn(() => false); vi.stubGlobal("confirm", confirm);
  try {
    const { appServices } = fixture(); const user = userEvent.setup();
    render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "New automation" }));
    await user.type(screen.getByLabelText("Name"), "Keep my work");
    await user.click(screen.getByRole("button", { name: "Close task settings" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Keep my work");
  } finally { vi.unstubAllGlobals(); }
});
async function choose(user: ReturnType<typeof userEvent.setup>, label: string, option: string | RegExp) {
  await user.click(await screen.findByRole("button", { name: new RegExp(`^${label}:`) }));
  await user.click(screen.getByRole("menuitemradio", { name: option }));
}
function fixture(initial: AutomationSnapshot = { definitions: [], runs: [] }) {
  let snapshot = initial;
  const services = {
    automationStore: {
      list: vi.fn(async () => snapshot),
      save: vi.fn(async (input: SaveAutomation) => {
        const definition: SavedAutomation = { id: input.id ?? "report", name: input.name, instructions: input.instructions, workspacePath: input.workspacePath, revision: (input.expectedRevision ?? 0) + 1, modelPolicy: "inherit_default", updatedAtMs: 1, execution: input.execution, schedule: input.schedule };
        snapshot = { ...snapshot, definitions: [definition] }; return definition;
      }),
      delete: vi.fn(async () => { snapshot = { ...snapshot, definitions: [] }; }),
      run: vi.fn(async () => {
        const run = { id: "run-1", definition: snapshot.definitions[0], effectiveModel: { model: "model-a", provider: "provider-a", apiMode: "responses" }, threadId: "thread-1", status: "completed" as const, error: null, startedAtMs: 1, finishedAtMs: 2, stopReason: "final_response" };
        snapshot = { ...snapshot, runs: [run, ...snapshot.runs] }; return run;
      }),
      output: vi.fn(async () => "[Report](report.md)"),
    },
    workspaceRegistryStore: { register: vi.fn(async (path: string) => ({ path, name: "New project", exists: true, addedAtMs: 1, updatedAtMs: 1 })), list: vi.fn(async () => [{ path: "D:/project", name: "Project", exists: true, addedAtMs: 1, updatedAtMs: 1 }]) },
    sessionStore: { list: vi.fn(async () => [
      { id: "existing", title: "Existing report chat", workingDirectory: "D:/project", updatedAtMs: 1 },
      { id: "other", title: "Other workspace chat", workingDirectory: "D:/other", updatedAtMs: 1 },
    ]) },
    settingsStore: { loadProviderSettings: vi.fn(async () => ({ providers: [
      { id: "openai", profileId: "work", label: "Work provider", enabled: true, status: "available", defaultModel: "model-a", supportsReasoningEffort: true, models: [
        { id: "model-a", label: "Model A", enabled: true }, { id: "model-b", label: "Model B", enabled: true }, { id: "disabled", label: "Disabled model", enabled: false },
      ] },
      { id: "disabled", profileId: "disabled", label: "Disabled provider", enabled: false, status: "not_ready", models: [] },
    ] })) },
    workspaceStore: { readThreadFile: vi.fn(async () => ({ path: "report.md", content: "Verified project report", contentType: "text", revision: "r1", sizeBytes: 24 })) },
  };
  return { services, appServices: services as unknown as AppServices };
}

it("creates, runs, previews the report and retains history after deleting the definition", async () => {
  const { services, appServices } = fixture(); const open = vi.fn(async () => {});
  const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={open} />);
  await user.click(screen.getByRole("button", { name: "New automation" }));
  await user.type(screen.getByLabelText("Name"), "Weekly report");
  await choose(user, "Workspace", /Project/);
  await user.type(screen.getByLabelText("Instructions and output location"), "Write report.md");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(await screen.findByRole("button", { name: "Run now" }));
  await user.click(await screen.findByRole("button", { name: "View report" }));
  await user.click(await screen.findByRole("link", { name: "Report" }));
  expect(await screen.findByText("Verified project report")).toBeTruthy();
  expect(services.workspaceStore.readThreadFile).toHaveBeenCalledWith({ path: "report.md", threadId: "thread-1" });
  await user.click(screen.getByRole("button", { name: "Open conversation and report" }));
  expect(open).toHaveBeenCalledWith("thread-1");
  await user.click(screen.getByRole("button", { name: "Edit" }));
  vi.stubGlobal("confirm", vi.fn(() => true));
  await user.click(screen.getByRole("button", { name: "Delete task" }));
  expect(services.automationStore.delete).toHaveBeenCalledWith("report", 1);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Run now" })).toBeNull());
  expect(screen.getByText("Completed")).toBeTruthy();
});

it("keeps an edited draft and exposes native validation failures", async () => {
  const { services, appServices } = fixture(); const user = userEvent.setup();
  services.automationStore.save.mockRejectedValue(new Error("Workspace unavailable"));
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "New automation" }));
  await user.type(screen.getByLabelText("Name"), "Report");
  await choose(user, "Workspace", /Project/);
  await user.type(screen.getByLabelText("Instructions and output location"), "Create report");
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Workspace unavailable");
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Report");
});

it("persists conversation, provider/model, effort and schedule selections across editing", async () => {
  const { services, appServices } = fixture(); const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /Project weekly review/ }));
  await choose(user, "Workspace", /Project/);
  await user.click(screen.getByRole("button", { name: /^Runs in:/ }));
  expect(screen.queryByRole("menuitemradio", { name: "Other workspace chat" })).toBeNull();
  await user.click(screen.getByRole("menuitemradio", { name: "Existing report chat" }));
  await user.click(screen.getByRole("button", { name: /^Provider:/ }));
  expect(screen.queryByRole("menuitemradio", { name: "Disabled provider" })).toBeNull();
  await user.click(screen.getByRole("menuitemradio", { name: "Work provider" }));
  await user.click(screen.getByRole("button", { name: /^Model:/ }));
  expect(screen.queryByRole("menuitemradio", { name: "Disabled model" })).toBeNull();
  await user.click(screen.getByRole("menuitemradio", { name: "Model B" }));
  await choose(user, "Reasoning effort", "High");
  await choose(user, "Repeat", "Weekdays");
  expect((screen.getByLabelText("Starts at") as HTMLInputElement).value).not.toBe("");
  await user.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Run now" });
  expect(services.automationStore.save).toHaveBeenLastCalledWith(expect.objectContaining({
    execution: { threadId: "existing", provider: "openai", profile: "work", model: "model-b", reasoningEffort: "high" },
    schedule: { repeat: "weekdays", startAtMs: expect.any(Number) },
  }));
  await user.click(screen.getByRole("button", { name: /Project weekly review Weekdays/ }));
  expect(await screen.findByRole("button", { name: "Model: Model B" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Runs in: Existing report chat" })).toBeTruthy();
});

it("creates a suggestion draft without running, then searches and filters saved tasks", async () => {
  const { services, appServices } = fixture(); const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /Project weekly review/ }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Project weekly review");
  expect((screen.getByLabelText("Instructions and output location") as HTMLTextAreaElement).value).toContain("reports/weekly-review.md");
  expect(services.automationStore.save).not.toHaveBeenCalled();
  expect(services.automationStore.run).not.toHaveBeenCalled();
  await choose(user, "Workspace", /Project/);
  await user.click(screen.getByRole("button", { name: "Save" }));
  await user.click(await screen.findByRole("button", { name: "Run now" }));
  await user.click(await screen.findByRole("button", { name: "Back to tasks" }));
  await user.click(screen.getByRole("button", { name: "Running" }));
  expect(screen.queryByRole("button", { name: "Run now" })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Completed" }));
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  await user.type(screen.getByRole("searchbox"), "not-present");
  expect(screen.getByText("No tasks match this search or filter.")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Clear search" }));
  expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
});

it("retains the saved revision when save-and-run fails so retry can succeed", async () => {
  const { services, appServices } = fixture(); const user = userEvent.setup();
  await services.automationStore.save({ name: "Report", instructions: "Write report.md", workspacePath: "D:/project" });
  services.automationStore.run.mockRejectedValueOnce(new Error("Provider unavailable"));
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: /Report Manually/ }));
  await user.click(screen.getByRole("button", { name: "Save and run" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Provider unavailable");
  await user.click(screen.getByRole("button", { name: "Save and run" }));
  await screen.findByRole("button", { name: "View report" });
  expect(services.automationStore.save).toHaveBeenLastCalledWith(expect.objectContaining({ id: "report", expectedRevision: 2 }));
});

it("closes a settings menu with Escape while keeping the editor and draft open", async () => {
  const { appServices } = fixture(); const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: /Project weekly review/ }));
  const trigger = await screen.findByRole("button", { name: /^Repeat:/ });
  await user.click(trigger);
  await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio"));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("dialog")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Project weekly review");
});

function missedSnapshot(): AutomationSnapshot {
  const definition: SavedAutomation = { id: "weekly", name: "Weekly report", instructions: "Write report.md", workspacePath: "D:/project", revision: 1, modelPolicy: "inherit_default", updatedAtMs: 1,
    schedule: { repeat: "weekly", startAtMs: 1_800_000_000_000 }, nextRunAtMs: 1_800_604_800_000 };
  return { definitions: [definition], runs: [{ id: "missed-1", definition, status: "missed", effectiveModel: null, threadId: null,
    startedAtMs: 1_800_000_060_000, scheduledAtMs: 1_800_000_000_000, finishedAtMs: 1_800_000_060_000, error: null, stopReason: "scheduler_unavailable" }] };
}

it("shows a missed occurrence, runs manually, and retains the missed history", async () => {
  const { services, appServices } = fixture(missedSnapshot()); const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  expect(await screen.findByText(/Missed schedule from/)).toBeTruthy();
  expect(screen.getByText(/Next:/)).toBeTruthy();
  expect(services.automationStore.run).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Needs attention" }));
  await user.click(screen.getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(services.automationStore.run).toHaveBeenCalledWith("weekly"));
  expect(await screen.findByText("Completed")).toBeTruthy();
  expect(screen.getByText("Missed")).toBeTruthy();
  expect(screen.getByText(/Overdue occurrences were skipped/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Open conversation and report" })).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "Back to tasks" }));
  // The new execution replaces the attention state, while history retains the miss.
  expect(screen.queryByText(/Missed schedule from/)).toBeNull();
  expect(screen.getByText("No tasks match this search or filter.")).toBeTruthy();
});

it("disables Run now in both task and missed history while older work is active", async () => {
  const snapshot = missedSnapshot();
  snapshot.runs.push({ ...snapshot.runs[0], id: "active-1", status: "waiting", threadId: "thread-1", scheduledAtMs: null, finishedAtMs: null });
  const { services, appServices } = fixture(snapshot); const user = userEvent.setup();
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  const run = await screen.findByRole("button", { name: "Run now" });
  expect((run as HTMLButtonElement).disabled).toBe(true);
  await user.click(run);
  await user.click(within(screen.getByRole("banner")).getByRole("button", { name: "Run history" }));
  expect((screen.getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  expect(services.automationStore.run).not.toHaveBeenCalled();
});

it("adds the first workspace without leaving the editor and restores the draft after remounting", async () => {
  const { services, appServices } = fixture(); const user = userEvent.setup();
  services.workspaceRegistryStore.list.mockResolvedValue([]);
  vi.mocked(pickDesktopWorkspaceDirectory).mockResolvedValue("D:/new-project");
  const view = render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "New automation" }));
  await user.type(screen.getByLabelText("Name"), "Recovered automation");
  await user.type(screen.getByLabelText("Instructions and output location"), "Write a useful report");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "Add workspace folder" }));
  expect(await screen.findByRole("button", { name: "Workspace: New project" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
  view.unmount();
  services.workspaceRegistryStore.list.mockResolvedValue([{ path: "D:/new-project", name: "New project", exists: true, addedAtMs: 1, updatedAtMs: 1 }]);
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Recovered automation");
  await screen.findByRole("button", { name: "Workspace: New project" });
  await user.click(screen.getByRole("button", { name: "Save" }));
  expect(services.automationStore.save).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "D:/new-project", name: "Recovered automation" }));
});

it("does not remove a saved automation when deletion is cancelled", async () => {
  const { services, appServices } = fixture(missedSnapshot()); const user = userEvent.setup();
  vi.stubGlobal("confirm", vi.fn(() => false));
  render(<AutomationsRoute services={appServices} onOpenThread={vi.fn()} />);
  await user.click(await screen.findByRole("button", { name: /^Weekly report/ }));
  await user.click(screen.getByRole("button", { name: "Delete task" }));
  expect(services.automationStore.delete).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog")).toBeTruthy();
});
