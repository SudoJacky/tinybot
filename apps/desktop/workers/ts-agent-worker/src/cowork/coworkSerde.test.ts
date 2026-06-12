import { describe, expect, test } from "vitest";

import { NativeCoworkStoreBridge } from "./coworkStoreBridge";
import { normalizeCoworkSession, normalizeCoworkStore } from "./coworkSerde";

function rpcClient(responses: Record<string, unknown>) {
  const calls: Array<{ traceId: string; method: string; params: Record<string, unknown> }> = [];
  return {
    calls,
    client: {
      request: async (traceId: string, method: string, params: Record<string, unknown>) => {
        calls.push({ traceId, method, params });
        return responses[method];
      },
    },
  };
}

const legacySession = {
  id: "cw-1",
  title: "Launch plan",
  goal: "Plan launch",
  workflow_mode: "hybrid",
  agents: {
    lead: {
      id: "lead",
      name: "Lead",
      role: "Coordinator",
      goal: "Coordinate launch",
      tools: ["cowork_internal"],
    },
  },
  tasks: {
    task_1: {
      id: "task_1",
      title: "Research",
      description: "Gather launch facts",
      assigned_agent_id: "lead",
    },
  },
};

describe("cowork serde", () => {
  test("loads a minimal legacy store payload and fills Python-compatible defaults", () => {
    const store = normalizeCoworkStore({ sessions: [legacySession] });

    expect(store.version).toBe(1);
    expect(store.sessions).toHaveLength(1);
    expect(store.sessions[0]).toMatchObject({
      id: "cw-1",
      title: "Launch plan",
      goal: "Plan launch",
      status: "active",
      workflow_mode: "adaptive_starter",
      current_branch_id: "default",
      current_focus_task: "",
      workspace_dir: "",
      budget_usage: {
        rounds: 0,
        agent_calls: 0,
        tool_calls: 0,
        tokens_total: 0,
        stop_reason: "",
      },
      branches: {
        default: {
          id: "default",
          title: "Default",
          architecture: "adaptive_starter",
          status: "active",
        },
      },
    });
    expect(store.sessions[0]?.agents.lead).toMatchObject({
      id: "lead",
      status: "idle",
      inbox: [],
      lifetime: "persistent",
      lifecycle_status: "active",
    });
    expect(store.sessions[0]?.tasks.task_1).toMatchObject({
      id: "task_1",
      status: "pending",
      dependencies: [],
      priority: 0,
      review_required: false,
    });
  });

  test("normalizes malformed native session payloads defensively", () => {
    const session = normalizeCoworkSession({
      id: "cw-2",
      title: "Broken",
      goal: "Recover",
      workflow_mode: "unknown",
      agents: [],
      tasks: null,
      branches: {
        selected: {
          id: "selected",
          title: "Selected",
          architecture: "hybrid",
          status: "completed",
        },
      },
      current_branch_id: "missing",
      shared_memory: { findings: ["fact"], risks: [{ text: "risk" }], junk: "ignored" },
      budget_usage: { rounds: "4", tokens_total: 12 },
    });

    expect(session.workflow_mode).toBe("adaptive_starter");
    expect(session.current_branch_id).toBe("selected");
    expect(session.branches.selected?.architecture).toBe("adaptive_starter");
    expect(session.agents).toEqual({});
    expect(session.tasks).toEqual({});
    expect(session.shared_memory).toEqual({
      findings: [{ text: "fact" }],
      claims: [],
      risks: [{ text: "risk" }],
      open_questions: [],
      decisions: [],
      artifacts: [],
    });
    expect(session.budget_usage.rounds).toBe(4);
    expect(session.budget_usage.tokens_total).toBe(12);
  });
});

describe("NativeCoworkStoreBridge", () => {
  test("reads, writes, appends events, and deletes sessions through native cowork store RPCs", async () => {
    const { client, calls } = rpcClient({
      "cowork_store.list_snapshots": { sessions: [legacySession] },
      "cowork_store.read_snapshot": { session: legacySession },
      "cowork_store.write_snapshot": { session: legacySession },
      "cowork_store.append_event": { event_id: "event-1" },
      "cowork_store.read_events": { events: [{ id: "event-1", type: "session.created", message: "Created" }] },
      "cowork_store.ensure_session_workspace": { workspace_dir: "D:/workspace/cowork/cw-1" },
      "cowork_store.delete_session": { deleted: true },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    const listed = await bridge.listSnapshots("trace-list");
    const fetched = await bridge.readSnapshot("cw-1", "trace-read");
    const saved = await bridge.writeSnapshot(fetched!, "trace-write");
    const appended = await bridge.appendEvent("cw-1", { id: "event-1", type: "session.created", message: "Created" }, "trace-event");
    const events = await bridge.readEvents("cw-1", "trace-events");
    const workspaceDir = await bridge.ensureSessionWorkspace("cw-1", "trace-workspace");
    const deleted = await bridge.deleteSession("cw-1", "trace-delete");

    expect(listed.map((session) => session.id)).toEqual(["cw-1"]);
    expect(fetched?.workflow_mode).toBe("adaptive_starter");
    expect(saved.id).toBe("cw-1");
    expect(appended).toBe("event-1");
    expect(events).toEqual([{ id: "event-1", type: "session.created", message: "Created" }]);
    expect(workspaceDir).toBe("D:/workspace/cowork/cw-1");
    expect(deleted).toBe(true);
    expect(calls).toEqual([
      { traceId: "trace-list", method: "cowork_store.list_snapshots", params: {} },
      { traceId: "trace-read", method: "cowork_store.read_snapshot", params: { session_id: "cw-1" } },
      {
        traceId: "trace-write",
        method: "cowork_store.write_snapshot",
        params: { session: expect.objectContaining({ id: "cw-1", workflow_mode: "adaptive_starter" }) },
      },
      {
        traceId: "trace-event",
        method: "cowork_store.append_event",
        params: {
          session_id: "cw-1",
          event: { id: "event-1", type: "session.created", message: "Created" },
        },
      },
      { traceId: "trace-events", method: "cowork_store.read_events", params: { session_id: "cw-1" } },
      { traceId: "trace-workspace", method: "cowork_store.ensure_session_workspace", params: { session_id: "cw-1" } },
      { traceId: "trace-delete", method: "cowork_store.delete_session", params: { session_id: "cw-1" } },
    ]);
  });

  test("handles missing native cowork payloads defensively", async () => {
    const { client } = rpcClient({
      "cowork_store.list_snapshots": null,
      "cowork_store.read_snapshot": { session: null },
      "cowork_store.write_snapshot": {},
      "cowork_store.append_event": {},
      "cowork_store.read_events": null,
      "cowork_store.ensure_session_workspace": {},
      "cowork_store.delete_session": {},
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.listSnapshots("trace-list")).resolves.toEqual([]);
    await expect(bridge.readSnapshot("missing", "trace-read")).resolves.toBeNull();
    await expect(bridge.writeSnapshot(normalizeCoworkSession(legacySession), "trace-write")).resolves.toMatchObject({ id: "cw-1" });
    await expect(bridge.appendEvent("missing", { id: "event-1", type: "x", message: "x" }, "trace-event")).resolves.toBe("");
    await expect(bridge.readEvents("missing", "trace-events")).resolves.toEqual([]);
    await expect(bridge.ensureSessionWorkspace("missing", "trace-workspace")).resolves.toBe("");
    await expect(bridge.deleteSession("missing", "trace-delete")).resolves.toBe(false);
  });

  test("normalizes Python event-log records when reading native cowork events", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "",
          session_id: "cw-1",
          category: "session",
          type: "test.event",
          actor_id: "lead",
          payload: { message: "extra event", detail: "kept" },
          created_at: "2026-06-12T10:00:00.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readEvents("cw-1", "trace-events")).resolves.toEqual([{
      id: "event:test.event:2026-06-12T10:00:00.000Z",
      type: "test.event",
      message: "extra event",
      actor_id: "lead",
      data: { message: "extra event", detail: "kept" },
      created_at: "2026-06-12T10:00:00.000Z",
    }]);
  });

  test("normalizes Python trace event-log records separately from cowork events", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "span_1",
          session_id: "cw-1",
          category: "trace",
          type: "trace.span_recorded",
          actor_id: "lead",
          payload: {
            span: {
              id: "span_1",
              session_id: "cw-1",
              kind: "agent",
              name: "Lead run",
              status: "completed",
              actor_id: "lead",
              started_at: "2026-06-12T10:00:00.000Z",
              ended_at: "2026-06-12T10:01:00.000Z",
              summary: "done",
            },
          },
          created_at: "2026-06-12T10:01:00.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readEvents("cw-1", "trace-events")).resolves.toEqual([]);
    await expect(bridge.readTraceSpans("cw-1", "trace-events")).resolves.toEqual([{
      id: "span_1",
      session_id: "cw-1",
      kind: "agent",
      name: "Lead run",
      status: "completed",
      actor_id: "lead",
      started_at: "2026-06-12T10:00:00.000Z",
      ended_at: "2026-06-12T10:01:00.000Z",
      summary: "done",
    }]);
  });

  test("normalizes Python agent-step observation records separately from cowork events", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "step_1",
          session_id: "cw-1",
          category: "observation",
          type: "agent_step.finished",
          actor_id: "lead",
          payload: {
            agent_step: {
              id: "step_1",
              session_id: "cw-1",
              branch_id: "default",
              architecture: "swarm",
              agent_id: "lead",
              action_kind: "run_agent",
              scheduler_reason: "ready task",
              status: "completed",
              started_at: "2026-06-12T10:00:00.000Z",
              ended_at: "2026-06-12T10:01:00.000Z",
              output_summary: "completed work",
            },
          },
          created_at: "2026-06-12T10:01:00.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readEvents("cw-1", "trace-events")).resolves.toEqual([]);
    await expect(bridge.readAgentSteps("cw-1", "trace-events")).resolves.toEqual([{
      id: "step_1",
      session_id: "cw-1",
      branch_id: "default",
      architecture: "swarm",
      agent_id: "lead",
      action_kind: "run_agent",
      scheduler_reason: "ready task",
      status: "completed",
      started_at: "2026-06-12T10:00:00.000Z",
      ended_at: "2026-06-12T10:01:00.000Z",
      output_summary: "completed work",
    }]);
  });

  test("normalizes Python tool observation records separately from cowork events", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "toolobs_1",
          session_id: "cw-1",
          category: "observation",
          type: "tool_observation.recorded",
          actor_id: "lead",
          payload: {
            tool_observation: {
              id: "toolobs_1",
              step_id: "step_1",
              tool_name: "read_file",
              calling_agent_id: "lead",
              purpose: "Inspect file",
              parameter_summary: { path: "README.md" },
              result_summary: "Read README",
              status: "completed",
              started_at: "2026-06-12T10:00:00.000Z",
              ended_at: "2026-06-12T10:00:01.000Z",
            },
          },
          created_at: "2026-06-12T10:00:01.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readEvents("cw-1", "trace-events")).resolves.toEqual([]);
    await expect(bridge.readToolObservations("cw-1", "trace-events")).resolves.toEqual([{
      id: "toolobs_1",
      step_id: "step_1",
      tool_name: "read_file",
      calling_agent_id: "lead",
      purpose: "Inspect file",
      parameter_summary: { path: "README.md" },
      result_summary: "Read README",
      status: "completed",
      started_at: "2026-06-12T10:00:00.000Z",
      ended_at: "2026-06-12T10:00:01.000Z",
    }]);
  });

  test("normalizes Python browser observation records separately from cowork events", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "browserobs_1",
          session_id: "cw-1",
          category: "observation",
          type: "browser_observation.recorded",
          actor_id: "lead",
          payload: {
            browser_observation: {
              id: "browserobs_1",
              step_id: "step_1",
              purpose: "Inspect rendered page",
              resource_ref: "https://example.test/dashboard",
              title: "Dashboard",
              result_summary: "Loaded dashboard",
              status: "completed",
              accessed_at: "2026-06-12T10:00:00.000Z",
              ended_at: "2026-06-12T10:00:02.000Z",
              duration_ms: 2000,
              detail_ref: "detail_1",
              artifact_refs: ["artifact_1"],
              sensitive: true,
              redacted: true,
            },
          },
          created_at: "2026-06-12T10:00:02.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readEvents("cw-1", "trace-events")).resolves.toEqual([]);
    await expect(bridge.readBrowserObservations("cw-1", "trace-events")).resolves.toEqual([{
      id: "browserobs_1",
      step_id: "step_1",
      purpose: "Inspect rendered page",
      resource_ref: "https://example.test/dashboard",
      title: "Dashboard",
      result_summary: "Loaded dashboard",
      status: "completed",
      accessed_at: "2026-06-12T10:00:00.000Z",
      ended_at: "2026-06-12T10:00:02.000Z",
      duration_ms: 2000,
      detail_ref: "detail_1",
      artifact_refs: ["artifact_1"],
      sensitive: true,
      redacted: true,
    }]);
  });

  test("extracts observation details and sensitive artifacts from observation payloads", async () => {
    const { client } = rpcClient({
      "cowork_store.read_events": {
        events: [{
          schema: "cowork.event_log.v1",
          id: "browserobs_1",
          session_id: "cw-1",
          category: "observation",
          type: "browser_observation.recorded",
          actor_id: "lead",
          payload: {
            browser_observation: {
              id: "browserobs_1",
              step_id: "step_1",
              detail_ref: "detail_1",
            },
            observation_detail: {
              id: "detail_1",
              subject_id: "browserobs_1",
              subject_type: "browser_observation",
              state: "available",
              summary: "Rendered page detail",
              content: "Full rendered output",
              content_type: "text/plain",
              sensitivity: "sensitive",
              permitted_agent_ids: ["lead"],
              artifact_refs: ["artifact_1"],
            },
            sensitive_artifacts: {
              sartifact_1: {
                id: "sartifact_1",
                source_step_id: "step_1",
                source_observation_id: "browserobs_1",
                summary: "Sensitive page",
                artifact_ref: "detail_1",
                permitted_agent_ids: ["lead"],
                redacted: true,
              },
            },
          },
          created_at: "2026-06-12T10:00:02.000Z",
        }],
      },
    });
    const bridge = new NativeCoworkStoreBridge(client);

    await expect(bridge.readObservationDetails("cw-1", "trace-events")).resolves.toEqual([{
      id: "detail_1",
      subject_id: "browserobs_1",
      subject_type: "browser_observation",
      state: "available",
      summary: "Rendered page detail",
      content: "Full rendered output",
      content_type: "text/plain",
      sensitivity: "sensitive",
      permitted_agent_ids: ["lead"],
      artifact_refs: ["artifact_1"],
    }]);
    await expect(bridge.readSensitiveArtifacts("cw-1", "trace-events")).resolves.toEqual([{
      id: "sartifact_1",
      source_step_id: "step_1",
      source_observation_id: "browserobs_1",
      summary: "Sensitive page",
      artifact_ref: "detail_1",
      permitted_agent_ids: ["lead"],
      redacted: true,
    }]);
  });
});
