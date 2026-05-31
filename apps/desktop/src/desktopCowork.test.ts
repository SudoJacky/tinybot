import { describe, expect, test } from "vitest";
import {
  buildDesktopCoworkActionRequest,
  buildDesktopCoworkCockpitView,
  buildDesktopCoworkGraphView,
  buildDesktopCoworkSessionRows,
  buildDesktopCoworkTaskOperations,
  buildDesktopCoworkTraceRows,
} from "./desktopCowork";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";

describe("desktop Cowork helpers", () => {
  const session = {
    id: "cowork-1",
    title: "Desktop migration",
    goal: "Move WebUI modules into desktop panes",
    status: "blocked",
    architecture: "adaptive_starter",
    updated_at: "2026-05-31T09:00:00Z",
    agents: [
      {
        id: "agent-1",
        name: "Planner",
        role: "architect",
        status: "running",
        current_task_id: "task-1",
        current_task_title: "Map helpers",
      },
      {
        id: "agent-2",
        role: "reviewer",
        lifecycle_status: "waiting",
        pending_reply_count: 1,
      },
    ],
    tasks: [
      {
        id: "task-1",
        title: "Map helpers",
        status: "in_progress",
        assigned_agent_id: "agent-1",
        description: "Find reusable Cowork projections.",
      },
      {
        id: "task-2",
        title: "Review blocker",
        status: "failed",
        assigned_agent_id: "agent-2",
        result_data: { answer: "Need action routing." },
        confidence: 0.74,
      },
    ],
    mailbox: [
      {
        id: "mail-1",
        sender_id: "agent-2",
        recipient_ids: ["agent-1"],
        status: "delivered",
        content: "Need endpoint parity.",
        requires_reply: true,
        updated_at: "2026-05-31T09:05:00Z",
      },
    ],
    threads: [{ id: "thread-1", topic: "Migration", participant_ids: ["agent-1", "agent-2"], message_count: 3 }],
    trace: [
      {
        id: "trace-1",
        stage: "task",
        action: "assign",
        status: "completed",
        detail: "Assigned task-1",
        at: "2026-05-31T09:01:00Z",
        payload: { task_id: "task-1" },
      },
    ],
    branch_results: [
      { branch_id: "branch-a", result_id: "result-a", status: "ready", summary: "Use helpers" },
      { branch_id: "branch-b", result_id: "result-b", status: "ready", summary: "Use controllers" },
    ],
    artifact_index: [
      {
        id: "artifact-1",
        kind: "file",
        path_or_url: "docs/plan.md",
        summary: "Plan",
        source_task_id: "task-1",
        source_agent_id: "agent-1",
        status: "created",
      },
    ],
    completion_decision: {
      blocked: [{ id: "mail-1", request_type: "reply", content: "Need endpoint parity." }],
      next_action: "wait_for_reply",
    },
    graph: {
      nodes: [{ id: "agent-1", label: "Planner", kind: "agent" }, { id: "task-1", label: "Map helpers", kind: "task" }],
      edges: [{ id: "edge-1", source: "agent-1", target: "task-1", kind: "owns" }],
    },
    swarm_plan: {
      work_units: [
        { id: "wu-1", title: "Extract projections", status: "failed", assigned_agent_id: "agent-1", result: { answer: "partial" } },
      ],
    },
  };

  test("projects Cowork session rows with root WebUI run and attention semantics", () => {
    const rows = buildDesktopCoworkSessionRows({ items: [session] });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "cowork-1",
      title: "Desktop migration",
      status: "blocked",
      workflow: "Adaptive Starter",
      agentCount: 2,
      activeAgentCount: 1,
      taskProgress: { total: 2, completed: 0, failed: 1, blocked: 0 },
      attention: {
        total: 4,
        blockers: 1,
        pendingReplies: 1,
        taskIssues: 1,
        workUnitIssues: 1,
        tone: "attention",
      },
      meta: "blocked / Adaptive Starter / 2 agents / 0/2 tasks / 4 attention",
    });
  });

  test("builds a cockpit projection for agents, tasks, mailbox, branches, artifacts, and selected inspectors", () => {
    const view = buildDesktopCoworkCockpitView(session, { selected: { type: "task", id: "task-2" } });

    expect(view.header).toMatchObject({
      id: "cowork-1",
      title: "Desktop migration",
      status: "blocked",
      workflow: "Adaptive Starter",
      goal: "Move WebUI modules into desktop panes",
    });
    expect(view.agents.map((agent) => [agent.id, agent.label, agent.status, agent.attention.tone])).toEqual([
      ["agent-1", "Planner", "running", "attention"],
      ["agent-2", "reviewer 2", "waiting", "attention"],
    ]);
    expect(view.tasks.map((task) => [task.id, task.title, task.status, task.availableActions.join(",")])).toEqual([
      ["task-1", "Map helpers", "in_progress", "assign,review"],
      ["task-2", "Review blocker", "failed", "assign,retry,review"],
    ]);
    expect(view.mailbox[0]).toMatchObject({
      id: "mail-1",
      route: "agent-2 -> agent-1",
      requiresReply: true,
      tone: "attention",
    });
    expect(view.branches.map((branch) => [branch.branchId, branch.resultId, branch.selected])).toEqual([
      ["branch-a", "result-a", false],
      ["branch-b", "result-b", false],
    ]);
    expect(view.artifacts[0]).toMatchObject({
      id: "artifact-1",
      title: "Plan",
      location: "docs/plan.md",
      meta: "file / Task task-1 / Agent agent-1 / Status created",
    });
    expect(view.inspector).toMatchObject({
      type: "task",
      id: "task-2",
      title: "Review blocker",
      rows: [
        { label: "Status", value: "failed" },
        { label: "Owner", value: "agent-2" },
        { label: "Updated", value: "-" },
      ],
    });
    expect(view.taskCenterItems[0]).toMatchObject({
      id: "cowork:cowork-1",
      status: "blocked",
      tone: "attention",
      destination: { module: "cowork", sessionId: "cowork-1" },
    });
  });

  test("projects Cowork run states into global task center operations", () => {
    const operations = buildDesktopCoworkTaskOperations({
      sessions: [
        { id: "running", title: "Running session", status: "running", tasks: [{ id: "t1", status: "completed" }, { id: "t2", status: "in_progress" }] },
        { id: "paused", title: "Paused session", status: "paused", tasks: [{ id: "t1", status: "pending" }] },
        { id: "blocked", title: "Blocked session", status: "blocked", completion_decision: { blocked: [{ id: "b1" }] } },
        { id: "failed", title: "Failed session", status: "failed", error: "agent timeout" },
        { id: "done", title: "Completed session", status: "completed", final_draft: "Ship it" },
        {
          id: "intervention",
          title: "Review needed",
          status: "intervention-needed",
          mailbox: [{ id: "m1", requires_reply: true, status: "delivered" }],
        },
      ],
    });

    expect(operations).toEqual([
      {
        id: "cowork:running",
        title: "Running session",
        status: "running",
        detail: "No attention needed",
        progress: { completed: 1, total: 2 },
        canonical: { module: "cowork", entityId: "running", href: "/cowork" },
        diagnostics: "",
        retryable: false,
        cancelable: true,
        updatedAt: "",
      },
      {
        id: "cowork:paused",
        title: "Paused session",
        status: "paused",
        detail: "No attention needed",
        progress: { completed: 0, total: 1 },
        canonical: { module: "cowork", entityId: "paused", href: "/cowork" },
        diagnostics: "",
        retryable: false,
        cancelable: false,
        updatedAt: "",
      },
      {
        id: "cowork:blocked",
        title: "Blocked session",
        status: "blocked",
        detail: "1 blocker",
        canonical: { module: "cowork", entityId: "blocked", href: "/cowork" },
        diagnostics: "",
        retryable: false,
        cancelable: false,
        updatedAt: "",
      },
      {
        id: "cowork:failed",
        title: "Failed session",
        status: "failed",
        detail: "No attention needed",
        canonical: { module: "cowork", entityId: "failed", href: "/cowork" },
        diagnostics: "agent timeout",
        retryable: true,
        cancelable: false,
        updatedAt: "",
      },
      {
        id: "cowork:done",
        title: "Completed session",
        status: "completed",
        detail: "Final output ready",
        canonical: { module: "cowork", entityId: "done", href: "/cowork" },
        diagnostics: "",
        retryable: false,
        cancelable: false,
        updatedAt: "",
      },
      {
        id: "cowork:intervention",
        title: "Review needed",
        status: "intervention-needed",
        detail: "1 reply needed",
        canonical: { module: "cowork", entityId: "intervention", href: "/cowork" },
        diagnostics: "",
        retryable: false,
        cancelable: false,
        updatedAt: "",
      },
    ]);

    expect(buildDesktopTaskCenterItems({ coworkRuns: operations }).map((item) => [item.id, item.state, item.tone, item.actions.map((action) => action.id).join(",")])).toEqual([
      ["cowork:blocked", "blocked", "attention", "open,inspect"],
      ["cowork:paused", "blocked", "attention", "open,inspect"],
      ["cowork:intervention", "blocked", "attention", "open,inspect"],
      ["cowork:failed", "failed", "danger", "retry,open,inspect,copyDiagnostics,dismiss"],
      ["cowork:running", "active", "normal", "cancel,open,inspect"],
      ["cowork:done", "completed", "complete", "open,dismiss"],
    ]);
  });

  test("normalizes graph and trace data for desktop panes", () => {
    expect(buildDesktopCoworkGraphView(session)).toMatchObject({
      nodes: [
        { id: "agent-1", label: "Planner", kind: "agent" },
        { id: "task-1", label: "Map helpers", kind: "task" },
      ],
      edges: [{ id: "edge-1", source: "agent-1", target: "task-1", label: "owns" }],
      caption: "2 nodes / 1 edge",
    });

    expect(buildDesktopCoworkTraceRows(session)).toEqual([
      {
        id: "trace-1",
        stage: "task",
        action: "assign",
        status: "completed",
        detail: "Assigned task-1",
        at: "2026-05-31T09:01:00Z",
        target: "",
        payloadText: "{\n  \"task_id\": \"task-1\"\n}",
        raw: session.trace[0],
      },
    ]);
  });

  test("builds Cowork action requests without changing root endpoint semantics", () => {
    expect(buildDesktopCoworkActionRequest({ action: "listSessions", includeCompleted: true, originChatId: "chat/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions?include_completed=true&origin_chat_id=chat%2F1",
    });
    expect(buildDesktopCoworkActionRequest({ action: "createSession", goal: "Ship desktop", architecture: "hybrid", blueprint: { team: [] } })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions",
      body: {
        goal: "Ship desktop",
        blueprint: { team: [] },
        architecture: "adaptive_starter",
        workflow_mode: "adaptive_starter",
        auto_run: true,
        max_rounds: 20,
        max_agents: 3,
        max_agent_calls: 30,
        run_until_idle: true,
      },
    });
    expect(buildDesktopCoworkActionRequest({ action: "runSession", sessionId: "cowork/1" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/run",
      body: {
        max_rounds: 20,
        max_agents: 3,
        max_agent_calls: 30,
        run_until_idle: true,
        stop_on_blocker: false,
      },
    });
    expect(buildDesktopCoworkActionRequest({ action: "sendMessage", sessionId: "cowork/1", content: "Continue", recipientIds: ["agent-1"] })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/messages",
      body: { content: "Continue", recipient_ids: ["agent-1"] },
    });
    expect(buildDesktopCoworkActionRequest({ action: "task", sessionId: "cowork/1", taskId: "task/2", taskAction: "assign", assignedAgentId: "agent-2" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/tasks/task%2F2/assign",
      body: { assigned_agent_id: "agent-2" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "workUnit", sessionId: "cowork/1", workUnitId: "wu/1", workUnitAction: "retry", reason: "retry from desktop" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/work-units/wu%2F1/retry",
      body: { reason: "retry from desktop" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "selectBranchResult", sessionId: "cowork/1", branchId: "branch/1", resultId: "result-1" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branches/branch%2F1/result/select-final",
      body: { result_id: "result-1" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "mergeBranchResults", sessionId: "cowork/1", branchIds: ["a", "b"] })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branch-results/merge",
      body: { branch_ids: ["a", "b"] },
    });
    expect(buildDesktopCoworkActionRequest({ action: "validateBlueprint", preview: true, blueprint: { agents: [] } })).toEqual({
      method: "POST",
      path: "/api/cowork/blueprints/preview",
      body: { blueprint: { agents: [] } },
    });
  });
});
