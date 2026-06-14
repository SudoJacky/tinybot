import { describe, expect, test } from "vitest";

import { EMPTY_FINAL_RESPONSE_MESSAGE } from "../support/runtimeHelpers.ts";
import {
  handleWebuiRouteRequest,
  type WebuiConfigProvider,
  type WebuiOpenAiCompatProvider,
  type WebuiSessionProvider,
} from "./webuiRoutes.ts";

describe("WebUI OpenAI-compatible routes", () => {
  test("retries empty chat completions once before returning the Python fallback", async () => {
    const completions: Array<{ content: string; sessionKey: string; traceId: string; timeoutSeconds: number }> = [];
    const configProvider: WebuiConfigProvider = {
      getConfig: () => ({
        agents: { defaults: { model: "test-model" } },
        api: { timeout: 3 },
      }),
      patchConfig: () => ({}),
    };
    const openAiCompatProvider: WebuiOpenAiCompatProvider = {
      completeChat: (request, traceId) => {
        completions.push({
          content: request.content,
          sessionKey: request.sessionKey,
          traceId,
          timeoutSeconds: request.timeoutSeconds,
        });
        return completions.length === 1 ? "   " : "\n";
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/v1/chat/completions",
        body: {
          model: "test-model",
          session_id: "custom",
          messages: [{ role: "user", content: "hello" }],
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      configProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      openAiCompatProvider,
      undefined,
      undefined,
      "trace-openai",
    );

    expect(response.status).toBe(200);
    expect(completions).toEqual([
      { content: "hello", sessionKey: "api:custom", traceId: "trace-openai", timeoutSeconds: 3 },
      { content: "hello", sessionKey: "api:custom", traceId: "trace-openai", timeoutSeconds: 3 },
    ]);
    expect(response.body).toMatchObject({
      model: "test-model",
      choices: [
        {
          message: { role: "assistant", content: EMPTY_FINAL_RESPONSE_MESSAGE },
          finish_reason: "stop",
        },
      ],
    });
  });
});

describe("WebUI route temporary files", () => {
  test("restores task progress cards when session history only has the internal notification", async () => {
    const progressRequests: Array<{ planId: string; traceId: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      getSessionMessages: () => ({
        sessionId: "websocket:chat-1",
        messages: [
          { role: "user", content: "Start task", timestamp: "2026-06-13T08:00:00.000Z" },
          {
            role: "user",
            content: "Task plan created.\n\n**Plan ID:** plan-1",
            timestamp: "2026-06-13T08:01:00.000Z",
            _task_event: true,
          },
        ],
      }),
      getTaskProgressCard: (planId, traceId) => {
        progressRequests.push({ planId, traceId });
        return {
          role: "progress",
          content: "Task Progress: Demo plan",
          timestamp: "2026-06-13T08:02:00.000Z",
          _progress: true,
          _tool_name: "task",
          _task_event: true,
          _task_progress: { event: "restored", plan_id: planId },
          _task_plan_id: planId,
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "GET",
        path: "/api/sessions/websocket%3Achat-1/messages",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-messages",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      key: "websocket:chat-1",
      messages: [
        { role: "user", content: "Start task", timestamp: "2026-06-13T08:00:00.000Z" },
        {
          role: "progress",
          content: "Task Progress: Demo plan",
          timestamp: "2026-06-13T08:02:00.000Z",
          _progress: true,
          _tool_name: "task",
          _task_event: true,
          _task_progress: { event: "restored", plan_id: "plan-1" },
          _task_plan_id: "plan-1",
        },
      ],
    });
    expect(progressRequests).toEqual([{ planId: "plan-1", traceId: "trace-messages" }]);
  });

  test("allows temporary file upload for the configured WebUI channel prefix", async () => {
    const uploads: Array<{ sessionId: string; traceId: string; name: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "native",
      listSessions: () => [],
      uploadTemporaryFile: (sessionId, upload, traceId) => {
        uploads.push({ sessionId, traceId, name: upload.name });
        return {
          id: "session_doc_1",
          name: upload.name,
          file_type: upload.fileType,
          chunk_count: 1,
          size_bytes: upload.sizeBytes,
          temporary: true,
        };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/api/sessions/native%3Achat-1/temporary-files",
        body: { name: "notes.txt", content: "hello" },
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-temp-upload",
    );

    expect(response.status).toBe(200);
    expect(uploads).toEqual([{ sessionId: "native:chat-1", traceId: "trace-temp-upload", name: "notes.txt" }]);
  });

  test("passes empty text uploads to the temporary knowledge store for validation", async () => {
    const uploads: Array<{ sessionId: string; content: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "websocket",
      listSessions: () => [],
      uploadTemporaryFile: (sessionId, upload) => {
        uploads.push({ sessionId, content: upload.content });
        throw new Error("Uploaded file contains no extractable text");
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "POST",
        path: "/api/sessions/websocket%3Achat-1/temporary-files",
        body: { name: "blank.txt", content: "" },
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-empty-upload",
    );

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Uploaded file contains no extractable text" });
    expect(uploads).toEqual([{ sessionId: "websocket:chat-1", content: "" }]);
  });

  test("allows temporary file clearing for the configured WebUI channel prefix", async () => {
    const clears: Array<{ sessionId: string; traceId: string }> = [];
    const sessionProvider: WebuiSessionProvider = {
      channelName: "native",
      listSessions: () => [],
      clearTemporaryFiles: (sessionId, traceId) => {
        clears.push({ sessionId, traceId });
        return { sessionId, items: [], cleared: 2 };
      },
    };

    const response = await handleWebuiRouteRequest(
      {
        method: "DELETE",
        path: "/api/sessions/native%3Achat-1/temporary-files",
      },
      undefined,
      undefined,
      sessionProvider,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "trace-temp-clear",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], cleared: 2 });
    expect(clears).toEqual([{ sessionId: "native:chat-1", traceId: "trace-temp-clear" }]);
  });
});
