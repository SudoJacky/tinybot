export type ThreadCapabilityDecision = {
  available: boolean;
  reason?: string;
  reasonCode?: string;
};

export const THREAD_CAPABILITY_IDS = [
  "agent.cancel",
  "agent.retry",
] as const;

export type ThreadEffectiveCapabilities = {
  schemaVersion: "tinybot.effective_capabilities.v2";
  threadId: string;
  evaluatedTurnId?: string;
  capabilities: {
    agent: {
      cancel: ThreadCapabilityDecision;
      retry: ThreadCapabilityDecision;
    };
  };
};

export function normalizeThreadEffectiveCapabilities(
  value: unknown,
  expectedThreadId: string,
): ThreadEffectiveCapabilities {
  const root = recordValue(value);
  if (root.schemaVersion !== "tinybot.effective_capabilities.v2") {
    throw new Error("Chat runtime capabilities use an unsupported schema");
  }
  const threadId = requiredString(root, "threadId");
  if (threadId !== expectedThreadId) {
    throw new Error("Chat runtime capability thread mismatch: " + threadId + ", expected " + expectedThreadId);
  }
  const capabilities = recordValue(root.capabilities);
  const agent = recordValue(capabilities.agent);
  const evaluatedTurnId = optionalString(root.evaluatedTurnId);
  return {
    schemaVersion: "tinybot.effective_capabilities.v2",
    threadId,
    ...(evaluatedTurnId ? { evaluatedTurnId } : {}),
    capabilities: {
      agent: {
        cancel: normalizeDecision(agent.cancel, "agent.cancel"),
        retry: normalizeDecision(agent.retry, "agent.retry"),
      },
    },
  };
}

export function unavailableThreadEffectiveCapabilities(
  threadId: string,
  reasonCode: string,
  reason: string,
): ThreadEffectiveCapabilities {
  const unavailable = (): ThreadCapabilityDecision => ({ available: false, reason, reasonCode });
  return {
    schemaVersion: "tinybot.effective_capabilities.v2",
    threadId,
    capabilities: {
      agent: {
        cancel: unavailable(),
        retry: unavailable(),
      },
    },
  };
}

function normalizeDecision(value: unknown, name: string): ThreadCapabilityDecision {
  const decision = recordValue(value);
  if (typeof decision.available !== "boolean") {
    throw new Error("Chat runtime capability " + name + " is missing an availability decision");
  }
  const reason = optionalString(decision.reason);
  const reasonCode = optionalString(decision.reasonCode);
  if (!decision.available && (!reason || !reasonCode)) {
    throw new Error("Chat runtime capability " + name + " is unavailable without a reason");
  }
  return {
    available: decision.available,
    ...(reason ? { reason } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value[key]);
  if (!result) throw new Error("Chat runtime capability field " + key + " is required");
  return result;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
