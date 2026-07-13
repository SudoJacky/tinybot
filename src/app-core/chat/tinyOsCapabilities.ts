export type TinyOsCapabilityDecision = {
  available: boolean;
  reason?: string;
  reasonCode?: string;
};

export type TinyOsEffectiveCapabilities = {
  schemaVersion: "tinybot.effective_capabilities.v1";
  sessionId: string;
  evaluatedRunId?: string;
  capabilities: {
    agent: {
      pause: TinyOsCapabilityDecision;
      resume: TinyOsCapabilityDecision;
      cancel: TinyOsCapabilityDecision;
      retry: TinyOsCapabilityDecision;
    };
    files: {
      read: TinyOsCapabilityDecision;
      requestChange: TinyOsCapabilityDecision;
      directEdit: TinyOsCapabilityDecision;
      save: TinyOsCapabilityDecision;
    };
    terminal: {
      inspect: TinyOsCapabilityDecision;
      execute: TinyOsCapabilityDecision;
      cancel: TinyOsCapabilityDecision;
    };
    browser: {
      structured: TinyOsCapabilityDecision;
      realCapture: TinyOsCapabilityDecision;
      interact: TinyOsCapabilityDecision;
    };
  };
};

export function normalizeTinyOsEffectiveCapabilities(
  value: unknown,
  expectedSessionId: string,
): TinyOsEffectiveCapabilities {
  const root = recordValue(value);
  if (root.schemaVersion !== "tinybot.effective_capabilities.v1") {
    throw new Error("TinyOS effective capabilities use an unsupported schema");
  }
  const sessionId = requiredString(root, "sessionId");
  if (sessionId !== expectedSessionId) {
    throw new Error(`TinyOS capability session mismatch: ${sessionId}, expected ${expectedSessionId}`);
  }
  const capabilities = recordValue(root.capabilities);
  const agent = recordValue(capabilities.agent);
  const files = recordValue(capabilities.files);
  const terminal = recordValue(capabilities.terminal);
  const browser = recordValue(capabilities.browser);
  return {
    schemaVersion: "tinybot.effective_capabilities.v1",
    sessionId,
    ...(optionalString(root.evaluatedRunId) ? { evaluatedRunId: optionalString(root.evaluatedRunId) } : {}),
    capabilities: {
      agent: {
        pause: normalizeDecision(agent.pause, "agent.pause"),
        resume: normalizeDecision(agent.resume, "agent.resume"),
        cancel: normalizeDecision(agent.cancel, "agent.cancel"),
        retry: normalizeDecision(agent.retry, "agent.retry"),
      },
      files: {
        read: normalizeDecision(files.read, "files.read"),
        requestChange: normalizeDecision(files.requestChange, "files.requestChange"),
        directEdit: normalizeDecision(files.directEdit, "files.directEdit"),
        save: normalizeDecision(files.save, "files.save"),
      },
      terminal: {
        inspect: normalizeDecision(terminal.inspect, "terminal.inspect"),
        execute: normalizeDecision(terminal.execute, "terminal.execute"),
        cancel: normalizeDecision(terminal.cancel, "terminal.cancel"),
      },
      browser: {
        structured: normalizeDecision(browser.structured, "browser.structured"),
        realCapture: normalizeDecision(browser.realCapture, "browser.realCapture"),
        interact: normalizeDecision(browser.interact, "browser.interact"),
      },
    },
  };
}

export function unavailableTinyOsEffectiveCapabilities(
  sessionId: string,
  reasonCode: string,
  reason: string,
): TinyOsEffectiveCapabilities {
  const unavailable = (): TinyOsCapabilityDecision => ({ available: false, reason, reasonCode });
  return {
    schemaVersion: "tinybot.effective_capabilities.v1",
    sessionId,
    capabilities: {
      agent: { pause: unavailable(), resume: unavailable(), cancel: unavailable(), retry: unavailable() },
      files: { read: unavailable(), requestChange: unavailable(), directEdit: unavailable(), save: unavailable() },
      terminal: { inspect: unavailable(), execute: unavailable(), cancel: unavailable() },
      browser: { structured: unavailable(), realCapture: unavailable(), interact: unavailable() },
    },
  };
}

function normalizeDecision(value: unknown, name: string): TinyOsCapabilityDecision {
  const decision = recordValue(value);
  if (typeof decision.available !== "boolean") {
    throw new Error(`TinyOS capability ${name} is missing an availability decision`);
  }
  const reason = optionalString(decision.reason);
  const reasonCode = optionalString(decision.reasonCode);
  if (!decision.available && (!reason || !reasonCode)) {
    throw new Error(`TinyOS capability ${name} is unavailable without a reason`);
  }
  return {
    available: decision.available,
    ...(reason ? { reason } : {}),
    ...(reasonCode ? { reasonCode } : {}),
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value[key]);
  if (!result) throw new Error(`TinyOS capability field ${key} is required`);
  return result;
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
