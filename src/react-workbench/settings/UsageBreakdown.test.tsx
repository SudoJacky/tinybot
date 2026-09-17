// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UsageDetails, UsageGroup } from "../../app-core/settings/tokenUsage";
import { UsageBreakdown, UsageHistory } from "./UsageBreakdown";
import { ProfileSettingsPage } from "./ProfileSettingsPage";

afterEach(cleanup);
const usage = { inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 120 };
function group(overrides: Partial<UsageGroup> = {}): UsageGroup {
  return { date: "2026-09-17", providerId: "openai", modelId: "model", purpose: "team_task", teamRunId: "team", taskId: "task", attemptId: "attempt", calls: 1, reportedCalls: 1, failedCalls: 0, pendingCalls: 0, retryCalls: 0, usage, ...overrides };
}
function details(groups: UsageGroup[] = []): UsageDetails { return { groups, invocations: [], nextCursor: null }; }

it("keeps unknown counts separate and does not add cached/reasoning subsets to totals", () => {
  render(<UsageBreakdown groups={[group(), group({ usage: null, reportedCalls: 0, failedCalls: 1 }), group({ purpose: "legacy", calls: 0, reportedCalls: 0 })]} />);
  const table = screen.getByRole("table", { name: "Usage by purpose" });
  const row = within(table).getByRole("row", { name: /^Team execution/ });
  expect(within(row).getAllByRole("cell").map(cell => cell.textContent)).toEqual(["2", "1", "0", "1", "0", "100", "80", "20", "20", "5", "120"]);
  expect(within(table).getByRole("row", { name: /^Historical/ })).toHaveTextContent("Unavailable");
});

it("filters global totals and tables by purpose including entirely unreported requests", async () => {
  render(<ProfileSettingsPage settingsStore={{ load: vi.fn(), loadTokenUsage: async () => ({
    schemaVersion: "tinybot.token_usage.v3", totals: usage, days: [{ date: "2026-09-17", ...usage }],
    modelDays: [{ date: "2026-09-17", providerId: "openai", modelId: "model", ...usage }],
    groups: [group(), group({ purpose: "title", usage: null, reportedCalls: 0 })],
  }) }} />);
  await screen.findByRole("button", { name: /Purpose/ });
  fireEvent.click(screen.getByRole("button", { name: /Purpose/ }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Title generation" }));
  const total = screen.getByRole("region", { name: "Total tokens" });
  expect(within(total).getAllByText("Unavailable")).toHaveLength(6);
  expect(screen.getByRole("table", { name: "Usage by purpose" })).not.toHaveTextContent("Team execution");
});

it("discards stale run responses, reports failures, and refreshes successfully", async () => {
  let finishOld!: (value: UsageDetails) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise<UsageDetails>(resolve => { finishOld = resolve; }))
    .mockRejectedValueOnce(new Error("usage database unavailable"))
    .mockResolvedValueOnce(details([group({ purpose: "team_planning", taskId: null })]));
  const view = render(<UsageHistory load={load} teamRunId="old" />);
  view.rerender(<UsageHistory load={load} teamRunId="new" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("usage database unavailable");
  await act(async () => finishOld(details([group()])));
  expect(screen.queryByText("Team execution")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(await screen.findByText("Team planning")).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(load).toHaveBeenLastCalledWith({ teamRunId: "new", before: undefined });
});

it("loads older request pages using the server cursor", async () => {
  const load = vi.fn().mockResolvedValueOnce({ ...details(), nextCursor: 100 }).mockResolvedValueOnce(details());
  render(<UsageHistory load={load} teamRunId="team" />);
  fireEvent.click(await screen.findByRole("button", { name: "Older requests" }));
  await screen.findAllByText("No attributed requests recorded.");
  expect(load).toHaveBeenLastCalledWith({ teamRunId: "team", before: 100 });
});
