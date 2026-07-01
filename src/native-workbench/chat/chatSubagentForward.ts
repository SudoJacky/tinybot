import type { LiveSubagent, SubagentStatus } from "./chatUiProjection";

export type ForwardComposerMode = "normal" | "approval_guidance";

export type SubagentForwardMessage = {
  id: string;
  role: string;
  content: string;
};

export type SubagentForwardBlock = {
  sourceSubagentId: string;
  sourceSubagentName: string;
  messages: SubagentForwardMessage[];
  removable: true;
  autoSend: false;
  fallbackText: string;
};

export type SubagentSyncObservation = {
  observedRevision?: string;
  postInterventionRevision?: string;
};

const CLOSED_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "idle"]);

export function createSubagentForwardBlock(
  subagent: LiveSubagent,
  selectedMessageIds: string[],
): SubagentForwardBlock {
  const selected = new Set(selectedMessageIds);
  const messages = subagent.transcript.messages
    .filter((message) => selected.has(message.id))
    .map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));

  return {
    sourceSubagentId: subagent.id,
    sourceSubagentName: subagent.name,
    messages,
    removable: true,
    autoSend: false,
    fallbackText: [
      `Forwarded from subagent: ${subagent.name}`,
      ...messages.map((message) => `${message.role}: ${message.content}`),
    ].join("\n"),
  };
}

export function requiresForwardApprovalGuidanceConfirmation(mode: ForwardComposerMode): boolean {
  return mode === "approval_guidance";
}

export function reconcileSubagentSyncState(
  subagent: LiveSubagent,
  observation: SubagentSyncObservation,
): LiveSubagent {
  if (
    subagent.status !== "user_intervened_unsynced"
    || !observation.postInterventionRevision
    || observation.observedRevision !== observation.postInterventionRevision
  ) {
    return subagent;
  }
  return {
    ...subagent,
    status: "has_update",
  };
}

export function canSendDirectSubagentMessage(subagent: LiveSubagent): boolean {
  return (
    subagent.capabilities.includes("can_send_message")
    && subagent.transcript.capability === "full_transcript"
    && !CLOSED_SUBAGENT_STATUSES.has(subagent.status)
  );
}

export function requiresFirstDirectSubagentMessageConfirmation(subagent: LiveSubagent): boolean {
  return subagent.status === "waiting_main_agent" && canSendDirectSubagentMessage(subagent);
}
