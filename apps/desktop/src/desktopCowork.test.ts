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
    run_metrics: [
      { label: "Round efficiency", value: "82%" },
      { label: "Agent calls", value: 7 },
    ],
    architecture_projection: {
      summary: "Adaptive starter projection",
      sections: [{ title: "Planner lane", status: "ready", summary: "Maps helper extraction" }],
    },
    task_dag: {
      nodes: [{ id: "task-1", label: "Map helpers" }, { id: "task-2", label: "Review blocker" }],
      edges: [{ source: "task-1", target: "task-2", label: "blocks" }],
    },
    outputs: [{ id: "output-1", title: "Draft output", content: "Desktop adaptation notes" }],
    final_draft: "Ship the desktop Cowork cockpit.",
    evaluation_results: [{ id: "eval-1", status: "passed", score: 0.91, summary: "Coverage OK" }],
    swarm_plan: {
      summary: "Planner/reviewer swarm",
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

  test("builds branch rows from Python snapshot branches when branch_results is absent", () => {
    const view = buildDesktopCoworkCockpitView({
      ...session,
      current_branch_id: "branch-b",
      branch_results: [],
      branches: [
        {
          id: "branch-a",
          title: "Use helpers",
          status: "completed",
          current: false,
          branch_result: { id: "result-a", summary: "Use helpers result" },
        },
        {
          id: "branch-b",
          title: "Use controllers",
          status: "active",
          current: true,
          branch_result: {},
        },
      ],
    });

    expect(view.branches.map((branch) => [branch.branchId, branch.resultId, branch.selected, branch.title])).toEqual([
      ["branch-a", "result-a", false, "Use helpers"],
      ["branch-b", "", true, "Use controllers"],
    ]);
  });

  test("builds Cowork observability panels for graph, focus, metrics, work, outputs, and evaluations", () => {
    const view = buildDesktopCoworkCockpitView(session);

    expect(view.observabilityPanels.map((panel) => panel.id)).toEqual([
      "graph",
      "focus",
      "metrics",
      "architecture",
      "swarm",
      "workUnits",
      "taskDag",
      "agents",
      "tasks",
      "mailbox",
      "threads",
      "trace",
      "artifacts",
      "outputs",
      "finalDraft",
      "blockers",
      "evaluations",
      "status",
    ]);
    expect(view.observabilityPanels.find((panel) => panel.id === "metrics")?.rows).toContainEqual({
      label: "Round efficiency",
      value: "82%",
    });
    expect(view.observabilityPanels.find((panel) => panel.id === "architecture")?.rows[0]?.value).toContain("Adaptive starter projection");
    expect(view.observabilityPanels.find((panel) => panel.id === "workUnits")?.rows[0]?.value).toContain("Extract projections");
    expect(view.observabilityPanels.find((panel) => panel.id === "taskDag")?.rows).toContainEqual({
      label: "Edge",
      value: "task-1 -> task-2 / blocks",
    });
    expect(view.observabilityPanels.find((panel) => panel.id === "outputs")?.rows[0]?.value).toContain("Desktop adaptation notes");
    expect(view.observabilityPanels.find((panel) => panel.id === "finalDraft")?.rows[0]?.value).toBe("Ship the desktop Cowork cockpit.");
    expect(view.observabilityPanels.find((panel) => panel.id === "blockers")?.rows[0]?.value).toContain("Need endpoint parity.");
    expect(view.observabilityPanels.find((panel) => panel.id === "evaluations")?.rows[0]?.value).toContain("Coverage OK");
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

    expect(operations).toMatchObject([
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

    expect(operations.find((operation) => operation.id === "cowork:running")?.relatedResources?.map((resource) => resource.title)).toEqual([
      "Task 1",
      "Task 2",
    ]);
    expect(operations.find((operation) => operation.id === "cowork:failed")?.outputs).toEqual([]);
    expect(operations.find((operation) => operation.id === "cowork:done")?.outputs).toEqual([
      {
        kind: "artifact",
        id: "cowork:done:final-output",
        title: "Final output",
        detail: "Ship it",
        route: { module: "cowork", entityId: "done", href: "/cowork" },
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

  test("projects Cowork task, work-unit, branch, and artifact context for Work Lens", () => {
    const [operation] = buildDesktopCoworkTaskOperations({
      sessions: [
        {
          id: "rich",
          title: "Review desktop release",
          status: "blocked",
          tasks: [{ id: "task-1", title: "Review migration notes", status: "blocked", assigned_agent_id: "agent-1" }],
          swarm_plan: {
            work_units: [{ id: "wu-1", title: "Extract projections", status: "failed", assigned_agent_id: "agent-1" }],
          },
          branches: [{ id: "branch-1", title: "release-notes", status: "ready" }],
          artifacts: [{ id: "artifact-1", title: "Release draft", kind: "markdown", path: "outputs/release.md" }],
          completion_decision: { blocked: [{ id: "blocker-1", content: "Operator approval required." }] },
        },
      ],
    });

    expect(operation?.relatedResources?.map((resource) => [resource.kind, resource.id, resource.title, resource.detail])).toEqual([
      ["coworkEntity", "cowork:rich:task:task-1", "Review migration notes", "blocked / agent-1"],
      ["coworkEntity", "cowork:rich:work-unit:wu-1", "Extract projections", "failed / agent-1"],
      ["coworkEntity", "cowork:rich:branch:branch-1", "release-notes", "ready"],
    ]);
    expect(operation?.outputs).toEqual([
      {
        kind: "artifact",
        id: "cowork:rich:artifact:artifact-1",
        title: "Release draft",
        detail: "markdown / outputs/release.md",
        route: { module: "cowork", entityId: "rich", href: "/cowork" },
      },
    ]);
  });

  test("projects Cowork approval and intervention variants into attention task-center states", () => {
    const operations = buildDesktopCoworkTaskOperations({
      sessions: [
        {
          id: "approval",
          title: "Approval required",
          status: "requires_approval",
          pending_approvals: [{ id: "approval-1", summary: "Approve final merge" }],
        },
        {
          id: "approval-hyphen",
          title: "Human approval",
          status: "approval-needed",
          approval_requests: [{ id: "approval-2", reason: "Confirm tool use" }],
        },
        {
          id: "needs-intervention",
          title: "Needs intervention",
          status: "needs_intervention",
          interventions: [{ id: "intervention-1", reason: "Resolve branch disagreement" }],
        },
      ],
    });

    expect(operations.map((operation) => [operation.id, operation.status, operation.detail])).toEqual([
      ["cowork:approval", "requires_approval", "1 approval needed"],
      ["cowork:approval-hyphen", "approval-needed", "1 approval needed"],
      ["cowork:needs-intervention", "needs_intervention", "1 intervention needed"],
    ]);

    expect(buildDesktopTaskCenterItems({ coworkRuns: operations }).map((item) => [item.id, item.state, item.tone, item.actions.map((action) => action.id).join(",")])).toEqual([
      ["cowork:approval", "blocked", "attention", "open,inspect"],
      ["cowork:approval-hyphen", "blocked", "attention", "open,inspect"],
      ["cowork:needs-intervention", "blocked", "attention", "open,inspect"],
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
    expect(buildDesktopCoworkActionRequest({ action: "runSession", sessionId: "cowork/1", architecture: "swarm" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/run",
      body: {
        max_rounds: 20,
        max_agents: 3,
        max_agent_calls: 30,
        run_until_idle: true,
        stop_on_blocker: false,
        architecture: "swarm",
        workflow_mode: "swarm",
      },
    });
    expect(buildDesktopCoworkActionRequest({ action: "emergencyStopSession", sessionId: "cowork/1" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/emergency-stop",
      body: { reason: "emergency stop from desktop" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadBlueprint", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/blueprint",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadTrace", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/trace",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadDag", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/dag",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadArtifacts", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/artifacts",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadOrganization", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/organization",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadQueues", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/queues",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadBranches", sessionId: "cowork/1" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/branches",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadAgentActivity", sessionId: "cowork/1", agentId: "lead agent" })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/agents/lead%20agent/activity",
    });
    expect(buildDesktopCoworkActionRequest({ action: "loadAgentActivity", sessionId: "cowork/1", agentId: "lead agent", limit: 5 })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/agents/lead%20agent/activity?limit=5",
    });
    expect(buildDesktopCoworkActionRequest({
      action: "loadObservation",
      sessionId: "cowork/1",
      detailRef: "detail 1",
      requesterAgentId: "reviewer",
    })).toEqual({
      method: "GET",
      path: "/api/cowork/sessions/cowork%2F1/observations/detail%201?agent_id=reviewer",
    });
    expect(buildDesktopCoworkActionRequest({ action: "sendMessage", sessionId: "cowork/1", content: "Continue", recipientIds: ["agent-1"] })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/messages",
      body: { content: "Continue", recipient_ids: ["agent-1"] },
    });
    expect(buildDesktopCoworkActionRequest({ action: "sendMessage", sessionId: "cowork/1", content: "Share update", recipientIds: [], architecture: "team" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/messages",
      body: { content: "Share update", recipient_ids: [], architecture: "team", workflow_mode: "team" },
    });
    expect(buildDesktopCoworkActionRequest({
      action: "sendMessage",
      sessionId: "cowork/1",
      content: " Continue in thread ",
      recipientIds: ["agent-1"],
      threadId: "thread/1",
      topic: "Review lane",
      eventType: "review.requested",
    })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/messages",
      body: {
        content: "Continue in thread",
        recipient_ids: ["agent-1"],
        thread_id: "thread/1",
        topic: "Review lane",
        event_type: "review.requested",
      },
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
    expect(buildDesktopCoworkActionRequest({ action: "updateBudget", sessionId: "cowork/1", body: { max_rounds: 4 } })).toEqual({
      method: "PATCH",
      path: "/api/cowork/sessions/cowork%2F1/budget",
      body: { max_rounds: 4 },
    });
    expect(buildDesktopCoworkActionRequest({ action: "deriveBranch", sessionId: "cowork/1", sourceBranchId: "branch/1", body: { target_architecture: "swarm" } })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branches/branch%2F1/derive",
      body: { target_architecture: "swarm" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "selectBranch", sessionId: "cowork/1", branchId: "branch/1", architecture: "team" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branches/branch%2F1/select",
      body: { architecture: "team", workflow_mode: "team" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "selectBranchResult", sessionId: "cowork/1", branchId: "branch/1", resultId: "result-1", architecture: "team" })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branches/branch%2F1/result/select-final",
      body: { result_id: "result-1", architecture: "team", workflow_mode: "team" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "mergeBranchResults", sessionId: "cowork/1", branchIds: ["a", "b"] })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/branch-results/merge",
      body: { branch_ids: ["a", "b"] },
    });
    expect(buildDesktopCoworkActionRequest({ action: "selectFinalResult", sessionId: "cowork/1", body: { branch_id: "branch/1", result_id: "result-1" } })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/final-result/select",
      body: { branch_id: "branch/1", result_id: "result-1" },
    });
    expect(buildDesktopCoworkActionRequest({ action: "mergeFinalResult", sessionId: "cowork/1", body: { branch_ids: ["branch/1", "branch/2"] } })).toEqual({
      method: "POST",
      path: "/api/cowork/sessions/cowork%2F1/final-result/merge",
      body: { branch_ids: ["branch/1", "branch/2"] },
    });
    expect(buildDesktopCoworkActionRequest({ action: "validateBlueprint", preview: true, blueprint: { agents: [] } })).toEqual({
      method: "POST",
      path: "/api/cowork/blueprints/preview",
      body: { blueprint: { agents: [] } },
    });
  });
});
