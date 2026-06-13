import { describe, expect, it } from "vitest";

import { CoworkMailbox, type CoworkEnvelope } from "./coworkMailbox";
import { CoworkService, createMemoryCoworkStore } from "./coworkService";
import type { CoworkSession } from "./coworkTypes";

const fixedNow = "2026-06-12T08:00:00.000Z";

function deterministicIds() {
  const counters = new Map<string, number>();
  return (prefix: string) => {
    const next = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function mailbox() {
  return new CoworkMailbox({
    now: () => fixedNow,
    idGenerator: deterministicIds(),
  });
}

async function createTeamSession(): Promise<CoworkSession> {
  const service = new CoworkService({
    store: createMemoryCoworkStore(),
    now: () => fixedNow,
    idGenerator: deterministicIds(),
  });
  return service.createSession({
    goal: "Coordinate mailbox runtime",
    title: "Mailbox",
    workflowMode: "team",
    agents: [
      { id: "coordinator", name: "Coordinator", role: "Lead" },
      { id: "researcher", name: "Researcher", role: "Research" },
      { id: "analyst", name: "Analyst", role: "Analysis" },
    ],
    tasks: [],
  });
}

function deliver(session: CoworkSession, envelope: CoworkEnvelope) {
  return mailbox().deliver(session, envelope);
}

describe("CoworkMailbox", () => {
  it("routes user group messages to the lead and records delivered mailbox state", async () => {
    const session = await createTeamSession();

    const message = deliver(session, {
      sender_id: "user",
      content: "New constraint",
      visibility: "group",
    });

    expect(message).toMatchObject({
      id: "msg_2",
      sender_id: "user",
      recipient_ids: ["coordinator"],
      content: "New constraint",
    });
    expect(session.agents.coordinator.inbox).toContain("msg_2");
    expect(session.agents.researcher.inbox).not.toContain("msg_2");
    const record = session.mailbox.env_1;
    expect(record).toMatchObject({
      id: "env_1",
      sender_id: "user",
      recipient_ids: ["coordinator"],
      status: "delivered",
      message_id: "msg_2",
      thread_id: "thread_2",
      wake_recipients: true,
    });
    expect(session.events.map((event) => event.type).slice(-2)).toEqual(["mailbox.queued", "mailbox.delivered"]);
    expect(session.trace_spans.at(-1)).toMatchObject({
      kind: "mailbox",
      name: "Mailbox delivered",
      actor_id: "user",
      output_ref: "msg_2",
    });
  });

  it("resets completed-session readiness when a user message reopens the session", async () => {
    const session = await createTeamSession();
    session.status = "completed";
    session.agents.coordinator.status = "done";
    session.completion_decision = {
      next_action: "complete",
      reason: "The cowork session is complete.",
      ready_to_finish: true,
    };

    deliver(session, {
      sender_id: "user",
      content: "Please handle one more constraint.",
      visibility: "group",
    });

    expect(session.status).toBe("active");
    expect(session.agents.coordinator.status).toBe("waiting");
    expect(session.completion_decision).toMatchObject({
      next_action: "run_next_round",
      reason: "2 unread message(s) need agent attention.",
      ready_to_finish: false,
    });
  });

  it("routes lead group messages to the team without the user", async () => {
    const session = await createTeamSession();

    const message = deliver(session, {
      sender_id: "coordinator",
      content: "I found a constraint",
      visibility: "group",
    });

    expect(message.recipient_ids).toEqual(["researcher", "analyst"]);
    expect(message.recipient_ids).not.toContain("user");
    expect(message.recipient_ids).not.toContain("coordinator");
  });

  it("tracks multi-recipient reply lifecycle by correlation", async () => {
    const session = await createTeamSession();
    const box = mailbox();
    const question = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher", "analyst"],
      content: "Please introduce yourselves.",
      requires_reply: true,
      correlation_id: "intro-all",
    });
    const record = Object.values(session.mailbox).find((item) => item.message_id === question.id);

    box.deliver(session, {
      sender_id: "analyst",
      recipient_ids: ["coordinator"],
      content: "Analyst intro.",
      correlation_id: "intro-all",
    });

    expect(record).toMatchObject({
      status: "delivered",
      replied_by: ["analyst"],
    });

    box.deliver(session, {
      sender_id: "researcher",
      recipient_ids: ["coordinator"],
      content: "Researcher intro.",
      correlation_id: "intro-all",
    });

    expect(record).toMatchObject({
      status: "replied",
      replied_by: expect.arrayContaining(["analyst", "researcher"]),
    });
    expect(session.events.some((event) => event.type === "mailbox.replied")).toBe(true);
  });

  it("refreshes completion decisions with pending reply blockers after delivery", async () => {
    const session = await createTeamSession();

    const message = deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please verify this claim before we finish.",
      request_type: "verify",
      blocking_task_id: "task_1",
      requires_reply: true,
    });

    expect(message.recipient_ids).toEqual(["researcher"]);
    expect(session.completion_decision).toMatchObject({
      next_action: "resolve_blockers",
      reason: "1 reply request(s) are still open.",
      ready_to_finish: false,
      blocked: [
        {
          id: "env_1",
          from: "coordinator",
          to: ["researcher"],
          request_type: "verify",
          blocking_task_id: "task_1",
          content: "Please verify this claim before we finish.",
        },
      ],
    });
  });

  it("keeps failed-task review ahead of reply blockers when refreshing decisions", async () => {
    const session = await createTeamSession();
    session.tasks.task_1 = {
      id: "task_1",
      title: "Verify result",
      description: "Check the result before finalizing.",
      assigned_agent_id: "researcher",
      status: "failed",
      dependencies: [],
      result: "",
      error: "Verification failed.",
      created_at: fixedNow,
      updated_at: fixedNow,
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please reply once the failure is understood.",
      request_type: "verify",
      blocking_task_id: "task_1",
      requires_reply: true,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "review_failed_tasks",
      reason: "1 task(s) failed and need review.",
      ready_to_finish: false,
      blocked: [
        expect.objectContaining({
          id: "env_1",
          request_type: "verify",
          blocking_task_id: "task_1",
        }),
      ],
    });
  });

  it("keeps convergence review ahead of unread inbox work when refreshing decisions", async () => {
    const session = await createTeamSession();
    session.no_progress_rounds = 2;

    deliver(session, {
      sender_id: "analyst",
      recipient_ids: ["coordinator"],
      content: "Another note without tracked progress.",
      wake_recipients: true,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "review_convergence",
      reason: "No tracked progress for 2 consecutive round(s).",
      ready_to_finish: false,
      no_progress_rounds: 2,
      convergence_limit: 2,
    });
  });

  it("marks completed task results ready to summarize when no inbox work remains", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Answer question",
        description: "Provide the recommendation.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Recommend option A.",
        result_data: { answer: "Recommend option A." },
        confidence: 0.9,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Thanks for the completed answer.",
      wake_recipients: false,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "summarize",
      reason: "All known tasks are complete or skipped.",
      ready_to_finish: true,
      goal_review: {
        ready: true,
        reason: "Known task results appear sufficient.",
        missing: [],
      },
    });
  });

  it("refreshes Python-shaped decision metadata after mailbox delivery", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.workflow_mode = "team";
    session.current_focus_task = "Draft final answer";
    session.workspace_dir = "D:/workspace/cowork/session-1";
    session.stop_reason = "budget_exhausted";
    session.artifacts = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"];
    session.budget_limits = {
      max_rounds_per_run: 5,
      max_tokens: 1000,
    };
    session.budget_usage = {
      rounds: 2,
      tokens_total: 400,
    };
    session.shared_memory = {
      findings: [{ text: "Finding A" }, { text: "Finding B" }],
      claims: [{ text: "Claim A" }],
      risks: [],
      open_questions: [{ text: "Question A" }],
      decisions: [{ text: "Decision A" }],
      artifacts: [{ text: "a.md" }],
    };
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Answer question",
        description: "Provide the recommendation.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Recommend option A.",
        result_data: { answer: "Recommend option A." },
        confidence: 0.9,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Metadata should stay current.",
      wake_recipients: false,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "summarize",
      workflow_mode: "team",
      workflow_profile: "team",
      stop_reason: "budget_exhausted",
      focus_task: "Synthesize completed work into the final answer.",
      workspace_dir: "D:/workspace/cowork/session-1",
      artifacts: ["b.md", "c.md", "d.md", "e.md", "f.md", "g.md", "h.md", "i.md"],
      shared_memory_counts: {
        findings: 2,
        claims: 1,
        risks: 0,
        open_questions: 1,
        decisions: 1,
        artifacts: 1,
      },
      budget: {
        limits: {
          max_rounds_per_run: 5,
          max_tokens: 1000,
        },
        usage: {
          rounds: 2,
          tokens_total: 400,
          stop_reason: "budget_exhausted",
        },
        remaining: {
          max_rounds_per_run: 3,
          max_tokens: 600,
        },
        stop_reason: "budget_exhausted",
      },
    });
  });

  it("refreshes Python-shaped agent readiness scores after mailbox delivery", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.agents.researcher.inbox = ["msg_existing"];
    session.messages.msg_existing = {
      id: "msg_existing",
      thread_id: "thread_1",
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Existing note",
      created_at: fixedNow,
      read_by: [],
    };
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Ready research task",
        description: "This task is ready for the researcher.",
        assigned_agent_id: "researcher",
        status: "pending",
        dependencies: [],
        result: "",
        result_data: {},
        confidence: null,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please unblock this before we continue.",
      requires_reply: true,
      request_type: "unblock",
      priority: 4,
      wake_recipients: false,
    });

    expect(session.completion_decision.next_action).toBe("resolve_blockers");
    expect(session.completion_decision.readiness).toEqual([
      expect.objectContaining({
        agent_id: "researcher",
        name: "Researcher",
        status: "waiting",
        score: 105,
        inbox_count: 2,
        ready_tasks: ["task_1"],
        pending_replies: ["env_1"],
        activation_reasons: ["inbox_work", "ready_task", "pending_reply", "shared_task_claim"],
        team_id: "",
        parent_agent_id: null,
      }),
      expect.any(Object),
      expect.any(Object),
    ]);
    expect(session.completion_decision.readiness[0]).toMatchObject({
      agent_id: "researcher",
      score: 105,
    });
  });

  it("includes shared task claim readiness for unassigned pending tasks", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.agents.researcher.inbox = [];
    session.agents.analyst.inbox = [];
    session.tasks = {
      dependency: {
        id: "dependency",
        title: "Dependency",
        description: "Completed prerequisite.",
        assigned_agent_id: "coordinator",
        status: "completed",
        dependencies: [],
        result: "Done",
        result_data: {},
        confidence: null,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
      shared_task: {
        id: "shared_task",
        title: "Shared follow-up",
        description: "Any active agent can claim this task.",
        assigned_agent_id: null,
        status: "pending",
        dependencies: ["dependency"],
        result: "",
        result_data: {},
        confidence: null,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Shared pool has work available.",
      wake_recipients: false,
    });

    const researcherReadiness = session.completion_decision.readiness.find(
      (entry: Record<string, unknown>) => entry.agent_id === "researcher",
    );
    expect(researcherReadiness).toMatchObject({
      agent_id: "researcher",
      ready_tasks: [],
      pending_replies: [],
      activation_reasons: ["shared_task_claim"],
    });
  });

  it("boosts lead readiness for synthesis when completed work has no user-visible result", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.agents.researcher.inbox = [];
    session.agents.analyst.inbox = [];
    session.tasks = {
      research: {
        id: "research",
        title: "Research",
        description: "Summarize migrated backend behavior.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Backend behavior summarized.",
        result_data: { answer: "Backend behavior summarized." },
        confidence: 0.8,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["analyst"],
      content: "Refresh readiness after research completion.",
      wake_recipients: false,
    });

    const coordinatorReadiness = session.completion_decision.readiness.find(
      (entry: Record<string, unknown>) => entry.agent_id === "coordinator",
    );
    expect(coordinatorReadiness).toMatchObject({
      agent_id: "coordinator",
      score: 75,
      activation_reasons: ["synthesis"],
    });
  });

  it("recomputes the session focus task from pending reply blockers after delivery", async () => {
    const session = await createTeamSession();
    session.current_focus_task = "Stale focus";

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please resolve the packaging blocker before final synthesis.",
      requires_reply: true,
      request_type: "unblock",
      priority: 7,
    });

    expect(session.current_focus_task).toBe(
      "Resolve unblock request from coordinator: Please resolve the packaging blocker before final synthesis.",
    );
    expect(session.completion_decision).toMatchObject({
      focus_task: "Resolve unblock request from coordinator: Please resolve the packaging blocker before final synthesis.",
    });
  });

  it("keeps review-required completed tasks behind review gates instead of summarizing", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Answer question",
        description: "Provide the recommendation.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Recommend option A.",
        result_data: { answer: "Recommend option A." },
        confidence: 0.75,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: true,
        reviewer_agent_ids: ["analyst"],
        review_status: "pending",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Review still needs to pass.",
      wake_recipients: false,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "resolve_review_gates",
      reason: "1 review gate(s) must pass before completion.",
      ready_to_finish: false,
      review_blockers: [
        {
          task_id: "task_1",
          task_title: "Answer question",
          review_status: "pending",
          reviewer_agent_ids: ["analyst"],
        },
      ],
      goal_review: {
        ready: false,
        reason: "Review-required outputs have not passed review.",
        missing: ["review_gates"],
      },
    });
  });

  it("keeps completed fanout groups behind explicit merge synthesis", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Research path A",
        description: "Investigate the first branch.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Path A is viable.",
        result_data: { answer: "Path A is viable." },
        confidence: 0.82,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "fanout_1",
        merge_task_id: "merge_1",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
      task_2: {
        id: "task_2",
        title: "Research path B",
        description: "Investigate the second branch.",
        assigned_agent_id: "analyst",
        status: "skipped",
        dependencies: [],
        result: "Path B was not needed.",
        result_data: { answer: "Path B was not needed." },
        confidence: 0.7,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "fanout_1",
        merge_task_id: "merge_1",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Fanout work is ready for synthesis.",
      wake_recipients: false,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "merge_fanout_work",
      reason: "1 fanout group(s) require synthesis.",
      ready_to_finish: false,
      fanout_blockers: [
        {
          fanout_group_id: "fanout_1",
          task_ids: ["task_1", "task_2"],
          merge_task_ids: ["merge_1"],
        },
      ],
      goal_review: {
        ready: false,
        reason: "Fanout work needs an explicit merge or synthesis task.",
        missing: ["fanout_merge"],
      },
    });
  });

  it("keeps completed task disagreement signals behind synthesis", async () => {
    const session = await createTeamSession();
    session.agents.coordinator.inbox = [];
    session.tasks = {
      task_1: {
        id: "task_1",
        title: "Compare fallback behavior",
        description: "Compare runtime fallback behavior across lanes.",
        assigned_agent_id: "researcher",
        status: "completed",
        dependencies: [],
        result: "Fallback behavior still has an unresolved conflict.",
        result_data: {
          answer: "Fallback behavior still has an unresolved conflict.",
          conflicts: ["Runtime and quality lanes disagree on fallback behavior."],
        },
        confidence: 0.72,
        error: null,
        priority: 0,
        expected_output: "",
        review_required: false,
        reviewer_agent_ids: [],
        review_status: "",
        fanout_group_id: "",
        merge_task_id: "",
        source_blueprint_id: "",
        source_event_id: "",
        runtime_created: false,
        created_at: fixedNow,
        updated_at: fixedNow,
      },
    };

    deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Conflict signal needs synthesis before finalizing.",
      wake_recipients: false,
    });

    expect(session.completion_decision).toMatchObject({
      next_action: "synthesize_disagreements",
      reason: "1 disagreement signal(s) need lead or reviewer synthesis.",
      ready_to_finish: false,
      disagreements: [
        {
          task_id: "task_1",
          kind: "conflicts",
          text: "Runtime and quality lanes disagree on fallback behavior.",
        },
      ],
      goal_review: {
        ready: false,
        reason: "Completed work contains disagreement signals requiring synthesis.",
        missing: ["disagreements"],
      },
    });
  });

  it("deduplicates active correlation requests and returns the original message", async () => {
    const session = await createTeamSession();
    const box = mailbox();

    const first = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Initial request",
      requires_reply: true,
      correlation_id: "shared",
    });
    const second = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Restated request",
      requires_reply: true,
      correlation_id: "shared",
    });

    expect(second.id).toBe(first.id);
    expect(Object.values(session.mailbox).filter((record) => record.correlation_id === "shared")).toHaveLength(1);
    expect(session.events.at(-1)).toMatchObject({
      type: "mailbox.duplicate",
      actor_id: "coordinator",
      data: {
        envelope_id: "env_1",
        message_id: first.id,
      },
    });
  });

  it("does not wake done peers for non-reply messages unless explicitly requested", async () => {
    const session = await createTeamSession();
    session.agents.researcher.status = "done";
    const box = mailbox();

    const quiet = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Thanks for the detailed result.",
    });

    expect(session.mailbox.env_1).toMatchObject({
      message_id: quiet.id,
      requires_reply: false,
      wake_recipients: false,
    });
    expect(session.agents.researcher.inbox).not.toContain(quiet.id);
    expect(session.agents.researcher.status).toBe("done");

    const wake = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please verify this result.",
      requires_reply: true,
    });

    expect(session.mailbox.env_2).toMatchObject({
      message_id: wake.id,
      requires_reply: true,
      wake_recipients: true,
    });
    expect(session.agents.researcher.inbox).toContain(wake.id);
    expect(session.agents.researcher.status).toBe("waiting");
  });

  it("marks inbox messages and linked mailbox records as read", async () => {
    const session = await createTeamSession();
    const box = mailbox();
    const message = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please read this.",
      requires_reply: true,
    });

    const read = box.markMessagesRead(session, "researcher");

    expect(read).toEqual([expect.objectContaining({ id: message.id })]);
    expect(session.messages[message.id].read_by).toEqual(["coordinator", "researcher"]);
    expect(session.agents.researcher.inbox).toEqual([]);
    expect(session.mailbox.env_1).toMatchObject({
      status: "read",
      read_by: ["researcher"],
    });
  });

  it("expires unanswered deadline records and records mailbox expired events", async () => {
    const session = await createTeamSession();
    const box = mailbox();
    box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Short deadline",
      requires_reply: true,
      deadline_round: 0,
      correlation_id: "deadline-1",
    });
    session.rounds = 0;

    const expired = box.expireRecords(session);

    expect(expired).toEqual([expect.objectContaining({ id: "env_1", status: "expired" })]);
    expect(session.mailbox.env_1).toMatchObject({
      status: "expired",
      correlation_id: "deadline-1",
    });
    expect(session.events.at(-1)).toMatchObject({
      type: "mailbox.expired",
      actor_id: "coordinator",
      data: {
        envelope_id: "env_1",
        correlation_id: "deadline-1",
      },
    });
  });

  it("expires overdue mailbox records before delivering new envelopes", async () => {
    const session = await createTeamSession();
    const box = mailbox();
    box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["researcher"],
      content: "Please respond before the next round.",
      requires_reply: true,
      deadline_round: 1,
      correlation_id: "deadline-before-deliver",
    });
    session.rounds = 2;

    const followup = box.deliver(session, {
      sender_id: "coordinator",
      recipient_ids: ["analyst"],
      content: "New request after deadline.",
    });

    expect(followup.id).toBe("msg_3");
    expect(session.mailbox.env_1).toMatchObject({
      status: "expired",
      correlation_id: "deadline-before-deliver",
    });
    expect(session.events.some((event) => event.type === "mailbox.expired"
      && event.data.envelope_id === "env_1")).toBe(true);
  });

  it("escalates stale blockers to reviewer agents and marks records once", async () => {
    const session = await createTeamSession();
    session.agents.reviewer = {
      ...session.agents.analyst,
      id: "reviewer",
      name: "Reviewer",
      role: "Quality reviewer",
      responsibilities: ["Verify risk"],
      inbox: [],
    };
    const box = mailbox();
    box.deliver(session, {
      sender_id: "researcher",
      recipient_ids: ["analyst"],
      content: "I am blocked on this verification.",
      requires_reply: true,
      correlation_id: "blocker-1",
      blocking_task_id: "task_x",
      escalate_after_rounds: 1,
    });
    session.rounds = 1;

    const escalated = box.escalateStaleBlockers(session);

    expect(escalated).toEqual([expect.objectContaining({ id: "env_1", escalated_at: fixedNow })]);
    expect(session.mailbox.env_1).toMatchObject({
      escalated_at: fixedNow,
      status: "delivered",
    });
    expect(session.messages.msg_3).toMatchObject({
      sender_id: "user",
      recipient_ids: ["reviewer"],
      content: expect.stringContaining("Escalate stale blocker env_1 from researcher"),
      thread_id: "thread_2",
    });
    expect(session.agents.reviewer.inbox).toContain("msg_3");
    expect(session.events.at(-1)).toMatchObject({
      type: "mailbox.stale_blocker",
      actor_id: "reviewer",
      data: {
        envelope_id: "env_1",
        target_agent_id: "reviewer",
        blocking_task_id: "task_x",
      },
    });

    expect(box.escalateStaleBlockers(session)).toEqual([]);
  });
});
