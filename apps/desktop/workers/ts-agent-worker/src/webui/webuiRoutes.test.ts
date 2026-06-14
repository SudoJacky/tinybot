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
