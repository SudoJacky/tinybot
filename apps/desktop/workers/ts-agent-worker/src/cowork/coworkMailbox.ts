import { isJsonObject, type JsonObject } from "../protocol/messages.ts";
import type { CoworkEvent, CoworkSession } from "./coworkTypes.ts";

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
    const threadId = nextMapId("thread", session.threads, this.idGenerator);
    session.threads[threadId] = {
      id: threadId,
      topic: "General discussion",
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
    session.completion_decision = {
      ...jsonSafeObject(session.completion_decision),
      next_action: "run_next_round",
    };
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
