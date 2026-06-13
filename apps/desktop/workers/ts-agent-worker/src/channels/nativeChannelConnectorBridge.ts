import type { NativeRpcClient } from "../tools/nativeToolProxy.ts";
import type { NativeTextChannelConnector, NativeTextChannelSendTextInput } from "./nativeTextChannel.ts";
import type { NativeTextChannelConnectorRegistry } from "./nativeChannelFactory.ts";

export type NativeChannelConnectorBridgeOptions = {
  rpcClient: NativeRpcClient;
  channels: string[];
};

export function createNativeChannelConnectorBridgeRegistry(
  options: NativeChannelConnectorBridgeOptions,
): NativeTextChannelConnectorRegistry {
  return Object.fromEntries(
    options.channels.map((channel) => [
      channel,
      createNativeChannelConnectorBridge(channel, options.rpcClient),
    ]),
  );
}

function createNativeChannelConnectorBridge(
  channel: string,
  rpcClient: NativeRpcClient,
): NativeTextChannelConnector {
  return {
    start: () => sendConnectorRequest(rpcClient, traceId(channel, "start"), "channel.connector.start", { channel }),
    stop: () => sendConnectorRequest(rpcClient, traceId(channel, "stop"), "channel.connector.stop", { channel }),
    sendText: (input) => sendConnectorRequest(rpcClient, traceId(channel, "send_text"), "channel.connector.send_text", textParams(input)),
    sendDelta: (chatId, delta, metadata) => sendConnectorRequest(rpcClient, traceId(channel, "send_delta"), "channel.connector.send_delta", {
      channel,
      chat_id: chatId,
      delta,
      metadata,
    }),
    sendUsage: (chatId, usage) => sendConnectorRequest(rpcClient, traceId(channel, "send_usage"), "channel.connector.send_usage", {
      channel,
      chat_id: chatId,
      usage,
    }),
  };
}

async function sendConnectorRequest(
  rpcClient: NativeRpcClient,
  traceId: string,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  const result = await rpcClient.request(traceId, method, params);
  rejectUnhandledConnectorResult(result, params, operationFromMethod(method));
}

function textParams(input: NativeTextChannelSendTextInput): Record<string, unknown> {
  return {
    channel: input.channel,
    chat_id: input.chatId,
    content: input.content,
    media: input.media,
    metadata: input.metadata,
    reply_to: input.replyTo ?? null,
  };
}

function traceId(channel: string, operation: string): string {
  return `channel.connector.${channel}.${operation}`;
}

function rejectUnhandledConnectorResult(
  result: unknown,
  params: Record<string, unknown>,
  operation: string,
): void {
  if (!isRecord(result) || result.handled !== false) {
    return;
  }
  const channel = typeof result.channel === "string"
    ? result.channel
    : typeof params.channel === "string"
      ? params.channel
      : "unknown";
  const reason = typeof result.reason === "string" && result.reason.length > 0
    ? result.reason
    : "unhandled";
  throw new Error(`native connector ${channel} ${operation} unavailable: ${reason}`);
}

function operationFromMethod(method: string): string {
  return method.replace(/^channel\.connector\./, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
