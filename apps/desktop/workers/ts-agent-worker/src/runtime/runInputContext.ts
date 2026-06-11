import { buildContextMessages } from "../agent/contextBuilder.ts";
import type {
  AgentRunInput,
  ContextBridgeLoadResult,
  ContextBridgeMetadata,
  ContextBuildMetadata,
} from "../agent/contextTypes.ts";
import type { AgentRunSpec } from "../agent/agentRunSpec.ts";

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
      model: input.model ?? "gpt-4.1-mini",
      maxIterations: input.maxIterations ?? 2,
      stream: input.stream ?? false,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      reasoningEffort: input.reasoningEffort,
      providerRetryMode: input.providerRetryMode,
      contextWindow: input.contextWindow,
      toolResultBudget: input.toolResultBudget,
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
