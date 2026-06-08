import { describe, expect, test, vi } from "vitest";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import {
  checkGatewayHealth,
  createGatewayApiClient,
} from "./gatewayHttpClient";
import {
  createGatewaySocketMessage,
  flushGatewaySocketQueue,
  normalizeGatewayFrame,
  sendGatewaySocketJson,
} from "./gatewayWebSocketClient";

describe("gateway config", () => {
  test("builds default local HTTP and WebSocket endpoints", () => {
    expect(DEFAULT_GATEWAY_CONFIG.httpBaseUrl).toBe("http://127.0.0.1:18790");
    expect(DEFAULT_GATEWAY_CONFIG.wsUrl).toBe("ws://127.0.0.1:18790/ws");
  });

  test("normalizes provided URLs without duplicate slashes", () => {
    const config = resolveGatewayConfig({
      httpBaseUrl: "http://localhost:18790/",
      wsUrl: "ws://localhost:18790/ws",
      requestTimeoutMs: 250,
    });

    expect(config.httpBaseUrl).toBe("http://localhost:18790");
    expect(config.wsUrl).toBe("ws://localhost:18790/ws");
    expect(config.requestTimeoutMs).toBe(250);
  });
});

describe("gateway HTTP client", () => {
  test("reports a reachable gateway when HTTP and WebSocket checks pass", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1", ws_path: "/ws" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const webSocketProbe = vi.fn(async () => ({ ok: true as const }));

    const result = await checkGatewayHealth({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      webSocketProbe,
    });

    expect(result.state).toBe("running");
    expect(result.http.ok).toBe(true);
    expect(result.webSocket.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/webui/bootstrap",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetchFn).toHaveBeenCalledWith(
      "http://127.0.0.1:18790/api/status",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(webSocketProbe).toHaveBeenCalledWith(
      "ws://127.0.0.1:18790/ws?token=token-1",
      DEFAULT_GATEWAY_CONFIG.requestTimeoutMs,
    );
  });

  test("keeps endpoint details when the gateway is offline", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const result = await checkGatewayHealth({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      webSocketProbe: async () => ({ ok: false as const, error: "not checked" }),
    });

    expect(result.state).toBe("offline");
    expect(result.http.ok).toBe(false);
    if (!result.http.ok) {
      expect(result.http.error).toContain("ECONNREFUSED");
    }
    expect(result.httpBaseUrl).toBe(DEFAULT_GATEWAY_CONFIG.httpBaseUrl);
    expect(result.wsUrl).toBe(DEFAULT_GATEWAY_CONFIG.wsUrl);
  });

  test("constructs shared route group requests", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
    });

    await client.sessions.list();
    await client.sessions.messages("WebSocket:chat-1");
    await client.sessions.temporaryFiles("WebSocket:chat-1");
    const temporaryForm = new FormData();
    temporaryForm.append("file", new File(["temporary"], "temporary.txt", { type: "text/plain" }));
    await client.sessions.uploadTemporaryFile("WebSocket:chat-1", temporaryForm);
    await client.knowledge.documents();
    const knowledgeForm = new FormData();
    knowledgeForm.append("file", new File(["knowledge"], "knowledge.md", { type: "text/markdown" }));
    await client.knowledge.uploadDocument(knowledgeForm);
    await client.knowledge.deleteDocument("docs/knowledge.md");
    await client.knowledge.job("kjob/1");
    await client.knowledge.rebuildIndex("all");
    await client.knowledge.stats();
    await client.knowledge.graph();
    await client.knowledge.graphrag();
    await client.knowledge.query({ query: "desktop", mode: "hybrid", top_k: 5 });
    await client.workspace.file("docs/readme.md");
    await client.workspace.putFile("docs/readme.md", {
      content: "# Readme\n",
      expected_updated_at: "2026-05-31T10:00:00+00:00",
    });
    await client.cowork.summary("cowork-1");
    await client.skills.create({ name: "planner" });
    await client.skills.update("planner/phase", { content: "# Updated" });
    await client.skills.validate("planner/phase");
    await client.skills.delete("planner/phase");
    await client.cowork.sessions({ includeCompleted: true, originChatId: "chat/1" });
    await client.cowork.create({ goal: "Ship desktop" });
    await client.cowork.run("cowork/1", { run_until_idle: true });
    await client.cowork.action("cowork/1", "pause");
    await client.cowork.action("cowork/1", "resume");
    await client.cowork.action("cowork/1", "emergency-stop");
    await client.cowork.delete("cowork/1");
    await client.cowork.message("cowork/1", { content: "Continue", recipient_ids: [] });
    await client.cowork.taskAction("cowork/1", "task/1", "assign", { assigned_agent_id: "agent-1" });
    await client.cowork.workUnitAction("cowork/1", "wu/1", "retry", { reason: "retry" });
    await client.cowork.selectBranch("cowork/1", "branch/1");
    await client.cowork.selectBranchResult("cowork/1", "branch/1", { result_id: "result-1" });
    await client.cowork.mergeBranchResults("cowork/1", { branch_ids: ["a", "b"] });
    await client.cowork.validateBlueprint({ blueprint: {} }, { preview: true });

    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/sessions",
      "http://127.0.0.1:18790/api/sessions/WebSocket%3Achat-1/messages",
      "http://127.0.0.1:18790/api/sessions/WebSocket%3Achat-1/temporary-files",
      "http://127.0.0.1:18790/api/sessions/WebSocket%3Achat-1/temporary-files",
      "http://127.0.0.1:18790/v1/knowledge/documents",
      "http://127.0.0.1:18790/v1/knowledge/documents/upload?async_index=true",
      "http://127.0.0.1:18790/v1/knowledge/documents/docs%2Fknowledge.md",
      "http://127.0.0.1:18790/v1/knowledge/jobs/kjob%2F1",
      "http://127.0.0.1:18790/v1/knowledge/rebuild-index?type=all&async_index=true",
      "http://127.0.0.1:18790/v1/knowledge/stats",
      "http://127.0.0.1:18790/v1/knowledge/graph",
      "http://127.0.0.1:18790/v1/knowledge/graphrag?min_confidence=0&include_reports=true&include_covariates=true",
      "http://127.0.0.1:18790/v1/knowledge/query",
      "http://127.0.0.1:18790/api/workspace/files/docs%2Freadme.md",
      "http://127.0.0.1:18790/api/workspace/files/docs%2Freadme.md",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork-1/summary",
      "http://127.0.0.1:18790/api/skills",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase/validate",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase",
      "http://127.0.0.1:18790/api/cowork/sessions?include_completed=true&origin_chat_id=chat%2F1",
      "http://127.0.0.1:18790/api/cowork/sessions",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/run",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/pause",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/resume",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/emergency-stop",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/messages",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/tasks/task%2F1/assign",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/work-units/wu%2F1/retry",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/branches/branch%2F1/select",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/branches/branch%2F1/result/select-final",
      "http://127.0.0.1:18790/api/cowork/sessions/cowork%2F1/branch-results/merge",
      "http://127.0.0.1:18790/api/cowork/blueprints/preview",
    ]);
    expect(fetchFn.mock.calls[4][1]).toMatchObject({
      method: "POST",
      body: temporaryForm,
    });
    expect(fetchFn.mock.calls[6][1]).toMatchObject({
      method: "POST",
      body: knowledgeForm,
    });
    expect((fetchFn.mock.calls[4][1] as RequestInit).headers).not.toMatchObject({
      "Content-Type": expect.any(String),
    });
    expect((fetchFn.mock.calls[6][1] as RequestInit).headers).not.toMatchObject({
      "Content-Type": expect.any(String),
    });
    expect(fetchFn.mock.calls[7][1]).toMatchObject({
      method: "DELETE",
    });
    expect(fetchFn.mock.calls[13][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ query: "desktop", mode: "hybrid", top_k: 5 }),
    });
    expect(fetchFn.mock.calls[15][1]).toMatchObject({
      method: "PUT",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        content: "# Readme\n",
        expected_updated_at: "2026-05-31T10:00:00+00:00",
      }),
    });
    expect(fetchFn.mock.calls[18][1]).toMatchObject({
      method: "PATCH",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ content: "# Updated" }),
    });
    expect(fetchFn.mock.calls[19][1]).toMatchObject({ method: "POST" });
    expect(fetchFn.mock.calls[20][1]).toMatchObject({ method: "DELETE" });
    expect(fetchFn.mock.calls[22][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ goal: "Ship desktop" }),
    });
    expect(fetchFn.mock.calls[34][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ blueprint: {} }),
    });
    for (const call of fetchFn.mock.calls.slice(1)) {
      expect((call[1] as RequestInit).headers).toMatchObject({
        Authorization: "Bearer token-1",
      });
    }
  });

  test("constructs approval resolution requests", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
    });

    await client.tools.approveApproval("approval/1", {
      session_key: "WebSocket:chat-1",
      scope: "session",
      auto_retry: true,
    });
    await client.tools.denyApproval("approval/1", {
      session_key: "WebSocket:chat-1",
      auto_retry: true,
    });

    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/approvals/approval%2F1/approve",
      "http://127.0.0.1:18790/api/approvals/approval%2F1/deny",
    ]);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        session_key: "WebSocket:chat-1",
        scope: "session",
        auto_retry: true,
      }),
    });
    expect(fetchFn.mock.calls[2][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        session_key: "WebSocket:chat-1",
        auto_retry: true,
      }),
    });
  });

  test("refreshes the gateway token before authenticated requests when the session is near expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T10:00:00.000Z"));
    try {
      const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        if (path === "/webui/bootstrap") {
          return new Response(
            JSON.stringify({
              token: "token-1",
              refresh_token_path: "/webui/refresh-token",
              token_ttl_s: 300,
            }),
            { status: 200 },
          );
        }
        if (path === "/webui/refresh-token") {
          expect(init).toMatchObject({
            method: "POST",
            headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
          });
          return new Response(
            JSON.stringify({
              token: "token-1",
              refresh_token_path: "/webui/refresh-token",
              token_ttl_s: 300,
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      });
      const client = createGatewayApiClient({
        config: DEFAULT_GATEWAY_CONFIG,
        fetchFn,
      });

      await client.sessions.list();
      vi.setSystemTime(new Date("2026-06-08T10:04:15.000Z"));
      await client.sessions.list();

      expect(fetchFn.mock.calls.map((call) => String(call[0]))).toEqual([
        "http://127.0.0.1:18790/webui/bootstrap",
        "http://127.0.0.1:18790/api/sessions",
        "http://127.0.0.1:18790/webui/refresh-token",
        "http://127.0.0.1:18790/api/sessions",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("bootstraps a fresh token and retries once when an authenticated request receives 401", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/webui/bootstrap") {
        const token = fetchFn.mock.calls.filter((call) => String(call[0]).endsWith("/webui/bootstrap")).length;
        return new Response(JSON.stringify({ token: `token-${token}`, token_ttl_s: 300 }), { status: 200 });
      }
      if (path === "/api/sessions") {
        const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (authorization === "Bearer token-1") {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
    });

    await expect(client.sessions.list()).resolves.toEqual({ items: [] });

    expect(fetchFn.mock.calls.map((call) => String(call[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/sessions",
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/sessions",
    ]);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer token-1" }),
    });
    expect(fetchFn.mock.calls[3][1]).toMatchObject({
      headers: expect.objectContaining({ Authorization: "Bearer token-2" }),
    });
  });
});

describe("gateway WebSocket client", () => {
  test("creates outbound chat control messages", () => {
    expect(createGatewaySocketMessage.newChat()).toEqual({ type: "new_chat" });
    expect(createGatewaySocketMessage.attach("chat-1")).toEqual({
      type: "attach",
      chat_id: "chat-1",
    });
    expect(createGatewaySocketMessage.message("chat-1", "hello", true)).toEqual({
      type: "message",
      chat_id: "chat-1",
      content: "hello",
      use_persistent_rag: true,
    });
    expect(createGatewaySocketMessage.interrupt("chat-1")).toEqual({
      type: "interrupt",
      chat_id: "chat-1",
    });
  });

  test("queues outbound messages until the socket is open", () => {
    const sent: string[] = [];
    const queue: unknown[] = [];
    const connectingSocket = {
      readyState: 0,
      send: (value: string) => sent.push(value),
    };
    const openSocket = {
      readyState: 1,
      send: (value: string) => sent.push(value),
    };

    expect(sendGatewaySocketJson(connectingSocket, { type: "new_chat" }, queue)).toBe("queued");
    expect(sent).toEqual([]);
    expect(queue).toEqual([{ type: "new_chat" }]);

    expect(flushGatewaySocketQueue(openSocket, queue)).toBe(1);
    expect(sent).toEqual([JSON.stringify({ type: "new_chat" })]);
    expect(queue).toEqual([]);
  });

  test("normalizes stream, browser, and agent-ui frames", () => {
    expect(normalizeGatewayFrame({ event: "attached", chat_id: "chat-1" })).toMatchObject({
      kind: "attached",
      chatId: "chat-1",
    });
    expect(normalizeGatewayFrame({ event: "delta", text: "hi", message_id: "m1" })).toMatchObject({
      kind: "message.delta",
      text: "hi",
      messageId: "m1",
    });
    expect(normalizeGatewayFrame({ event: "delta", text: "plan", is_reasoning: true })).toMatchObject({
      kind: "message.delta",
      reasoning: true,
    });
    expect(normalizeGatewayFrame({ event: "message", text: "done", message_id: "m2" })).toMatchObject({
      kind: "message.completed",
      text: "done",
      messageId: "m2",
    });
    expect(normalizeGatewayFrame({ event: "stream_end", chat_id: "chat-1" })).toMatchObject({
      kind: "message.stream.completed",
      chatId: "chat-1",
    });
    expect(normalizeGatewayFrame({ event: "usage", chat_id: "chat-1", usage: { total_tokens: 16384 } })).toMatchObject({
      kind: "usage",
      chatId: "chat-1",
      tokenUsage: "-",
    });
    expect(
      normalizeGatewayFrame({
        event: "usage",
        chat_id: "chat-1",
        usage: { total_tokens: 16384, context_window_tokens: 65536 },
      }),
    ).toMatchObject({
      kind: "usage",
      chatId: "chat-1",
      tokenUsage: "25%",
    });
    expect(normalizeGatewayFrame({ event: "browser_frame", image: "data:image/png;base64,x" })).toMatchObject({
      kind: "browser.frame",
    });
    expect(normalizeGatewayFrame({ event: "agent_ui_form", form: { form_id: "form-1" } })).toMatchObject({
      kind: "agent-ui.form",
    });
    expect(
      normalizeGatewayFrame({
        event: "agent_ui_event",
        agent_ui_event: { event_type: "ui.form.requested", payload: { form_id: "form-1" } },
      }),
    ).toMatchObject({
      kind: "agent-ui.event",
      eventType: "ui.form.requested",
    });
    expect(
      normalizeGatewayFrame({
        event: "agent_ui_event",
        chat_id: "chat-1",
        agent_ui_event: {
          event_type: "message.delta",
          chat_id: "chat-1",
          message_id: "m3",
          payload: { text: "streamed" },
        },
      }),
    ).toMatchObject({
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "m3",
      text: "streamed",
      reasoning: false,
    });
    expect(
      normalizeGatewayFrame({
        event: "agent_ui_event",
        chat_id: "chat-1",
        agent_ui_event: {
          event_type: "usage.updated",
          payload: { usage: { total_tokens: 32768, context_window_tokens: 65536 } },
        },
      }),
    ).toMatchObject({
      kind: "usage",
      chatId: "chat-1",
      tokenUsage: "50%",
    });

    expect(
      normalizeGatewayFrame({
        event: "cowork_stream",
        chat_id: "chat-1",
        session_id: "session-1",
        agent_id: "agent-1",
        step_id: "step-1",
        phase: "delta",
        status: "running",
        sequence: 3,
        text: "live answer",
        completed: false,
      }),
    ).toMatchObject({
      kind: "message.delta",
      chatId: "chat-1",
      messageId: "cowork:session-1:agent-1:step-1",
      text: "live answer",
      reasoning: false,
    });

    expect(
      normalizeGatewayFrame({
        event: "cowork_mailbox_stream",
        chat_id: "chat-1",
        session_id: "session-1",
        draft_id: "draft-1",
        tool_call_id: "call-1",
        phase: "terminal",
        status: "completed",
        completed: true,
      }),
    ).toMatchObject({
      kind: "message.stream.completed",
      chatId: "chat-1",
      messageId: "cowork-mailbox:draft-1",
    });
  });
});
