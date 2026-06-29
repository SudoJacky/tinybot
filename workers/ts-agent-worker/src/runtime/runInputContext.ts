import { buildContextMessages } from "../agent/contextBuilder.ts";
import type {
  AgentRunInput,
  ContextBridgeLoadResult,
  ContextBridgeMetadata,
  ContextBuildMetadata,
} from "../agent/contextTypes.ts";
import type { AgentRunSpec } from "../agent/agentRunSpec.ts";
import {
  DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_AGENT_MAX_TOKENS,
  DEFAULT_AGENT_MAX_TOOL_ITERATIONS,
  DEFAULT_AGENT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_AGENT_TEMPERATURE,
} from "../config/defaults.ts";

export type RunInputSpecProjection = {
  spec: AgentRunSpec;
  contextMetadata: ContextBuildMetadata & { bridge: ContextBridgeMetadata };
};

export function buildRunInputSpec(
  traceId: string,
  input: AgentRunInput,
  loaded: ContextBridgeLoadResult,
): RunInputSpecProjection {
  const context = buildContextMessages(loaded.input);
  const contextMetadata = {
    ...context.metadata,
    bridge: loaded.metadata,
  };
  return {
    spec: {
      runId: input.runId,
      traceId,
      sessionId: input.sessionId,
      messages: context.messages,
      model: input.model ?? loaded.runDefaults?.model ?? DEFAULT_AGENT_MODEL,
      maxIterations: input.maxIterations ?? loaded.runDefaults?.maxIterations ?? DEFAULT_AGENT_MAX_TOOL_ITERATIONS,
      stream: input.stream ?? false,
      temperature: input.temperature ?? loaded.runDefaults?.temperature ?? DEFAULT_AGENT_TEMPERATURE,
      maxTokens: input.maxTokens ?? loaded.runDefaults?.maxTokens ?? DEFAULT_AGENT_MAX_TOKENS,
      reasoningEffort: input.reasoningEffort ?? loaded.runDefaults?.reasoningEffort,
      providerRetryMode: input.providerRetryMode ?? loaded.runDefaults?.providerRetryMode,
      contextWindow: input.contextWindow ?? loaded.runDefaults?.contextWindow ?? DEFAULT_AGENT_CONTEXT_WINDOW_TOKENS,
      toolResultBudget: input.toolResultBudget ?? loaded.runDefaults?.toolResultBudget ?? DEFAULT_AGENT_MAX_TOOL_RESULT_CHARS,
      failOnToolError: input.failOnToolError,
      metadata: {
        ...(input.metadata ?? {}),
        _contextInitialMessageCount: context.messages.length,
        _contextSessionAppendMessages: context.sessionAppendMessages,
      },
    },
    contextMetadata,
  };
}
