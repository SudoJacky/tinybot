import type { AgentMessage } from "../agent/agentRunSpec.ts";
import type { ModelProvider, ModelResponse } from "./provider.ts";

export class UnconfiguredProvider implements ModelProvider {
  private readonly message: string;

  constructor(message = "model provider is not configured; OpenAI provider migration is pending") {
    this.message = message;
  }

  async complete(_messages: AgentMessage[]): Promise<ModelResponse> {
    throw new Error(this.message);
  }
}
