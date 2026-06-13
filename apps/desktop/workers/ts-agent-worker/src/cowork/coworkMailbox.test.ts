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
