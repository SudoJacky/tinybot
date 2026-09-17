import { expect, it, vi } from "vitest";
import { createDesktopNativeTeamsApi } from "./desktopNativeTeams";
it("preserves native Team payloads and revision checks", async () => {
  const invoke = vi.fn(async () => undefined);
  const api = createDesktopNativeTeamsApi({ invoke });
  await api.list();
  expect(invoke).toHaveBeenLastCalledWith("worker_team_runs_list");
  await api.get("run");
  expect(invoke).toHaveBeenLastCalledWith("worker_team_run_get", {
    runId: "run",
  });
  const input = { runId: "run", expectedRevision: 7 };
  await api.execute(input);
  expect(invoke).toHaveBeenLastCalledWith("worker_team_execute", { input });
  await api.control({ ...input, action: "retry", taskIds: ["task"] });
  expect(invoke).toHaveBeenLastCalledWith("worker_team_control", {
    input: { ...input, action: "retry", taskIds: ["task"] },
  });
  invoke.mockRejectedValueOnce(new Error("Stale Team revision"));
  await expect(api.execute(input)).rejects.toThrow("Stale Team revision");
});
