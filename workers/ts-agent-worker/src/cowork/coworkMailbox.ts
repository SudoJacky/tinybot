import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import { defaultPolicyRegistry } from "./coworkPolicy.ts";
import type { CoworkEvent, CoworkSession } from "./coworkTypes.ts";

const CONVERGENCE_IDLE_ROUNDS = 2;
const SHARED_MEMORY_BUCKETS = ["findings", "claims", "risks", "open_questions", "decisions", "artifacts"] as const;

export type CoworkEnvelope = {
  sender_id: string;
  content: string;
  recipient_ids?: string[];
  visibility?: "direct" | "group" | "user" | string;
  kind?: "message" | "task_request" | "status" | "result" | "question" | string;
  topic?: string;
  event_type?: string;
  request_type?: "" | "clarify" | "verify" | "produce" | "review" | "unblock" | string;
  thread_id?: string | null;
  requires_reply?: boolean;
  priority?: number;
  deadline_round?: number | null;
  correlation_id?: string | null;
  lineage_id?: string | null;
  reply_to_envelope_id?: string | null;
  caused_by_envelope_id?: string | null;
  expected_output_schema?: JsonObject;
  blocking_task_id?: string | null;
  escalate_after_rounds?: number | null;
  wake_recipients?: boolean | null;
  tool_call_id?: string | null;
  draft_id?: string | null;
};

export type CoworkMailboxOptions = {
  now?: () => string;
  idGenerator?: (prefix: string) => string;
};

export type CoworkMailboxMessage = JsonObject & {
  id: string;
  thread_id: string;
  sender_id: string;
  recipient_ids: string[];
  content: string;
  created_at: string;
  read_by: string[];
};

export class CoworkMailbox {
  private readonly now: () => string;
  private readonly idGenerator: (prefix: string) => string;

  constructor(options: CoworkMailboxOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.idGenerator = options.idGenerator ?? ((prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}`);
  }

  deliver(session: CoworkSession, envelope: CoworkEnvelope): CoworkMailboxMessage {
    this.expireRecords(session);
    const normalized = normalizeEnvelope(envelope);
    const recipients = this.resolveRecipients(session, normalized);
    const threadId = this.resolveThread(session, normalized, recipients);
    const duplicate = findDuplicate(session, normalized, recipients, threadId);
    if (duplicate) {
      const messageId = stringValue(duplicate.message_id);
      const message = session.messages[messageId];
      if (message) {
        session.events = [
          ...session.events,
          this.event("mailbox.duplicate", `Mailbox skipped duplicate ${stringValue(duplicate.kind)} from ${stringValue(duplicate.sender_id)}`, {
            actorId: normalized.sender_id,
            data: {
              envelope_id: stringValue(duplicate.id),
              message_id: messageId,
            },
          }),
        ];
        session.updated_at = this.now();
        return message as CoworkMailboxMessage;
      }
    }

    const wakeRecipients = shouldWakeRecipients(normalized);
    const recordId = nextMapId("env", session.mailbox, this.idGenerator);
    const record: JsonObject = {
      id: recordId,
      sender_id: normalized.sender_id,
      recipient_ids: recipients,
      content: normalized.content,
      visibility: normalized.visibility,
      kind: normalized.kind,
      topic: normalized.topic,
      event_type: normalized.event_type,
      request_type: normalized.request_type,
      status: "queued",
      thread_id: threadId,
      message_id: null,
      requires_reply: normalized.requires_reply || normalized.kind === "question",
      priority: clampPriority(normalized.priority),
      deadline_round: normalized.deadline_round,
      correlation_id: normalized.correlation_id || this.idGenerator("corr"),
      lineage_id: normalized.lineage_id || normalized.correlation_id || this.idGenerator("lin"),
      reply_to_envelope_id: normalized.reply_to_envelope_id,
      caused_by_envelope_id: normalized.caused_by_envelope_id || normalized.reply_to_envelope_id,
      expected_output_schema: jsonSafeObject(normalized.expected_output_schema),
      blocking_task_id: normalized.blocking_task_id,
      escalate_after_rounds: normalized.escalate_after_rounds,
      escalated_at: null,
      wake_recipients: wakeRecipients,
      tool_call_id: normalized.tool_call_id,
      draft_id: normalized.draft_id,
      read_by: [],
      replied_by: [],
      created_at: this.now(),
      updated_at: this.now(),
      delivered_at: null,
    };
    session.mailbox[recordId] = record;
    session.events = [
      ...session.events,
      this.event("mailbox.queued", `Mailbox queued ${normalized.kind} from ${normalized.sender_id}`, {
        actorId: normalized.sender_id,
        data: {
          envelope_id: recordId,
          visibility: normalized.visibility,
          kind: normalized.kind,
          topic: normalized.topic,
          event_type: normalized.event_type,
          priority: record.priority,
          requires_reply: record.requires_reply === true,
          wake_recipients: wakeRecipients,
          deadline_round: normalized.deadline_round,
          correlation_id: record.correlation_id,
          lineage_id: record.lineage_id,
          caused_by_envelope_id: record.caused_by_envelope_id,
          recipients,
        },
      }),
    ];

    const message = this.addMessage(session, normalized, recipients, threadId, wakeRecipients);
    reopenForUserMessage(session, normalized.sender_id, recipients, this.now, (type, messageText, options) => this.event(type, messageText, options));
    record.status = "delivered";
    record.message_id = message.id;
    record.thread_id = message.thread_id;
    record.delivered_at = this.now();
    record.updated_at = record.delivered_at;
    this.markReplies(session, record);
    refreshMailboxCompletionDecision(session, this.now);
    session.events = [
      ...session.events,
      this.event("mailbox.delivered", `Mailbox delivered ${normalized.kind} from ${normalized.sender_id} to ${recipients.join(", ")}`, {
        actorId: normalized.sender_id,
        data: {
          envelope_id: recordId,
          message_id: message.id,
          thread_id: message.thread_id,
          visibility: normalized.visibility,
          kind: normalized.kind,
          topic: normalized.topic,
          event_type: normalized.event_type,
          recipients,
          requires_reply: record.requires_reply === true,
          wake_recipients: wakeRecipients,
          priority: record.priority,
          deadline_round: normalized.deadline_round,
          correlation_id: record.correlation_id,
          lineage_id: record.lineage_id,
          caused_by_envelope_id: record.caused_by_envelope_id,
        },
      }),
    ];
    session.trace_spans = [
      ...session.trace_spans,
      {
        id: nextArrayId("span", session.trace_spans, this.idGenerator),
        session_id: session.id,
        kind: "mailbox",
        name: "Mailbox delivered",
        actor_id: normalized.sender_id,
        status: "delivered",
        started_at: this.now(),
        ended_at: this.now(),
        input_ref: normalized.content,
        output_ref: message.id,
        summary: `${normalized.sender_id} -> ${recipients.join(", ")}`,
        data: {
          envelope_id: recordId,
          message_id: message.id,
          thread_id: message.thread_id,
          visibility: normalized.visibility,
          kind: normalized.kind,
          topic: normalized.topic,
          event_type: normalized.event_type,
          request_type: normalized.request_type,
          recipients,
          requires_reply: record.requires_reply === true,
          wake_recipients: wakeRecipients,
          priority: record.priority,
          deadline_round: normalized.deadline_round,
          correlation_id: record.correlation_id,
          lineage_id: record.lineage_id,
          caused_by_envelope_id: record.caused_by_envelope_id,
          blocking_task_id: normalized.blocking_task_id,
        },
      },
    ];
    session.updated_at = this.now();
    return message;
  }

  markMessagesRead(session: CoworkSession, agentId: string): CoworkMailboxMessage[] {
    const agent = session.agents[agentId];
    if (!agent) {
      return [];
    }
    const messages = agent.inbox
      .map((messageId) => session.messages[messageId])
      .filter((message): message is CoworkMailboxMessage => Boolean(message));
    for (const message of messages) {
      const readBy = arrayValue(message.read_by).map(stringValue);
      if (!readBy.includes(agentId)) {
        message.read_by = [...readBy, agentId];
      }
      this.markRecordReadForMessage(session, message.id, agentId);
    }
    agent.inbox = [];
    session.updated_at = this.now();
    return messages;
  }

  expireRecords(session: CoworkSession): JsonObject[] {
    const expired: JsonObject[] = [];
    for (const record of Object.values(session.mailbox)) {
      const deadlineRound = numberOrNull(record.deadline_round);
      if (
        deadlineRound !== null
        && session.rounds >= deadlineRound
        && !["replied", "expired"].includes(stringValue(record.status))
      ) {
        record.status = "expired";
        record.updated_at = this.now();
        expired.push(record);
        session.events = [
          ...session.events,
          this.event("mailbox.expired", `Mailbox envelope ${stringValue(record.id)} expired`, {
            actorId: stringValue(record.sender_id),
            data: {
              envelope_id: stringValue(record.id),
              correlation_id: stringValue(record.correlation_id),
            },
          }),
        ];
      }
    }
    if (expired.length) {
      session.updated_at = this.now();
    }
    return expired;
  }

  escalateStaleBlockers(session: CoworkSession): JsonObject[] {
    const escalated: JsonObject[] = [];
    const targetId = reviewerAgentId(session) || leadAgentId(session);
    for (const record of Object.values(session.mailbox)) {
      const escalateAfterRounds = numberOrNull(record.escalate_after_rounds);
      if (
        record.requires_reply !== true
        || !["delivered", "read"].includes(stringValue(record.status))
        || escalateAfterRounds === null
        || stringValue(record.escalated_at)
        || session.rounds < escalateAfterRounds
      ) {
        continue;
      }
      record.escalated_at = this.now();
      record.updated_at = record.escalated_at;
      escalated.push(record);
      if (session.agents[targetId] && !arrayValue(record.recipient_ids).map(stringValue).includes(targetId)) {
        this.addMessage(session, {
          sender_id: "user",
          content: `Escalate stale blocker ${stringValue(record.id)} from ${stringValue(record.sender_id)}: ${stringValue(record.content).slice(0, 500)}`,
          recipient_ids: [targetId],
          visibility: "direct",
          kind: "message",
          topic: "",
          event_type: "",
          request_type: "",
          thread_id: nullableString(record.thread_id),
          requires_reply: false,
          priority: 0,
          deadline_round: null,
          correlation_id: null,
          lineage_id: null,
          reply_to_envelope_id: null,
          caused_by_envelope_id: null,
          expected_output_schema: {},
          blocking_task_id: null,
          escalate_after_rounds: null,
          wake_recipients: true,
          tool_call_id: null,
          draft_id: null,
        }, [targetId], stringValue(record.thread_id), true);
      }
      session.events = [
        ...session.events,
        this.event("mailbox.stale_blocker", `Mailbox envelope ${stringValue(record.id)} escalated as a stale blocker`, {
          actorId: targetId,
          data: {
            envelope_id: stringValue(record.id),
            target_agent_id: targetId,
            blocking_task_id: nullableString(record.blocking_task_id),
            caused_by_envelope_id: nullableString(record.caused_by_envelope_id),
          },
        }),
      ];
    }
    if (escalated.length) {
      session.updated_at = this.now();
    }
    return escalated;
  }

  private addMessage(
    session: CoworkSession,
    envelope: RequiredEnvelope,
    recipients: string[],
    threadId: string,
    wakeRecipients: boolean,
  ): CoworkMailboxMessage {
    const thread = session.threads[threadId];
    const messageId = nextMapId("msg", session.messages, this.idGenerator);
    const message: CoworkMailboxMessage = {
      id: messageId,
      thread_id: threadId,
      sender_id: envelope.sender_id,
      recipient_ids: recipients,
      content: envelope.content,
      created_at: this.now(),
      read_by: [envelope.sender_id],
    };
    session.messages[messageId] = message;
    thread.message_ids = [...arrayValue(thread.message_ids).map(stringValue), messageId];
    thread.participant_ids = unique([...arrayValue(thread.participant_ids).map(stringValue), envelope.sender_id, ...recipients].filter(Boolean));
    thread.updated_at = this.now();
    thread.last_message_at = message.created_at;
    for (const recipient of recipients) {
      const agent = session.agents[recipient];
      if (!agent || !wakeRecipients) {
        continue;
      }
      if (!agent.inbox.includes(messageId)) {
        agent.inbox = [...agent.inbox, messageId];
      }
      if (agent.status === "idle" || agent.status === "done") {
        agent.status = "waiting";
      }
    }
    return message;
  }

  private resolveThread(session: CoworkSession, envelope: RequiredEnvelope, recipients: string[]): string {
    if (envelope.thread_id && session.threads[envelope.thread_id]) {
      return envelope.thread_id;
    }
    const existing = findExistingThread(session, envelope.sender_id, recipients);
    if (existing) {
      return existing;
    }
    const threadId = envelope.thread_id || nextMapId("thread", session.threads, this.idGenerator);
    session.threads[threadId] = {
      id: threadId,
      topic: envelope.topic || "General discussion",
      status: "open",
      summary: "",
      participant_ids: unique([envelope.sender_id, ...recipients]),
      message_ids: [],
      created_at: this.now(),
      updated_at: this.now(),
      last_message_at: null,
    };
    return threadId;
  }

  private markReplies(session: CoworkSession, delivered: JsonObject): void {
    for (const record of Object.values(session.mailbox)) {
      if (record.id === delivered.id || record.requires_reply !== true || ["replied", "expired"].includes(stringValue(record.status))) {
        continue;
      }
      const explicitReply = stringValue(delivered.reply_to_envelope_id) === stringValue(record.id);
      const correlatedReply = stringValue(delivered.correlation_id) === stringValue(record.correlation_id)
        && arrayValue(record.recipient_ids).map(stringValue).includes(stringValue(delivered.sender_id));
      const addressedSender = arrayValue(delivered.recipient_ids).map(stringValue).includes(stringValue(record.sender_id));
      if (!explicitReply && !(correlatedReply && addressedSender)) {
        continue;
      }
      const repliedBy = arrayValue(record.replied_by).map(stringValue);
      const deliveredSender = stringValue(delivered.sender_id);
      if (!repliedBy.includes(deliveredSender)) {
        record.replied_by = [...repliedBy, deliveredSender];
      }
      const agentRecipients = arrayValue(record.recipient_ids)
        .map(stringValue)
        .filter((recipient) => Boolean(session.agents[recipient]));
      if (agentRecipients.length === 0 || agentRecipients.every((recipient) => arrayValue(record.replied_by).map(stringValue).includes(recipient))) {
        record.status = "replied";
      }
      record.updated_at = this.now();
      session.events = [
        ...session.events,
        this.event("mailbox.replied", `Mailbox envelope ${stringValue(record.id)} was replied to by ${deliveredSender}`, {
          actorId: deliveredSender,
          data: {
            envelope_id: stringValue(record.id),
            reply_envelope_id: stringValue(delivered.id),
            correlation_id: stringValue(record.correlation_id),
          },
        }),
      ];
    }
  }

  private markRecordReadForMessage(session: CoworkSession, messageId: string, agentId: string): void {
    for (const record of Object.values(session.mailbox)) {
      if (stringValue(record.message_id) !== messageId || ["replied", "expired"].includes(stringValue(record.status))) {
        continue;
      }
      const readBy = arrayValue(record.read_by).map(stringValue);
      if (!readBy.includes(agentId)) {
        record.read_by = [...readBy, agentId];
      }
      if (record.requires_reply === true) {
        record.status = "read";
      }
      record.updated_at = this.now();
    }
  }

  private resolveRecipients(session: CoworkSession, envelope: RequiredEnvelope): string[] {
    const known = new Set([...Object.keys(session.agents), "user"]);
    const explicit = unique(envelope.recipient_ids).filter((recipient) => known.has(recipient));
    const leadId = leadAgentId(session);
    if (session.workflow_mode === "message_bus") {
      const routed = subscribedRecipients(session, envelope);
      if (routed.length && (envelope.sender_id !== "user" || envelope.visibility === "group")) {
        return routed;
      }
    }
    if (envelope.sender_id === "user") {
      return [leadId];
    }
    if (envelope.visibility === "user") {
      return envelope.sender_id === leadId ? ["user"] : [leadId];
    }
    if (envelope.visibility === "group") {
      if (envelope.sender_id !== leadId) {
        return [leadId];
      }
      const team = Object.keys(session.agents).filter((agentId) => agentId !== envelope.sender_id);
      return team.length ? team : ["user"];
    }
    if (explicit.length) {
      if (explicit.includes("user") && envelope.sender_id !== leadId) {
        return unique(explicit.map((recipient) => recipient === "user" ? leadId : recipient).filter((recipient) => recipient !== envelope.sender_id));
      }
      return explicit;
    }
    return envelope.sender_id === leadId ? ["user"] : [leadId];
  }

  private event(type: string, message: string, options: { actorId?: string | null; data?: JsonObject } = {}): CoworkEvent {
    return {
      id: this.idGenerator("evt"),
      type,
      message,
      actor_id: options.actorId,
      data: options.data ?? {},
      created_at: this.now(),
    };
  }
}

type RequiredEnvelope = {
  sender_id: string;
  content: string;
  recipient_ids: string[];
  visibility: string;
  kind: string;
  topic: string;
  event_type: string;
  request_type: string;
  thread_id: string | null;
  requires_reply: boolean;
  priority: number;
  deadline_round: number | null;
  correlation_id: string | null;
  lineage_id: string | null;
  reply_to_envelope_id: string | null;
  caused_by_envelope_id: string | null;
  expected_output_schema: JsonObject;
  blocking_task_id: string | null;
  escalate_after_rounds: number | null;
  wake_recipients: boolean | null;
  tool_call_id: string | null;
  draft_id: string | null;
};

function normalizeEnvelope(envelope: CoworkEnvelope): RequiredEnvelope {
  return {
    sender_id: cleanString(envelope.sender_id),
    content: cleanString(envelope.content),
    recipient_ids: (envelope.recipient_ids ?? []).map(cleanString).filter(Boolean),
    visibility: cleanString(envelope.visibility) || "direct",
    kind: cleanString(envelope.kind) || "message",
    topic: cleanString(envelope.topic),
    event_type: cleanString(envelope.event_type),
    request_type: cleanString(envelope.request_type),
    thread_id: nullableString(envelope.thread_id),
    requires_reply: envelope.requires_reply === true,
    priority: Number(envelope.priority ?? 0),
    deadline_round: numberOrNull(envelope.deadline_round),
    correlation_id: nullableString(envelope.correlation_id),
    lineage_id: nullableString(envelope.lineage_id),
    reply_to_envelope_id: nullableString(envelope.reply_to_envelope_id),
    caused_by_envelope_id: nullableString(envelope.caused_by_envelope_id),
    expected_output_schema: jsonSafeObject(envelope.expected_output_schema),
    blocking_task_id: nullableString(envelope.blocking_task_id),
    escalate_after_rounds: numberOrNull(envelope.escalate_after_rounds),
    wake_recipients: typeof envelope.wake_recipients === "boolean" ? envelope.wake_recipients : null,
    tool_call_id: nullableString(envelope.tool_call_id),
    draft_id: nullableString(envelope.draft_id),
  };
}

function shouldWakeRecipients(envelope: RequiredEnvelope): boolean {
  if (envelope.requires_reply || envelope.kind === "question") return true;
  if (envelope.wake_recipients !== null) return envelope.wake_recipients;
  if (envelope.sender_id === "user" || envelope.visibility === "user") return true;
  if (envelope.kind === "task_request" || envelope.kind === "result") return true;
  if (envelope.request_type) return true;
  if (envelope.reply_to_envelope_id || envelope.caused_by_envelope_id) return true;
  if (envelope.event_type) return true;
  return false;
}

function findDuplicate(session: CoworkSession, envelope: RequiredEnvelope, recipients: string[], threadId: string): JsonObject | null {
  const normalizedContent = envelope.content.trim();
  for (const record of Object.values(session.mailbox).slice().reverse()) {
    if (["replied", "expired"].includes(stringValue(record.status))) {
      continue;
    }
    const recordRecipients = arrayValue(record.recipient_ids).map(stringValue);
    const requiresReply = envelope.requires_reply || envelope.kind === "question";
    if (
      envelope.correlation_id
      && stringValue(record.correlation_id) === envelope.correlation_id
      && stringValue(record.sender_id) === envelope.sender_id
      && sameStrings(recordRecipients, recipients)
      && record.requires_reply === requiresReply
    ) {
      return record;
    }
    if (
      requiresReply
      && record.requires_reply === true
      && stringValue(record.sender_id) === envelope.sender_id
      && sameStrings(recordRecipients, recipients)
      && (!threadId || stringValue(record.thread_id) === threadId)
    ) {
      return record;
    }
    if (
      stringValue(record.sender_id) === envelope.sender_id
      && sameStrings(recordRecipients, recipients)
      && stringValue(record.content).trim() === normalizedContent
      && stringValue(record.visibility) === envelope.visibility
      && stringValue(record.kind) === envelope.kind
      && stringValue(record.topic) === envelope.topic
      && stringValue(record.event_type) === envelope.event_type
      && (!threadId || stringValue(record.thread_id) === threadId)
    ) {
      return record;
    }
  }
  return null;
}

function findExistingThread(session: CoworkSession, senderId: string, recipients: string[]): string | null {
  const participants = new Set([senderId, ...recipients]);
  const threads = Object.values(session.threads)
    .map(jsonSafeObject)
    .sort((left, right) => stringValue(right.updated_at).localeCompare(stringValue(left.updated_at)));
  for (const thread of threads) {
    if (stringValue(thread.topic) !== "General discussion" || (stringValue(thread.status) && stringValue(thread.status) !== "open")) {
      continue;
    }
    const threadParticipants = arrayValue(thread.participant_ids).map(stringValue);
    if (threadParticipants.length === participants.size && threadParticipants.every((participant) => participants.has(participant))) {
      return stringValue(thread.id);
    }
  }
  return null;
}

function reopenForUserMessage(
  session: CoworkSession,
  senderId: string,
  recipients: string[],
  now: () => string,
  event: (type: string, message: string, options: { actorId?: string | null; data?: JsonObject }) => CoworkEvent,
): void {
  if (senderId !== "user") {
    return;
  }
  let reopened = false;
  if (session.status === "completed") {
    session.status = "active";
    reopened = true;
  }
  for (const recipient of recipients) {
    const agent = session.agents[recipient];
    if (agent?.status === "done") {
      agent.status = "waiting";
      reopened = true;
    }
  }
  if (reopened) {
    session.events = [
      ...session.events,
      event("session.reopened", "Cowork session reopened for a new user message", {
        actorId: "user",
        data: { recipients },
      }),
    ];
    session.updated_at = now();
  }
}

function refreshMailboxCompletionDecision(session: CoworkSession, now: () => string): void {
  const pendingReplies = Object.values(session.mailbox)
    .map(jsonSafeObject)
    .filter((record) => record.requires_reply === true && ["delivered", "read"].includes(stringValue(record.status)));
  const unreadMessageCount = countUnreadInboxMessages(session);
  const tasks = Object.values(session.tasks);
  const failedTaskCount = tasks.filter((task) => stringValue(task.status) === "failed").length;
  const pendingOrActiveTaskCount = tasks.filter((task) => {
    const status = stringValue(task.status);
    return status === "pending" || status === "in_progress";
  }).length;
  const reviewBlockers = reviewMailboxGateBlockers(tasks);
  const fanoutBlockers = fanoutMailboxMergeBlockers(tasks);
  const disagreements = detectMailboxDisagreements(tasks);
  const goalReview = reviewMailboxGoalCompletion(session, tasks, reviewBlockers, fanoutBlockers, disagreements);
  session.current_focus_task = deriveMailboxFocusTask(session, tasks, pendingReplies, goalReview);
  let nextAction = "plan";
  let reason = "No tasks exist yet.";
  if (session.status === "completed") {
    nextAction = "complete";
    reason = "The cowork session is complete.";
  } else if (failedTaskCount > 0) {
    nextAction = "review_failed_tasks";
    reason = `${failedTaskCount} task(s) failed and need review.`;
  } else if (reviewBlockers.length > 0) {
    nextAction = "resolve_review_gates";
    reason = `${reviewBlockers.length} review gate(s) must pass before completion.`;
  } else if (fanoutBlockers.length > 0) {
    nextAction = "merge_fanout_work";
    reason = `${fanoutBlockers.length} fanout group(s) require synthesis.`;
  } else if (disagreements.length > 0) {
    nextAction = "synthesize_disagreements";
    reason = `${disagreements.length} disagreement signal(s) need lead or reviewer synthesis.`;
  } else if (pendingReplies.length > 0) {
    nextAction = "resolve_blockers";
    reason = `${pendingReplies.length} reply request(s) are still open.`;
  } else if (session.no_progress_rounds >= CONVERGENCE_IDLE_ROUNDS) {
    nextAction = "review_convergence";
    reason = `No tracked progress for ${session.no_progress_rounds} consecutive round(s).`;
  } else if (unreadMessageCount > 0) {
    nextAction = "run_next_round";
    reason = `${unreadMessageCount} unread message(s) need agent attention.`;
  } else if (pendingOrActiveTaskCount > 0) {
    nextAction = "run_next_round";
    reason = `${pendingOrActiveTaskCount} task(s) still need progress.`;
  } else if (tasks.length > 0 && goalReview.ready === true) {
    nextAction = "summarize";
    reason = "All known tasks are complete or skipped.";
  } else if (tasks.length > 0) {
    nextAction = "review_goal_completion";
    reason = stringValue(goalReview.reason);
  }
  session.completion_decision = {
    ...jsonSafeObject(session.completion_decision),
    next_action: nextAction,
    reason,
    blocked: pendingReplies.map((record) => ({
      id: stringValue(record.id),
      from: stringValue(record.sender_id),
      to: arrayValue(record.recipient_ids).map(stringValue),
      request_type: stringValue(record.request_type) || (record.requires_reply === true ? "reply" : stringValue(record.kind)),
      blocking_task_id: nullableString(record.blocking_task_id),
      content: stringValue(record.content).slice(0, 240),
    })),
    review_blockers: reviewBlockers,
    fanout_blockers: fanoutBlockers,
    disagreements,
    ready_to_finish: nextAction === "summarize",
    no_progress_rounds: session.no_progress_rounds,
    convergence_limit: CONVERGENCE_IDLE_ROUNDS,
    readiness: mailboxAgentReadinessScores(session).slice(0, 6),
    budget: mailboxBudgetState(session),
    stop_reason: stringValue(session.stop_reason),
    workflow_mode: stringValue(session.workflow_mode),
    workflow_profile: defaultPolicyRegistry().resolve(session.workflow_mode).runtimeProfile,
    focus_task: stringValue(session.current_focus_task),
    workspace_dir: stringValue(session.workspace_dir),
    artifacts: session.artifacts.slice(-8),
    shared_memory_counts: sharedMemoryCounts(session),
    goal_review: goalReview,
    updated_at: now(),
  };
}

function reviewMailboxGateBlockers(tasks: JsonObject[]): JsonObject[] {
  return tasks.flatMap((task) => {
    if (task.review_required !== true) {
      return [];
    }
    const status = stringValue(task.status);
    if (status !== "completed" && status !== "failed") {
      return [];
    }
    const data = jsonSafeObject(task.result_data);
    const reviewStatus = stringValue(task.review_status || data.review_status).toLowerCase();
    if (["passed", "waived", "expired"].includes(reviewStatus)) {
      return [];
    }
    return [{
      task_id: stringValue(task.id),
      task_title: stringValue(task.title),
      review_status: reviewStatus || "required",
      reviewer_agent_ids: arrayValue(task.reviewer_agent_ids).map(stringValue),
    }];
  });
}

function fanoutMailboxMergeBlockers(tasks: JsonObject[]): JsonObject[] {
  const byId = new Map(tasks.map((task) => [stringValue(task.id), task]));
  const fanoutGroups = new Map<string, JsonObject[]>();
  for (const task of tasks) {
    const groupId = stringValue(task.fanout_group_id);
    if (groupId) {
      fanoutGroups.set(groupId, [...(fanoutGroups.get(groupId) ?? []), task]);
    }
  }
  const blockers: JsonObject[] = [];
  for (const [groupId, groupTasks] of fanoutGroups) {
    const completedFanout = groupTasks.filter((task) => ["completed", "skipped"].includes(stringValue(task.status)));
    if (completedFanout.length < groupTasks.length) {
      continue;
    }
    const mergeIds = unique(groupTasks.map((task) => stringValue(task.merge_task_id)).filter(Boolean)).sort();
    const mergeDone = mergeIds.some((mergeId) => {
      const mergeTask = byId.get(mergeId);
      return Boolean(mergeTask && ["completed", "skipped"].includes(stringValue(mergeTask.status)));
    });
    if (mergeIds.length === 0 || !mergeDone) {
      blockers.push({
        fanout_group_id: groupId,
        task_ids: groupTasks.map((task) => stringValue(task.id)),
        merge_task_ids: mergeIds,
      });
    }
  }
  return blockers;
}

function detectMailboxDisagreements(tasks: JsonObject[]): JsonObject[] {
  const signals: JsonObject[] = [];
  const claimsByText = new Map<string, Set<string>>();
  for (const task of tasks) {
    const data = jsonSafeObject(task.result_data);
    for (const key of ["conflicts", "disagreements"]) {
      for (const value of arrayValue(data[key])) {
        const text = cleanString(value);
        if (text) {
          signals.push({ task_id: stringValue(task.id), kind: key, text });
        }
      }
    }
    for (const claim of arrayValue(data.claims)) {
      const text = cleanString(claim).toLowerCase();
      if (text) {
        const authors = claimsByText.get(text) ?? new Set<string>();
        authors.add(stringValue(task.assigned_agent_id));
        claimsByText.set(text, authors);
      }
    }
    const confidence = numberOrNull(task.confidence);
    if (confidence !== null && confidence < 0.35 && stringValue(task.status) === "completed") {
      signals.push({ task_id: stringValue(task.id), kind: "low_confidence", confidence });
    }
  }
  for (const [text, authors] of claimsByText.entries()) {
    if (authors.size > 1 && ["not ", "no ", "cannot", "risk", "conflict"].some((marker) => text.includes(marker))) {
      signals.push({ kind: "claim_conflict", text, authors: [...authors].sort() });
    }
  }
  return signals.slice(0, 20);
}

function deriveMailboxFocusTask(session: CoworkSession, tasks: JsonObject[], pendingReplies: JsonObject[], goalReview: JsonObject): string {
  if (pendingReplies.length > 0) {
    const record = pendingReplies.reduce((best, candidate) => {
      const bestPriority = numberOrNull(best.priority) ?? 0;
      const candidatePriority = numberOrNull(candidate.priority) ?? 0;
      if (candidatePriority !== bestPriority) {
        return candidatePriority > bestPriority ? candidate : best;
      }
      return stringValue(candidate.created_at) > stringValue(best.created_at) ? candidate : best;
    });
    const requestType = stringValue(record.request_type) || "reply";
    return `Resolve ${requestType} request from ${stringValue(record.sender_id)}: ${stringValue(record.content).slice(0, 220)}`;
  }
  const active = tasks.filter((task) => stringValue(task.status) === "in_progress");
  if (active.length > 0) {
    const task = [...active].sort((left, right) => stringValue(left.updated_at).localeCompare(stringValue(right.updated_at)))[0];
    return `${stringValue(task.title)}: ${stringValue(task.description)}`;
  }
  const ready = tasks
    .filter((task) => stringValue(task.status) === "pending")
    .filter((task) => taskDependenciesDone(session, task));
  if (ready.length > 0) {
    const task = [...ready].sort((left, right) => stringValue(left.id).localeCompare(stringValue(right.id)))[0];
    return `${stringValue(task.title)}: ${stringValue(task.description)}`;
  }
  if (tasks.some((task) => stringValue(task.status) === "completed")) {
    if (goalReview.ready !== true) {
      return stringValue(goalReview.reason) || "Review whether the original goal is fully satisfied.";
    }
    return "Synthesize completed work into the final answer.";
  }
  return stringValue(session.goal);
}

function mailboxAgentReadinessScores(session: CoworkSession): JsonObject[] {
  const scores = Object.values(session.agents)
    .filter((agent) => !["done", "failed", "retired"].includes(stringValue(agent.status)))
    .filter((agent) => stringValue(agent.lifecycle_status || "active") !== "retired")
    .map((agent) => {
      const agentId = stringValue(agent.id);
      const readyTasks = readyTaskIdsFor(session, agentId);
      const pendingReplies = pendingReplyRecordIdsFor(session, agentId);
      const activationReasons = activationReasonsFor(session, agentId, readyTasks, pendingReplies);
      return {
        agent_id: agentId,
        name: stringValue(agent.name),
        status: stringValue(agent.status),
        score: mailboxAgentReadinessScore(session, agentId, readyTasks, pendingReplies),
        inbox_count: arrayValue(agent.inbox).length,
        ready_tasks: readyTasks,
        pending_replies: pendingReplies,
        activation_reasons: activationReasons,
        team_id: stringValue(agent.team_id),
        parent_agent_id: nullableString(agent.parent_agent_id),
      };
    });
  return scores.sort((left, right) => (numberOrNull(right.score) ?? 0) - (numberOrNull(left.score) ?? 0));
}

function mailboxAgentReadinessScore(session: CoworkSession, agentId: string, readyTasks: string[], pendingReplies: string[]): number {
  const agent = jsonSafeObject(session.agents[agentId]);
  let score = Math.min(arrayValue(agent.inbox).length, 5) * 8;
  score += mailboxPressureFor(session, agentId);
  if (readyTasks.length > 0) {
    score += 45;
  }
  const status = stringValue(agent.status);
  if (status === "blocked") {
    score -= 25;
  }
  if (status === "waiting") {
    score += 10;
  }
  if (stringValue(agent.current_task_id)) {
    score += 8;
  }
  const rounds = numberOrNull(agent.rounds);
  if (rounds !== null && rounds > 0) {
    score -= Math.min(rounds, 8);
  }
  const profile = defaultPolicyRegistry().resolve(session.workflow_mode).runtimeProfile;
  const leadId = leadAgentId(session);
  if (profile === "team" && agentId !== leadId) {
    score += 10;
  } else if (profile === "orchestrator") {
    score += agentId === leadId ? 25 : -12;
  } else if (profile === "peer_handoff" && (stringValue(agent.current_task_id) || readyTasks.length > 0)) {
    score += 30;
  } else if (profile === "generator_verifier") {
    const reviewer = isReviewerAgent(agent);
    const hasPendingReview = Object.values(session.tasks).some((task) => (
      stringValue(task.status) === "pending"
      && stringValue(task.assigned_agent_id) === agentId
      && looksLikeReviewTask(stringValue(task.title), stringValue(task.description))
    ));
    score += reviewer && hasPendingReview ? 40 : 0;
    score -= reviewer && !hasPendingReview ? 8 : 0;
  } else if (profile === "message_bus") {
    score += agentSubscriptionPressure(session, agentId);
  } else if (profile === "shared_state" && sharedMemoryTexts(session, "open_questions").length > 0) {
    score += 10;
  }
  if (agentId === leadAgentId(session) && leadShouldSynthesize(session)) {
    score += 65;
  }
  return score;
}

function readyTaskIdsFor(session: CoworkSession, agentId: string): string[] {
  return Object.values(session.tasks)
    .filter((task) => stringValue(task.assigned_agent_id) === agentId)
    .filter((task) => stringValue(task.status) === "pending")
    .filter((task) => taskDependenciesDone(session, task))
    .map((task) => stringValue(task.id));
}

function claimableTaskIdsFor(session: CoworkSession, agentId: string): string[] {
  if (!session.agents[agentId]) {
    return [];
  }
  return Object.values(session.tasks)
    .filter((task) => {
      const assignedAgentId = stringValue(task.assigned_agent_id);
      return assignedAgentId === "" || assignedAgentId === agentId;
    })
    .filter((task) => stringValue(task.status) === "pending")
    .filter((task) => taskDependenciesDone(session, task))
    .map((task) => stringValue(task.id))
    .sort();
}

function taskDependenciesDone(session: CoworkSession, task: JsonObject): boolean {
  return arrayValue(task.dependencies).map(stringValue).every((taskId) => {
    const dependency = session.tasks[taskId];
    return dependency && ["completed", "skipped"].includes(stringValue(dependency.status));
  });
}

function pendingReplyRecordIdsFor(session: CoworkSession, agentId: string): string[] {
  return Object.values(session.mailbox)
    .map(jsonSafeObject)
    .filter((record) => arrayValue(record.recipient_ids).map(stringValue).includes(agentId))
    .filter((record) => record.requires_reply === true && ["delivered", "read"].includes(stringValue(record.status)))
    .map((record) => stringValue(record.id));
}

function activationReasonsFor(session: CoworkSession, agentId: string, readyTasks: string[], pendingReplies: string[]): string[] {
  const agent = jsonSafeObject(session.agents[agentId]);
  const reasons: string[] = [];
  if (arrayValue(agent.inbox).length > 0) {
    reasons.push("inbox_work");
  }
  if (readyTasks.length > 0) {
    reasons.push("ready_task");
  }
  if (pendingReplies.length > 0) {
    reasons.push("pending_reply");
  }
  if (claimableTaskIdsFor(session, agentId).length > 0) {
    reasons.push("shared_task_claim");
  }
  if (agentId === leadAgentId(session) && leadShouldSynthesize(session)) {
    reasons.push("synthesis");
  }
  if (Object.values(session.tasks).some((task) => task.review_required === true
    && stringValue(task.status) === "pending"
    && arrayValue(task.reviewer_agent_ids).map(stringValue).includes(agentId))) {
    reasons.push("review_gate");
  }
  return reasons;
}

function mailboxPressureFor(session: CoworkSession, agentId: string): number {
  const agent = jsonSafeObject(session.agents[agentId]);
  let pressure = 0;
  for (const record of Object.values(session.mailbox).map(jsonSafeObject)) {
    if (!arrayValue(record.recipient_ids).map(stringValue).includes(agentId) || ["replied", "expired"].includes(stringValue(record.status))) {
      continue;
    }
    if (arrayValue(agent.inbox).map(stringValue).includes(stringValue(record.message_id))) {
      pressure = Math.max(pressure, numberOrNull(record.priority) ?? 0);
    }
    if (record.requires_reply === true && ["delivered", "read"].includes(stringValue(record.status))) {
      pressure = Math.max(pressure, (numberOrNull(record.priority) ?? 0) + 20);
    }
  }
  return pressure;
}

function agentSubscriptionPressure(session: CoworkSession, agentId: string): number {
  const agent = jsonSafeObject(session.agents[agentId]);
  const subscriptions = new Set(arrayValue(agent.subscriptions).map((item) => stringValue(item).toLowerCase()).filter(Boolean));
  if (subscriptions.size === 0) {
    return 0;
  }
  let pressure = 0;
  for (const record of Object.values(session.mailbox).map(jsonSafeObject)) {
    if (["replied", "expired"].includes(stringValue(record.status))) {
      continue;
    }
    const labels = [
      stringValue(record.topic),
      stringValue(record.event_type),
      stringValue(record.request_type),
      stringValue(record.kind),
    ].map((item) => item.toLowerCase()).filter(Boolean);
    if (labels.some((label) => subscriptions.has(label))) {
      pressure = Math.max(pressure, 10 + Math.min(numberOrNull(record.priority) ?? 0, 40));
    }
  }
  return pressure;
}

function leadShouldSynthesize(session: CoworkSession): boolean {
  const tasks = Object.values(session.tasks);
  if (tasks.length === 0) {
    return false;
  }
  const hasCompleted = tasks.some((task) => stringValue(task.status) === "completed");
  const hasOpenWork = tasks.some((task) => ["pending", "in_progress"].includes(stringValue(task.status)));
  const hasUserVisibleResult = Object.values(session.messages).some((message) => (
    stringValue(message.sender_id) !== "user"
    && arrayValue(message.recipient_ids).map(stringValue).includes("user")
  ));
  return hasCompleted && (!hasOpenWork || !hasUserVisibleResult);
}

function isReviewerAgent(agent: JsonObject): boolean {
  const text = [
    stringValue(agent.id),
    stringValue(agent.name),
    stringValue(agent.role),
    ...arrayValue(agent.responsibilities).map(stringValue),
  ].join(" ").toLowerCase();
  return ["review", "verify", "quality", "risk"].some((marker) => text.includes(marker));
}

function looksLikeReviewTask(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return ["review", "verify", "quality", "risk", "check"].some((marker) => text.includes(marker));
}

function mailboxBudgetState(session: CoworkSession): JsonObject {
  const limits = jsonSafeObject(session.budget_limits);
  const usage = {
    ...jsonSafeObject(session.budget_usage),
    stop_reason: stringValue(session.stop_reason) || stringValue(jsonSafeObject(session.budget_usage).stop_reason),
  };
  return {
    limits,
    usage,
    remaining: budgetRemaining(limits, usage),
    stop_reason: stringValue(usage.stop_reason),
  };
}

function budgetRemaining(limits: JsonObject, usage: JsonObject): JsonObject {
  const pairs: Record<string, string> = {
    max_rounds_per_run: "rounds",
    max_agent_calls_per_run: "agent_calls",
    max_agent_calls_total: "agent_calls",
    max_spawned_agents: "spawned_agents",
    max_tool_calls: "tool_calls",
    max_tokens: "tokens_total",
    max_cost: "cost",
    max_wall_time_seconds: "wall_time_seconds",
  };
  const remaining: JsonObject = {};
  for (const [limitKey, usageKey] of Object.entries(pairs)) {
    const limit = numberOrNull(limits[limitKey]);
    remaining[limitKey] = limit === null ? null : Math.max(0, limit - (numberOrNull(usage[usageKey]) ?? 0));
  }
  return remaining;
}

function sharedMemoryCounts(session: CoworkSession): JsonObject {
  const memory = jsonSafeObject(session.shared_memory);
  const counts: JsonObject = {};
  for (const bucket of SHARED_MEMORY_BUCKETS) {
    counts[bucket] = arrayValue(memory[bucket]).length;
  }
  return counts;
}

function sharedMemoryTexts(session: CoworkSession, bucket: string): string[] {
  const memory = jsonSafeObject(session.shared_memory);
  return arrayValue(memory[bucket])
    .map(jsonSafeObject)
    .map((entry) => stringValue(entry.text).trim())
    .filter(Boolean);
}

function reviewMailboxGoalCompletion(
  session: CoworkSession,
  tasks: JsonObject[],
  reviewBlockers: JsonObject[],
  fanoutBlockers: JsonObject[],
  disagreements: JsonObject[],
): JsonObject {
  const completed = tasks.filter((task) => stringValue(task.status) === "completed");
  const openQuestions = completed.flatMap((task) => arrayValue(jsonSafeObject(task.result_data).open_questions).map(stringValue).filter(Boolean));
  const failed = tasks.filter((task) => stringValue(task.status) === "failed");
  if (failed.length > 0) {
    return { ready: false, reason: `${failed.length} failed task(s) need review.`, missing: ["failed_tasks"] };
  }
  if (reviewBlockers.length > 0) {
    return { ready: false, reason: "Review-required outputs have not passed review.", missing: ["review_gates"] };
  }
  if (fanoutBlockers.length > 0) {
    return { ready: false, reason: "Fanout work needs an explicit merge or synthesis task.", missing: ["fanout_merge"] };
  }
  if (disagreements.length > 0) {
    return { ready: false, reason: "Completed work contains disagreement signals requiring synthesis.", missing: ["disagreements"] };
  }
  if (openQuestions.length > 0) {
    return { ready: false, reason: "Completed work still contains open questions.", missing: ["open_questions"] };
  }
  const goalText = session.goal.toLowerCase();
  const deliveryMarkers = [
    "code",
    "implement",
    "build",
    "edit",
    "write file",
    "create file",
    "fix",
    "test",
    "docs",
    "document",
    "app",
    "page",
    "代码",
    "实现",
    "修复",
    "文件",
    "页面",
    "文档",
  ];
  const likelyDeliveryGoal = deliveryMarkers.some((marker) => goalText.includes(marker));
  if (likelyDeliveryGoal && session.artifacts.length === 0) {
    return {
      ready: false,
      reason: "The goal appears to require concrete deliverables, but no artifact paths are confirmed yet.",
      missing: ["artifacts"],
    };
  }
  const hasStructuredAnswer = completed.some((task) => {
    const data = jsonSafeObject(task.result_data);
    return Boolean(data.answer || data.findings);
  });
  const hasVisibleResult = Object.values(session.messages).map(jsonSafeObject).some((message) => (
    stringValue(message.sender_id) !== "user"
    && arrayValue(message.recipient_ids).map(stringValue).includes("user")
    && Boolean(stringValue(message.content).trim())
  ));
  if (completed.length > 0 && !hasStructuredAnswer && !hasVisibleResult && !stringValue(session.final_draft)) {
    return {
      ready: false,
      reason: "Tasks are marked complete, but there is no structured answer or user-facing result yet.",
      missing: ["final_answer"],
    };
  }
  return { ready: completed.length > 0, reason: "Known task results appear sufficient.", missing: [] };
}

function countUnreadInboxMessages(session: CoworkSession): number {
  return Object.values(session.agents).reduce((total, agent) => {
    if (agent.status === "done" || agent.status === "failed") {
      return total;
    }
    return total + agent.inbox.filter((messageId) => Boolean(session.messages[messageId])).length;
  }, 0);
}

function subscribedRecipients(session: CoworkSession, envelope: RequiredEnvelope): string[] {
  const labels = new Set([envelope.topic, envelope.event_type, envelope.request_type, envelope.kind].map((item) => item.toLowerCase()).filter(Boolean));
  if (labels.size === 0) {
    return [];
  }
  return Object.values(session.agents)
    .filter((agent) => agent.id !== envelope.sender_id)
    .filter((agent) => agent.subscriptions.some((subscription) => labels.has(subscription.toLowerCase())))
    .map((agent) => agent.id);
}

function reviewerAgentId(session: CoworkSession): string {
  const reviewer = Object.values(session.agents).find((agent) => {
    const text = [agent.id, agent.name, agent.role, ...agent.responsibilities].join(" ").toLowerCase();
    return ["review", "verify", "quality", "risk"].some((marker) => text.includes(marker));
  });
  return reviewer?.id ?? "";
}

function leadAgentId(session: CoworkSession): string {
  for (const candidate of ["coordinator", "lead", "team_lead", "team-lead"]) {
    if (session.agents[candidate]) {
      return candidate;
    }
  }
  return Object.keys(session.agents)[0] ?? "";
}

function nextMapId(prefix: string, map: Record<string, unknown>, idGenerator: (prefix: string) => string): string {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = idGenerator(prefix);
    if (!Object.prototype.hasOwnProperty.call(map, id)) {
      return id;
    }
  }
  return `${prefix}_${Object.keys(map).length + 1}`;
}

function nextArrayId(prefix: string, items: JsonObject[], idGenerator: (prefix: string) => string): string {
  const existing = new Set(items.map((item) => stringValue(item.id)));
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const id = idGenerator(prefix);
    if (!existing.has(id)) {
      return id;
    }
  }
  return `${prefix}_${items.length + 1}`;
}

function clampPriority(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(parsed)));
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function jsonSafeObject(value: unknown): JsonObject {
  return isJsonObject(value) ? { ...value } : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nullableString(value: unknown): string | null {
  const text = cleanString(value);
  return text || null;
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === null || value === undefined ? "" : String(value).trim();
}
