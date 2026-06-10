import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ModelResponse } from "./provider.ts";

export class UnconfiguredProvider implements ModelProvider {
  async complete(_messages: AgentMessage[]): Promise<ModelResponse> {
    throw new Error("model provider is not configured; OpenAI provider migration is pending");
  }
}
