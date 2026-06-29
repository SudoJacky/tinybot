export type HeartbeatSessionCandidate = {
  key?: string | null;
  updatedAtMs?: number | null;
};

export type HeartbeatTarget = {
  channel: string;
  chatId: string;
  external: boolean;
};

export function selectHeartbeatTarget(input: {
  sessions: HeartbeatSessionCandidate[];
  enabledChannels: Iterable<string>;
}): HeartbeatTarget {
  const enabled = new Set([...input.enabledChannels].map((channel) => channel.trim()).filter(Boolean));
  const orderedSessions = input.sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => updatedAtMs(right.session) - updatedAtMs(left.session) || left.index - right.index);

  for (const { session } of orderedSessions) {
    const target = parseSessionKey(session.key);
    if (!target || target.channel === "cli" || target.channel === "system") {
      continue;
    }
    if (enabled.has(target.channel)) {
      return { ...target, external: true };
    }
  }
  return { channel: "cli", chatId: "direct", external: false };
}

function parseSessionKey(key: string | null | undefined): Omit<HeartbeatTarget, "external"> | null {
  const normalized = key?.trim() ?? "";
  const separator = normalized.indexOf(":");
  if (separator < 1) {
    return null;
  }
  const channel = normalized.slice(0, separator).trim();
  const chatId = normalized.slice(separator + 1).trim();
  if (!channel || !chatId) {
    return null;
  }
  return { channel, chatId };
}

function updatedAtMs(session: HeartbeatSessionCandidate): number {
  return typeof session.updatedAtMs === "number" && Number.isFinite(session.updatedAtMs)
    ? session.updatedAtMs
    : 0;
}
