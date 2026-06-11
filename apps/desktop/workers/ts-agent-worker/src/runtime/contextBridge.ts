import type { AgentMessage } from "../agent/agentRunSpec.ts";
import {
  type AgentRunDefaults,
  BOOTSTRAP_FILE_ORDER,
  type AgentRunInput,
  type BootstrapFile,
  type ContextBridgeLoadResult,
  type MemoryRecallNote,
  type UserProfile,
} from "../agent/contextTypes.ts";
import type { JsonObject } from "../protocol/messages.ts";
import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";

const DEFAULT_IDENTITY = "You are TinyBot running in the desktop native TS worker.";
const DEFAULT_HISTORY_LIMIT = 80;

export type ContextBridge = {
  loadContextInput(input: AgentRunInput, traceId: string): Promise<ContextBridgeLoadResult>;
};

export class NativeContextBridge implements ContextBridge {
  private readonly rpcClient: NativeRpcClient;

  constructor(rpcClient: NativeRpcClient) {
    this.rpcClient = rpcClient;
  }

  async loadContextInput(input: AgentRunInput, traceId: string): Promise<ContextBridgeLoadResult> {
    const runtime = await this.loadRuntime(input, traceId);
    const runDefaults = await this.loadRunDefaults(traceId);
    const history = await this.loadHistory(input, traceId);
    const bootstrap = await this.loadBootstrapFiles(traceId);
    const memoryNotes = await this.loadMemoryNotes(input, traceId);
    return {
      input: {
        identity: DEFAULT_IDENTITY,
        bootstrapFiles: bootstrap.files,
        history: history.messages,
        memoryNotes,
        currentMessage: input.input.content,
        currentRole: input.input.role ?? "user",
        runtime: {
          currentTime: runtime.currentTime,
          channel: input.channel,
          chatId: input.chatId,
          userProfile: history.userProfile,
        },
      },
      runDefaults,
      metadata: {
        missingSession: history.missingSession,
        malformedHistoryCount: history.malformedHistoryCount,
        missingBootstrapFiles: bootstrap.missing,
        bootstrapFallbackUsed: bootstrap.fallbackUsed,
      },
    };
  }

  private async loadRuntime(input: AgentRunInput, traceId: string): Promise<{ currentTime: string }> {
    try {
      const timezone = typeof input.metadata?.timezone === "string" ? input.metadata.timezone : undefined;
      const result = asObject(await this.rpcClient.request(traceId, "runtime.now", timezone ? { timezone } : {}));
      return {
        currentTime: asString(result?.current_time) ?? asString(result?.currentTime) ?? new Date().toISOString(),
      };
    } catch {
      return { currentTime: new Date().toISOString() };
    }
  }

  private async loadHistory(input: AgentRunInput, traceId: string): Promise<{
    messages: AgentMessage[];
    userProfile?: UserProfile;
    missingSession: boolean;
    malformedHistoryCount: number;
  }> {
    try {
      const result = asObject(await this.rpcClient.request(traceId, "session.get_history", {
        session_id: input.sessionId,
        limit: DEFAULT_HISTORY_LIMIT,
      }));
      const rawMessages = Array.isArray(result?.messages) ? result.messages : [];
      const normalizedMessages = rawMessages.map(normalizeHistoryMessage);
      const messages = normalizedMessages.filter((message): message is AgentMessage => message !== null);
      return {
        messages,
        userProfile: normalizeUserProfile(result?.user_profile ?? result?.userProfile),
        missingSession: false,
        malformedHistoryCount: normalizedMessages.length - messages.length,
      };
    } catch {
      return {
        messages: [],
        missingSession: true,
        malformedHistoryCount: 0,
      };
    }
  }

  private async loadBootstrapFiles(traceId: string): Promise<{
    files: BootstrapFile[];
    missing: string[];
    fallbackUsed: boolean;
  }> {
    const files = [...BOOTSTRAP_FILE_ORDER];
    try {
      const result = asObject(await this.rpcClient.request(traceId, "workspace.read_bootstrap_files", { files }));
      return {
        files: normalizeBootstrapFiles(result?.files),
        missing: normalizeStringArray(result?.missing),
        fallbackUsed: false,
      };
    } catch {
      const fallbackFiles: BootstrapFile[] = [];
      const missing: string[] = [];
      for (const path of files) {
        try {
          const result = asObject(await this.rpcClient.request(traceId, "workspace.read_file", { path }));
          const responsePath = asString(result?.path);
          const contents = asString(result?.contents);
          if (responsePath === path && contents !== undefined) {
            fallbackFiles.push({ path, contents });
          } else {
            missing.push(path);
          }
        } catch {
          missing.push(path);
        }
      }
      return { files: fallbackFiles, missing, fallbackUsed: true };
    }
  }

  private async loadRunDefaults(traceId: string): Promise<AgentRunDefaults> {
    try {
      const result = asObject(await this.rpcClient.request(traceId, "config.snapshot_public", {}));
      const snapshot = asObject(result?.value);
      const agents = asObject(snapshot?.agents);
      const defaults = asObject(agents?.defaults);
      return {
        providerRetryMode: providerRetryModeValue(defaults?.providerRetryMode ?? defaults?.provider_retry_mode),
      };
    } catch {
      return {};
    }
  }

  private async loadMemoryNotes(input: AgentRunInput, traceId: string): Promise<MemoryRecallNote[]> {
    if (!shouldLoadMemoryNotes(input.input.content)) {
      return [];
    }
    try {
      const result = asObject(await this.rpcClient.request(traceId, "memory.search", {
        query: input.input.content,
        status: "active",
        limit: 6,
      }));
      return normalizeMemoryNotes(result?.notes);
    } catch {
      return [];
    }
  }
}

function normalizeHistoryMessage(value: unknown): AgentMessage | null {
  const object = asObject(value);
  if (!object || !isAgentRole(object.role) || typeof object.content !== "string") {
    return null;
  }
  const toolCalls = normalizeToolCalls(object.toolCalls ?? object.tool_calls);
  const toolCallId = asString(object.toolCallId ?? object.tool_call_id);
  const reasoningContent = asString(object.reasoningContent ?? object.reasoning_content);
  const thinkingBlocks = normalizeThinkingBlocks(object.thinkingBlocks ?? object.thinking_blocks);
  const metadata = asObject(object.metadata);
  return {
    role: object.role,
    content: object.content,
    ...(reasoningContent !== undefined ? { reasoningContent } : {}),
    ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(asString(object.name) ? { name: asString(object.name) } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function normalizeToolCalls(value: unknown): AgentMessage["toolCalls"] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const object = asObject(entry);
    if (!object) {
      return null;
    }
    const functionPayload = asObject(object.function);
    const id = asString(object.id);
    const name = asString(object.name) ?? asString(functionPayload?.name);
    const argumentsJson = asString(object.argumentsJson)
      ?? asString(object.arguments_json)
      ?? asString(functionPayload?.arguments);
    return id && name && argumentsJson !== undefined ? { id, name, argumentsJson } : null;
  }).filter((toolCall): toolCall is NonNullable<AgentMessage["toolCalls"]>[number] => toolCall !== null);
}

function normalizeThinkingBlocks(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function normalizeBootstrapFiles(value: unknown): BootstrapFile[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const object = asObject(entry);
    const path = asString(object?.path);
    const contents = asString(object?.contents);
    return path && contents !== undefined ? { path, contents } : null;
  }).filter((file): file is BootstrapFile => file !== null);
}

function normalizeUserProfile(value: unknown): UserProfile | undefined {
  const object = asObject(value);
  if (!object) {
    return undefined;
  }
  return {
    name: asString(object.name),
    preferences: normalizeStringArray(object.preferences),
    mentionedEntities: normalizeStringArray(object.mentionedEntities ?? object.mentioned_entities),
    communicationStyle: asString(object.communicationStyle ?? object.communication_style),
    keyFacts: normalizeStringArray(object.keyFacts ?? object.key_facts),
  };
}

function normalizeMemoryNotes(value: unknown): MemoryRecallNote[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const object = asObject(entry);
    const id = asString(object?.id);
    const scope = asString(object?.scope);
    const type = asString(object?.type);
    const status = asString(object?.status);
    const content = asString(object?.content);
    if (!id || !scope || !type || !status || content === undefined) {
      return null;
    }
    const metadata = asObject(object?.metadata);
    const viewLine = numberValue(object?.view_line ?? object?.viewLine);
    const evidenceIds = memoryEvidenceIds(object?.sources ?? object?.evidence_ids ?? object?.evidenceIds);
    return {
      id,
      scope,
      type,
      status,
      content,
      priority: numberValue(object?.priority),
      confidence: numberValue(object?.confidence),
      tags: normalizeStringArray(object?.tags),
      ...(metadata ? { metadata } : {}),
      ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
      file: asString(object?.file),
      line: numberValue(object?.line),
      viewFile: asString(object?.view_file ?? object?.viewFile),
      viewLine,
    };
  }).filter((note): note is MemoryRecallNote => note !== null);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function providerRetryModeValue(value: unknown): AgentRunDefaults["providerRetryMode"] {
  return value === "standard" || value === "persistent" ? value : undefined;
}

function memoryEvidenceIds(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return [...new Set(value)].sort();
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const ids = new Set<string>();
  for (const source of value) {
    const object = asObject(source);
    for (const evidenceId of normalizeStringArray(object?.evidence_ids ?? object?.evidenceIds)) {
      ids.add(evidenceId);
    }
  }
  return Array.from(ids).sort();
}

function shouldLoadMemoryNotes(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return trimmed.length > 12 || /memory|remember|prefer|preference|project|decision|fix|followup|implement/i.test(trimmed);
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isAgentRole(value: unknown): value is AgentMessage["role"] {
  return value === "system" || value === "user" || value === "assistant" || value === "tool";
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
