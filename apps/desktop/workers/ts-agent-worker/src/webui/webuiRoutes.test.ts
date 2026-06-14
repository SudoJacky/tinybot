import { describe, expect, test } from "vitest";

import { handleWebuiRouteRequest, type WebuiSessionProvider } from "./webuiRoutes.ts";

describe("WebUI route temporary files", () => {
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
