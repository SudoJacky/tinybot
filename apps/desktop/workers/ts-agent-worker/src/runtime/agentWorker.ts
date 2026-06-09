import { AgentRunner, type AgentRunnerCheckpoint, type AgentRunnerEvent } from "../agent/agentRunner.ts";
import type { AgentMessage, AgentRunSpec } from "../agent/agentRunSpec.ts";
import type { ModelProvider } from "../model/provider.ts";
import {
  isJsonObject,
  workerError,
  WORKER_PROTOCOL_VERSION,
  type WorkerEvent,
  type WorkerRequest,
  type WorkerResponse,
} from "../protocol/messages.ts";
import type { ToolRegistry } from "../tools/toolRegistry.ts";

export type AgentWorkerOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  emitEvent: (event: WorkerEvent) => void;
};

export class AgentWorker {
  private readonly provider: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly emitEvent: (event: WorkerEvent) => void;

  constructor(options: AgentWorkerOptions) {
    this.provider = options.provider;
    this.tools = options.tools;
    this.emitEvent = options.emitEvent;
  }

  async handleRequest(request: WorkerRequest): Promise<WorkerResponse> {
    if (request.protocol_version !== WORKER_PROTOCOL_VERSION) {
      return this.failure(
        request,
        `Unsupported worker protocol version '${request.protocol_version}'.`,
        {
          actual: request.protocol_version,
          expected: WORKER_PROTOCOL_VERSION,
        },
        "incompatible_protocol_version",
      );
    }

    if (request.method !== "agent.run") {
      return this.failure(request, "unknown worker method", { method: request.method }, "invalid_protocol");
    }

    try {
      const spec = parseRunSpec(request.params);
      spec.traceId = request.trace_id;
      const runner = new AgentRunner({
        provider: this.provider,
        tools: this.tools,
        emitEvent: (event) => this.emitRunnerEvent(request.trace_id, event),
        checkpoint: (checkpoint) => this.emitCheckpoint(request.trace_id, spec.runId, checkpoint),
      });
      const result = await runner.run(spec);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.done",
        payload: {
          runId: spec.runId,
          stopReason: result.stopReason,
        },
      });
      return {
        protocol_version: WORKER_PROTOCOL_VERSION,
        id: request.id,
        trace_id: request.trace_id,
        result,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitEvent({
        protocol_version: WORKER_PROTOCOL_VERSION,
        trace_id: request.trace_id,
        event: "agent.error",
        payload: { message },
      });
      return this.failure(request, message);
    }
  }

  private failure(
    request: WorkerRequest,
    message: string,
    details: Record<string, unknown> = {},
    code: "invalid_protocol" | "incompatible_protocol_version" | "capability_denied" | "worker_error" = "worker_error",
  ): WorkerResponse {
    return {
      protocol_version: WORKER_PROTOCOL_VERSION,
      id: request.id,
      trace_id: request.trace_id,
      error: workerError(message, details, code),
    };
  }

  private emitRunnerEvent(traceId: string, event: AgentRunnerEvent): void {
    const protocolEvent = protocolEventName(event);
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: protocolEvent,
      payload: event.payload,
    });
  }

  private emitCheckpoint(traceId: string, runId: string, checkpoint: AgentRunnerCheckpoint): void {
    this.emitEvent({
      protocol_version: WORKER_PROTOCOL_VERSION,
      trace_id: traceId,
      event: "agent.checkpoint",
      payload: {
        runId,
        phase: checkpoint.phase,
        iteration: checkpoint.iteration,
        model: checkpoint.model,
        assistantMessage: checkpoint.assistantMessage,
        completedToolResults: checkpoint.completedToolResults,
        pendingToolCalls: checkpoint.pendingToolCalls,
      },
    });
  }
}

function protocolEventName(event: AgentRunnerEvent): string {
  switch (event.type) {
    case "tool_start":
      return "agent.tool.start";
    case "tool_result":
      return "agent.tool.result";
    case "content_delta":
      return "agent.delta";
    case "reasoning_delta":
      return "agent.reasoning_delta";
    case "tool_call_delta":
      return "agent.tool_call.delta";
  }
}

function parseRunSpec(params: Record<string, unknown> | undefined): AgentRunSpec {
  if (!isJsonObject(params) || !isJsonObject(params.spec)) {
    throw new Error("agent.run requires object params.spec");
  }
  const raw = params.spec;
  if (typeof raw.runId !== "string") {
    throw new Error("agent.run spec.runId must be a string");
  }
  if (!Array.isArray(raw.messages)) {
    throw new Error("agent.run spec.messages must be an array");
  }
  if (typeof raw.model !== "string") {
    throw new Error("agent.run spec.model must be a string");
  }
  if (typeof raw.maxIterations !== "number") {
    throw new Error("agent.run spec.maxIterations must be a number");
  }
  if (typeof raw.stream !== "boolean") {
    throw new Error("agent.run spec.stream must be a boolean");
  }
  return {
    runId: raw.runId,
    traceId: typeof raw.traceId === "string" ? raw.traceId : undefined,
    sessionId: typeof raw.sessionId === "string" ? raw.sessionId : undefined,
    messages: raw.messages.map(parseAgentMessage),
    model: raw.model,
    maxIterations: raw.maxIterations,
    stream: raw.stream,
    contextWindow: typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
    toolResultBudget: typeof raw.toolResultBudget === "number" ? raw.toolResultBudget : undefined,
    failOnToolError: typeof raw.failOnToolError === "boolean" ? raw.failOnToolError : undefined,
    metadata: isJsonObject(raw.metadata) ? raw.metadata : undefined,
  };
}

function parseAgentMessage(value: unknown): AgentMessage {
  if (!isJsonObject(value)) {
    throw new Error("agent.run spec.messages entries must be objects");
  }
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant" && value.role !== "tool") {
    throw new Error("agent.run message.role is invalid");
  }
  if (typeof value.content !== "string") {
    throw new Error("agent.run message.content must be a string");
  }
  return {
    role: value.role,
    content: value.content,
    toolCallId: typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
  };
}
