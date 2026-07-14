export type TinyOsCapabilityDecision = {
  available: boolean;
  reason?: string;
  reasonCode?: string;
};

export const TINYOS_CAPABILITY_IDS = [
  "agent.pause",
  "agent.resume",
  "agent.cancel",
  "agent.retry",
  "files.read",
  "files.requestChange",
  "files.directEdit",
  "files.save",
  "terminal.inspect",
  "terminal.execute",
  "terminal.cancel",
  "browser.structured",
  "browser.realCapture",
  "browser.interact",
] as const;

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
      contract: "retained_execution_v1";
      persistentPty: false;
      inspect: TinyOsCapabilityDecision;
      execute: TinyOsCapabilityDecision;
      cancel: TinyOsCapabilityDecision;
    };
    browser: {
      interactionRequires: "current_real_capture";
      structured: TinyOsCapabilityDecision;
      projectionContract: "structured_projection_v1";
      realCapture: TinyOsCapabilityDecision;
      sessionContract: "browser_session_v1";
      sessionSnapshot: boolean;
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
        contract: normalizeTerminalContract(terminal),
        persistentPty: normalizePersistentPty(terminal),
        inspect: normalizeDecision(terminal.inspect, "terminal.inspect"),
        execute: normalizeDecision(terminal.execute, "terminal.execute"),
        cancel: normalizeDecision(terminal.cancel, "terminal.cancel"),
      },
      browser: {
        interactionRequires: normalizeLiteral(browser.interactionRequires, "current_real_capture", "browser interaction requirement"),
        structured: normalizeDecision(browser.structured, "browser.structured"),
        projectionContract: normalizeLiteral(browser.projectionContract, "structured_projection_v1", "browser projection contract"),
        realCapture: normalizeDecision(browser.realCapture, "browser.realCapture"),
        sessionContract: normalizeLiteral(browser.sessionContract, "browser_session_v1", "browser session contract"),
        sessionSnapshot: normalizeBoolean(browser.sessionSnapshot, "browser session snapshot"),
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
      terminal: {
        contract: "retained_execution_v1",
        persistentPty: false,
        inspect: unavailable(),
        execute: unavailable(),
        cancel: unavailable(),
      },
      browser: {
        interactionRequires: "current_real_capture",
        structured: unavailable(),
        projectionContract: "structured_projection_v1",
        realCapture: unavailable(),
        sessionContract: "browser_session_v1",
        sessionSnapshot: false,
        interact: unavailable(),
      },
    },
  };
}

function normalizeTerminalContract(value: Record<string, unknown>): "retained_execution_v1" {
  if (value.contract !== "retained_execution_v1") {
    throw new Error("TinyOS terminal capability uses an unsupported execution contract");
  }
  return value.contract;
}

function normalizePersistentPty(value: Record<string, unknown>): false {
  if (value.persistentPty !== false) {
    throw new Error("TinyOS retained terminal capability must declare persistentPty=false");
  }
  return false;
}

function normalizeLiteral<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`TinyOS ${label} is unsupported`);
  return expected;
}

function normalizeBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`TinyOS ${label} availability is missing`);
  return value;
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
