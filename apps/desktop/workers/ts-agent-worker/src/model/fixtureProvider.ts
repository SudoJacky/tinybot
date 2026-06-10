import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ModelRequestOptions, ModelResponse } from "./provider.ts";

export class FixtureProvider implements ModelProvider {
  private readonly responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.responses = responses.map((response) => ({
      ...response,
      toolCalls: response.toolCalls.map((toolCall) => ({ ...toolCall })),
    }));
  }

  async complete(_messages: AgentMessage[], options: ModelRequestOptions = {}): Promise<ModelResponse> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("fixture provider has no queued response");
    }
    if (response.content) {
      options.onContentDelta?.(response.content);
    }
    response.toolCalls.forEach((toolCall, index) => {
      options.onToolCallDelta?.({
        index,
        deltaText: toolCall.argumentsJson,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
      });
    });
    return {
      ...response,
      toolCalls: response.toolCalls.map((toolCall) => ({ ...toolCall })),
    };
  }
}
