import { isJsonObject } from "../protocol/messages.ts";

export type ClientWebSocketFrameRequest = {
  clientId: string;
  frame: Record<string, unknown>;
  attachedChatId?: string;
  sessionExists?: boolean;
  editablePaths?: string[];
  createChatId?: () => string;
};

export type ClientWebSocketFrameResult = {
  kind: string;
  frames: Array<Record<string, unknown>>;
  chatId?: string;
  sessionId?: string;
  attachedChatId?: string;
  path?: string;
  inbound?: {
    channel: "websocket";
    sender_id: string;
    chat_id: string;
    content: string;
    metadata: Record<string, unknown>;
    session_key: string;
  };
};

export function handleClientWebSocketFrame(request: ClientWebSocketFrameRequest): ClientWebSocketFrameResult {
  const frame = request.frame;
  const type = stringValue(frame.type);
  if (type === "new_chat") {
    const chatId = (request.createChatId ?? generatedChatId)();
    return {
      kind: "new_chat",
      chatId,
      sessionId: websocketSessionId(chatId),
      attachedChatId: chatId,
      frames: [{ event: "chat_created", chat_id: chatId }],
    };
  }

  if (type === "attach") {
    const chatId = trimmedString(frame.chat_id ?? frame.chatId);
    if (!chatId) {
      return errorResult({ event: "error", message: "chat_id is required" });
    }
    if (request.sessionExists === false) {
      return errorResult({ event: "error", message: "session not found", chat_id: chatId });
    }
    return {
      kind: "attach",
      chatId,
      sessionId: websocketSessionId(chatId),
      attachedChatId: chatId,
      frames: [{ event: "attached", chat_id: chatId }],
    };
  }

  if (type === "message") {
    const chatId = trimmedString(frame.chat_id ?? frame.chatId);
    const content = trimmedString(frame.content);
    if (!chatId || !content) {
      return errorResult({ event: "error", message: "chat_id and content are required" });
    }
    if (request.attachedChatId !== chatId) {
      return errorResult({ event: "error", message: "chat is not attached", chat_id: chatId });
    }
    const metadata: Record<string, unknown> = {};
    if (typeof frame.use_persistent_rag === "boolean") {
      metadata._use_persistent_rag = frame.use_persistent_rag;
    }
    return {
      kind: "message",
      chatId,
      sessionId: websocketSessionId(chatId),
      inbound: {
        channel: "websocket",
        sender_id: request.clientId,
        chat_id: chatId,
        content,
        metadata,
        session_key: websocketSessionId(chatId),
      },
      frames: [],
    };
  }

  if (type === "interrupt") {
    const chatId = trimmedString(frame.chat_id ?? frame.chatId);
    if (!chatId) {
      return errorResult({ event: "error", message: "chat_id is required" });
    }
    return {
      kind: "interrupt",
      chatId,
      sessionId: websocketSessionId(chatId),
      frames: [],
    };
  }

  if (type === "ping") {
    return {
      kind: "ping",
      frames: [{ event: "pong" }],
    };
  }

  if (type === "subscribe_file") {
    const path = trimmedString(frame.path);
    if (!request.editablePaths?.includes(path)) {
      return errorResult({ event: "error", message: "file is not editable", path });
    }
    return {
      kind: "subscribe_file",
      path,
      frames: [{ event: "file_subscribed", path }],
    };
  }

  if (type === "unsubscribe_file") {
    const path = trimmedString(frame.path);
    return {
      kind: "unsubscribe_file",
      path,
      frames: [{ event: "file_unsubscribed", path }],
    };
  }

  return errorResult({ event: "error", message: `unsupported event type: ${type}` });
}

export function parseClientWebSocketFrameRequest(
  params: Record<string, unknown> | undefined,
): ClientWebSocketFrameRequest {
  if (!isJsonObject(params)) {
    throw new Error("transport.websocket_message requires object params");
  }
  const clientId = stringParam(params, "clientId", "client_id");
  if (!clientId) {
    throw new Error("transport.websocket_message requires params.client_id");
  }
  const frame = isJsonObject(params.frame) ? params.frame : undefined;
  if (!frame) {
    throw new Error("transport.websocket_message requires params.frame");
  }
  return {
    clientId,
    frame,
    attachedChatId: stringParam(params, "attachedChatId", "attached_chat_id"),
    sessionExists: typeof params.sessionExists === "boolean"
      ? params.sessionExists
      : typeof params.session_exists === "boolean"
        ? params.session_exists
        : undefined,
    editablePaths: stringArrayParam(params.editablePaths ?? params.editable_paths),
  };
}

function errorResult(frame: Record<string, unknown>): ClientWebSocketFrameResult {
  return {
    kind: "error",
    frames: [frame],
  };
}

function websocketSessionId(chatId: string): string {
  return `websocket:${chatId}`;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringParam(params: Record<string, unknown>, camelKey: string, snakeKey: string): string | undefined {
  const value = params[camelKey] ?? params[snakeKey];
  return typeof value === "string" && value ? value : undefined;
}

function stringArrayParam(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function generatedChatId(): string {
  return Math.random().toString(16).slice(2, 14).padEnd(12, "0");
}
