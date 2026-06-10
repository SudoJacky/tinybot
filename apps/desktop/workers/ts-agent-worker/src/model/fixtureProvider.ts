import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ModelResponse } from "./provider.ts";

export class FixtureProvider implements ModelProvider {
  private readonly responses: ModelResponse[];

  constructor(responses: ModelResponse[]) {
    this.responses = responses.map((response) => ({
      ...response,
      toolCalls: response.toolCalls.map((toolCall) => ({ ...toolCall })),
    }));
  }

  async complete(_messages: AgentMessage[]): Promise<ModelResponse> {
    const response = this.responses.shift();
    if (!response) {
      throw new Error("fixture provider has no queued response");
    }
    return {
      ...response,
      toolCalls: response.toolCalls.map((toolCall) => ({ ...toolCall })),
    };
  }
}
