import { describe, expect, test, vi } from "vitest";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import {
  checkGatewayHealth,
  createGatewayApiClient,
  resolveTsCoworkRuntimeRollout,
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

  test("resolves TS Cowork runtime rollout from desktop config with TS-first defaults", () => {
    expect(resolveTsCoworkRuntimeRollout({})).toEqual({
      enabled: true,
      readOnlySnapshot: true,
      mutations: true,
      scheduler: true,
      swarm: true,
      fallbackToPython: false,
    });

    expect(resolveTsCoworkRuntimeRollout({
      desktop: {
        ts_cowork_runtime: {
          enabled: true,
          read_only_snapshot: true,
          mutations: true,
          scheduler: true,
          fallback_to_python: false,
        },
      },
    })).toEqual({
      enabled: true,
      readOnlySnapshot: true,
      mutations: true,
      scheduler: true,
      swarm: true,
      fallbackToPython: false,
    });

    expect(resolveTsCoworkRuntimeRollout({
      desktop: {
        tsCoworkRuntime: {
          enabled: false,
          scheduler: false,
        },
      },
    })).toMatchObject({
      enabled: false,
      scheduler: false,
      fallbackToPython: false,
    });
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
    await client.sessions.clearTemporaryFiles("WebSocket:chat-1");
    await client.knowledge.documents();
    const knowledgeForm = new FormData();
    knowledgeForm.append("file", new File(["knowledge"], "knowledge.md", { type: "text/markdown" }));
    await client.knowledge.addDocument({ name: "Inline Knowledge", content: "Notes", file_type: "md" });
    await client.knowledge.document("docs/knowledge.md");
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
    await client.openAi.health();
    await client.openAi.models();
    await client.openAi.chatCompletions({
      model: "tinybot",
      messages: [{ role: "user", content: "hello" }],
      session_id: "desktop-chat",
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
      "http://127.0.0.1:18790/api/sessions/WebSocket%3Achat-1/temporary-files",
      "http://127.0.0.1:18790/v1/knowledge/documents",
      "http://127.0.0.1:18790/v1/knowledge/documents",
      "http://127.0.0.1:18790/v1/knowledge/documents/docs%2Fknowledge.md",
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
      "http://127.0.0.1:18790/health",
      "http://127.0.0.1:18790/v1/models",
      "http://127.0.0.1:18790/v1/chat/completions",
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
    expect(fetchFn.mock.calls[5][1]).toMatchObject({
      method: "DELETE",
    });
    expect(fetchFn.mock.calls[7][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ name: "Inline Knowledge", content: "Notes", file_type: "md" }),
    });
    expect(fetchFn.mock.calls[9][1]).toMatchObject({
      method: "POST",
      body: knowledgeForm,
    });
    expect((fetchFn.mock.calls[4][1] as RequestInit).headers).not.toMatchObject({
      "Content-Type": expect.any(String),
    });
    expect((fetchFn.mock.calls[9][1] as RequestInit).headers).not.toMatchObject({
      "Content-Type": expect.any(String),
    });
    expect(fetchFn.mock.calls[10][1]).toMatchObject({
      method: "DELETE",
    });
    expect(fetchFn.mock.calls[16][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ query: "desktop", mode: "hybrid", top_k: 5 }),
    });
    expect(fetchFn.mock.calls[18][1]).toMatchObject({
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
    expect(fetchFn.mock.calls[21][1]).toMatchObject({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        model: "tinybot",
        messages: [{ role: "user", content: "hello" }],
        session_id: "desktop-chat",
      }),
    });
    expect(fetchFn.mock.calls[24][1]).toMatchObject({
      method: "PATCH",
      headers: expect.objectContaining({
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ content: "# Updated" }),
    });
    expect(fetchFn.mock.calls[25][1]).toMatchObject({ method: "POST" });
    expect(fetchFn.mock.calls[26][1]).toMatchObject({ method: "DELETE" });
    expect(fetchFn.mock.calls[28][1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ goal: "Ship desktop" }),
    });
    expect(fetchFn.mock.calls[40][1]).toMatchObject({
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

  test("prefers native skills operations when available", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const nativeSkills = {
      list: vi.fn(async () => ({ skills: [{ name: "planner" }] })),
      detail: vi.fn(async (name: string) => ({ name, content: "Plan." })),
      create: vi.fn(async (body: unknown) => ({ created: true, body })),
      update: vi.fn(async (name: string, body: unknown) => ({ updated: true, name, body })),
      delete: vi.fn(async (name: string) => ({ deleted: true, name })),
      validate: vi.fn(async (name: string) => ({ name, valid: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeSkills,
    });

    await expect(client.skills.list()).resolves.toEqual({ skills: [{ name: "planner" }] });
    await expect(client.skills.detail("planner/phase")).resolves.toEqual({ name: "planner/phase", content: "Plan." });
    await expect(client.skills.create({ name: "planner" })).resolves.toEqual({ created: true, body: { name: "planner" } });
    await expect(client.skills.update("planner/phase", { content: "# Updated" })).resolves.toEqual({
      updated: true,
      name: "planner/phase",
      body: { content: "# Updated" },
    });
    await expect(client.skills.delete("planner/phase")).resolves.toEqual({ deleted: true, name: "planner/phase" });
    await expect(client.skills.validate("planner/phase")).resolves.toEqual({ name: "planner/phase", valid: true });

    expect(nativeSkills.list).toHaveBeenCalledTimes(1);
    expect(nativeSkills.detail).toHaveBeenCalledWith("planner/phase");
    expect(nativeSkills.create).toHaveBeenCalledWith({ name: "planner" });
    expect(nativeSkills.update).toHaveBeenCalledWith("planner/phase", { content: "# Updated" });
    expect(nativeSkills.delete).toHaveBeenCalledWith("planner/phase");
    expect(nativeSkills.validate).toHaveBeenCalledWith("planner/phase");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI status route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        channels: { websocket: { enabled: true, running: true } },
        provider: null,
        model: null,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.runtime.status()).resolves.toMatchObject({
      channels: { websocket: { enabled: true, running: true } },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/status" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI tools route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        tools: [{ name: "shell", description: "Run commands" }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.tools.list()).resolves.toEqual({
      tools: [{ name: "shell", description: "Run commands" }],
      request: { method: "GET", path: "/api/tools" },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/tools" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI config routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => request.method === "PATCH"
        ? {
            config: { agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } } },
            request,
          }
        : {
            agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
            request,
          }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.config.get()).resolves.toEqual({
      agents: { defaults: { provider: "dashscope", model: "qwen-max" } },
      request: { method: "GET", path: "/api/config" },
    });
    await expect(client.config.patch({
      agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } },
    })).resolves.toEqual({
      config: { agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } } },
      request: {
        method: "PATCH",
        path: "/api/config",
        body: { agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } } },
      },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/config" });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/api/config",
      body: { agents: { defaults: { provider: "openrouter", model: "openai/gpt-4o-mini" } } },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI providers route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        providers: [{ id: "dashscope", displayName: "DashScope", status: "ready" }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.config.providers()).resolves.toEqual({
      providers: [{ id: "dashscope", displayName: "DashScope", status: "ready" }],
      request: { method: "GET", path: "/api/providers" },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/providers" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI provider models route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        ok: true,
        models: ["qwen-max"],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.config.providerModels({
      provider: "dashscope",
      refresh_live: true,
    })).resolves.toEqual({
      ok: true,
      models: ["qwen-max"],
      request: {
        method: "POST",
        path: "/api/provider-models",
        body: { provider: "dashscope", refresh_live: true },
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI approvals route when session key is provided", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        session_key: "websocket:chat-1",
        approvals: [{ id: "approval-1", summary: "Run risky command" }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.tools.approvals({ sessionKey: "websocket:chat-1" })).resolves.toEqual({
      session_key: "websocket:chat-1",
      approvals: [{ id: "approval-1", summary: "Run risky command" }],
      request: { method: "GET", path: "/api/approvals?session_key=websocket%3Achat-1" },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/approvals?session_key=websocket%3Achat-1",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI approval resolution routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        ok: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.tools.approveApproval("approval/1", {
      session_key: "websocket:chat-1",
      scope: "session",
      auto_retry: false,
    })).resolves.toEqual({
      ok: true,
      request: {
        method: "POST",
        path: "/api/approvals/approval%2F1/approve",
        body: { session_key: "websocket:chat-1", scope: "session", auto_retry: false },
      },
    });
    await expect(client.tools.denyApproval("approval/1", {
      session_key: "websocket:chat-1",
    })).resolves.toEqual({
      ok: true,
      request: {
        method: "POST",
        path: "/api/approvals/approval%2F1/deny",
        body: { session_key: "websocket:chat-1" },
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session list route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Native session" }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.list()).resolves.toMatchObject({
      items: [{ key: "websocket:chat-1", chat_id: "chat-1", title: "Native session" }],
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/sessions" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session messages route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        key: "websocket:chat-1",
        messages: [{ role: "user", content: "Native history" }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.messages("websocket:chat-1")).resolves.toMatchObject({
      key: "websocket:chat-1",
      messages: [{ role: "user", content: "Native history" }],
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/messages",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session clear route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        key: "websocket:chat-1",
        cleared: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.clear("websocket:chat-1")).resolves.toMatchObject({
      key: "websocket:chat-1",
      cleared: true,
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/sessions/websocket%3Achat-1/clear",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session delete route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        key: "websocket:chat-1",
        deleted: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.delete("websocket:chat-1")).resolves.toMatchObject({
      key: "websocket:chat-1",
      deleted: true,
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/api/sessions/websocket%3Achat-1",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session profile route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        key: "websocket:chat-1",
        profile: { display_name: "Ada" },
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.profile("websocket:chat-1")).resolves.toMatchObject({
      key: "websocket:chat-1",
      profile: { display_name: "Ada" },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/profile",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session patch route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        key: "websocket:chat-1",
        metadata: { pinned: true },
        updated_at: "2026-06-13T10:00:00.000Z",
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.patch("websocket:chat-1", { metadata: { pinned: true } })).resolves.toMatchObject({
      key: "websocket:chat-1",
      metadata: { pinned: true },
      updated_at: "2026-06-13T10:00:00.000Z",
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/api/sessions/websocket%3Achat-1",
      body: { metadata: { pinned: true } },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session temporary files route when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        items: [{ id: "tmp-1", name: "context.md", file_type: "md", temporary: true }],
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.temporaryFiles("websocket:chat-1")).resolves.toMatchObject({
      items: [{ id: "tmp-1", name: "context.md", file_type: "md", temporary: true }],
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session temporary file upload when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        id: "session_doc_1",
        name: "context.md",
        file_type: "md",
        temporary: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });
    const form = new FormData();
    form.append("file", new File(["hello native"], "context.md", { type: "text/markdown" }));

    await expect(client.sessions.uploadTemporaryFile("websocket:chat-1", form)).resolves.toMatchObject({
      id: "session_doc_1",
      name: "context.md",
      file_type: "md",
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
      body: {
        name: "context.md",
        file_type: "md",
        content: "hello native",
        size_bytes: 12,
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI session temporary file clear when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string }) => ({
        items: [],
        cleared: 2,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.sessions.clearTemporaryFiles("websocket:chat-1")).resolves.toMatchObject({
      items: [],
      cleared: 2,
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/api/sessions/websocket%3Achat-1/temporary-files",
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI skills read routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const nativeSkills = {
      list: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
      detail: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
      validate: vi.fn(async () => ({})),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
      nativeSkills,
    });

    await expect(client.skills.list()).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/api/skills" },
    });
    await expect(client.skills.detail("planner/phase")).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/api/skills/planner%2Fphase" },
    });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/skills" });
    expect(nativeWebui.route).toHaveBeenCalledWith({ method: "GET", path: "/api/skills/planner%2Fphase" });
    expect(nativeSkills.list).not.toHaveBeenCalled();
    expect(nativeSkills.detail).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI skills mutation routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const nativeSkills = {
      list: vi.fn(async () => ({})),
      detail: vi.fn(async () => ({})),
      create: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
      update: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
      delete: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
      validate: vi.fn(async () => {
        throw new Error("legacy native skills should not be used");
      }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
      nativeSkills,
    });

    await expect(client.skills.create({ name: "planner", content: "Plan." })).resolves.toEqual({
      native: true,
      request: { method: "POST", path: "/api/skills", body: { name: "planner", content: "Plan." } },
    });
    await expect(client.skills.update("planner/phase", { content: "Updated." })).resolves.toEqual({
      native: true,
      request: { method: "PATCH", path: "/api/skills/planner%2Fphase", body: { content: "Updated." } },
    });
    await expect(client.skills.delete("planner/phase")).resolves.toEqual({
      native: true,
      request: { method: "DELETE", path: "/api/skills/planner%2Fphase" },
    });
    await expect(client.skills.validate("planner/phase")).resolves.toEqual({
      native: true,
      request: { method: "POST", path: "/api/skills/planner%2Fphase/validate" },
    });
    expect(nativeSkills.create).not.toHaveBeenCalled();
    expect(nativeSkills.update).not.toHaveBeenCalled();
    expect(nativeSkills.delete).not.toHaveBeenCalled();
    expect(nativeSkills.validate).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI Agent UI form routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.agentUi.submitForm("travel/plan", {
      correlation: { session_key: "websocket:chat-1" },
      values: { destination: "Paris" },
    })).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/api/agent-ui/forms/travel%2Fplan/submit",
        body: {
          correlation: { session_key: "websocket:chat-1" },
          values: { destination: "Paris" },
        },
      },
    });
    await expect(client.agentUi.cancelForm("travel/plan", {
      correlation: { session_key: "websocket:chat-1" },
    })).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/api/agent-ui/forms/travel%2Fplan/cancel",
        body: { correlation: { session_key: "websocket:chat-1" } },
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI workspace file routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.workspace.files()).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/api/workspace/files" },
    });
    await expect(client.workspace.file("docs/readme.md")).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/api/workspace/files/docs%2Freadme.md" },
    });
    await expect(client.workspace.putFile("docs/readme.md", {
      content: "# Readme\n",
      expected_updated_at: null,
    })).resolves.toEqual({
      native: true,
      request: {
        method: "PUT",
        path: "/api/workspace/files/docs%2Freadme.md",
        body: {
          content: "# Readme\n",
          expected_updated_at: null,
        },
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI OpenAI-compatible routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });
    const body = {
      model: "tinybot",
      messages: [{ role: "user", content: "hello" }],
      session_id: "desktop-chat",
    };

    await expect(client.openAi.health()).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/health" },
    });
    await expect(client.openAi.models()).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/v1/models" },
    });
    await expect(client.openAi.chatCompletions(body)).resolves.toEqual({
      native: true,
      request: { method: "POST", path: "/v1/chat/completions", body },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("prefers native WebUI Knowledge API routes when available", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeWebui = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });

    await expect(client.knowledge.documents({ category: "docs", limit: 10 })).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/v1/knowledge/documents?category=docs&limit=10" },
    });
    await expect(client.knowledge.addDocument({ name: "Inline Knowledge", content: "Notes", file_type: "md" })).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/documents",
        body: { name: "Inline Knowledge", content: "Notes", file_type: "md" },
      },
    });
    await expect(client.knowledge.document("docs/knowledge.md")).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/v1/knowledge/documents/docs%2Fknowledge.md" },
    });
    await expect(client.knowledge.deleteDocument("docs/knowledge.md")).resolves.toEqual({
      native: true,
      request: { method: "DELETE", path: "/v1/knowledge/documents/docs%2Fknowledge.md" },
    });
    await expect(client.knowledge.stats()).resolves.toEqual({
      native: true,
      request: { method: "GET", path: "/v1/knowledge/stats" },
    });
    await expect(client.knowledge.query({ query: "desktop", mode: "sparse", top_k: 5 })).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/query",
        body: { query: "desktop", mode: "sparse", top_k: 5 },
      },
    });
    const form = new FormData();
    form.append("file", new File(["# Native\n"], "native.md", { type: "text/markdown" }));
    form.append("category", "docs");
    form.append("tags", "desktop, native");
    await expect(client.knowledge.uploadDocument(form)).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/documents/upload?async_index=true",
        body: {
          name: "native.md",
          file_type: "md",
          content: "# Native\n",
          size_bytes: 9,
          category: "docs",
          tags: ["desktop", "native"],
        },
      },
    });
    const jsonForm = new FormData();
    jsonForm.append("file", new File(["{\"topic\":\"desktop\"}\n"], "native.json", { type: "application/json" }));
    await expect(client.knowledge.uploadDocument(jsonForm)).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/documents/upload?async_index=true",
        body: {
          name: "native.json",
          file_type: "json",
          content: "{\"topic\":\"desktop\"}\n",
          size_bytes: 20,
        },
      },
    });
    const csvForm = new FormData();
    csvForm.append("file", new File(["name,value\nnative,true\n"], "native.csv", { type: "text/csv" }));
    await expect(client.knowledge.uploadDocument(csvForm)).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/documents/upload?async_index=true",
        body: {
          name: "native.csv",
          file_type: "csv",
          content: "name,value\nnative,true\n",
          size_bytes: 23,
        },
      },
    });
    await expect(client.knowledge.job("kjob_doc-2")).resolves.toEqual({
      native: true,
      request: {
        method: "GET",
        path: "/v1/knowledge/jobs/kjob_doc-2",
      },
    });
    await expect(client.knowledge.rebuildIndex("bm25")).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/rebuild-index?type=bm25&async_index=true",
      },
    });
    await expect(client.knowledge.rebuildIndex("all")).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/rebuild-index?type=all&async_index=true",
      },
    });
    await expect(client.knowledge.rebuildIndex("semantic")).resolves.toEqual({
      native: true,
      request: {
        method: "POST",
        path: "/v1/knowledge/rebuild-index?type=semantic&async_index=true",
      },
    });
    await expect(client.knowledge.graph()).resolves.toEqual({
      native: true,
      request: {
        method: "GET",
        path: "/v1/knowledge/graph",
      },
    });
    await expect(client.knowledge.graphrag()).resolves.toEqual({
      native: true,
      request: {
        method: "GET",
        path: "/v1/knowledge/graphrag?min_confidence=0&include_reports=true&include_covariates=true",
      },
    });
    await expect(client.knowledge.graphrag({
      docId: "docs/knowledge.md",
      minConfidence: 0.2,
      level: 1,
      includeReports: false,
      includeCovariates: true,
    })).resolves.toEqual({
      native: true,
      request: {
        method: "GET",
        path: "/v1/knowledge/graphrag?doc_id=docs%2Fknowledge.md&min_confidence=0.2&level=1&include_reports=false&include_covariates=true",
      },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("keeps unsupported Knowledge uploads on the HTTP gateway fallback", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeWebui = {
      route: vi.fn(async () => {
        throw new Error("pdf upload should not use native route");
      }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeWebui,
    });
    const form = new FormData();
    form.append("file", new File(["%PDF-1.4"], "paper.pdf", { type: "application/pdf" }));

    await expect(client.knowledge.uploadDocument(form)).resolves.toEqual({ gateway: true });
    expect(nativeWebui.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/v1/knowledge/documents/upload?async_index=true",
    ]);
    expect(fetchFn.mock.calls[1][1]).toMatchObject({
      method: "POST",
      body: form,
    });
  });

  test("falls back to gateway skills operations when native skills are unavailable", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeSkills: {
        list: async () => {
          throw new Error("native unavailable");
        },
        detail: async () => {
          throw new Error("native unavailable");
        },
        create: async () => {
          throw new Error("native unavailable");
        },
        update: async () => {
          throw new Error("native unavailable");
        },
        delete: async () => {
          throw new Error("native unavailable");
        },
        validate: async () => {
          throw new Error("native unavailable");
        },
      },
    });

    await expect(client.skills.list()).resolves.toEqual({ gateway: true });
    await expect(client.skills.detail("planner/phase")).resolves.toEqual({ gateway: true });
    await expect(client.skills.create({ name: "planner" })).resolves.toEqual({ gateway: true });
    await expect(client.skills.update("planner/phase", { content: "# Updated" })).resolves.toEqual({ gateway: true });
    await expect(client.skills.delete("planner/phase")).resolves.toEqual({ gateway: true });
    await expect(client.skills.validate("planner/phase")).resolves.toEqual({ gateway: true });

    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/skills",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase",
      "http://127.0.0.1:18790/api/skills",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase",
      "http://127.0.0.1:18790/api/skills/planner%2Fphase/validate",
    ]);
  });

  test("prefers native cowork route operations for migrated cowork paths", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
    });

    await expect(client.cowork.sessions({ includeCompleted: true })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.session("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.summary("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.graph("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.blueprint("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.trace("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.dag("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.artifacts("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.organization("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.queues("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.branches("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.agentActivity("cw_1", "lead", { limit: 5 })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.observation("cw_1", "detail 1", { requesterAgentId: "reviewer" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.create({ goal: "Native Cowork" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.run("cw_1", { max_rounds: 4 })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.updateBudget("cw_1", { max_rounds: 4 })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.updateBudget("cw_1", { budgets: { max_tokens: 120 } }, { method: "PATCH" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.action("cw_1", "pause")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.delete("cw_1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.message("cw_1", { content: "Direct note", recipient_ids: ["lead"] })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.addTask("cw_1", { title: "Native task" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.deriveBranch("cw_1", "branch 1", { target_architecture: "swarm" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.taskAction("cw_1", "task/1", "assign", { assigned_agent_id: "lead" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.workUnitAction("cw_1", "wu 1", "retry", { reason: "Retry" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.selectBranch("cw_1", "branch 1")).resolves.toMatchObject({ native: true });
    await expect(client.cowork.selectBranchResult("cw_1", "branch 1", { result_id: "result_1" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.mergeBranchResults("cw_1", { branch_ids: ["branch 1", "branch 2"] })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.selectFinalResult("cw_1", { branch_id: "branch 1", result_id: "result_1" })).resolves.toMatchObject({ native: true });
    await expect(client.cowork.mergeFinalResult("cw_1", { branch_ids: ["branch 1", "branch 2"] })).resolves.toMatchObject({ native: true });

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions?include_completed=true",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/summary",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/graph",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/blueprint",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/trace",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/dag",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/artifacts",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/organization",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/queues",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/branches",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/agents/lead/activity?limit=5",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "GET",
      path: "/api/cowork/sessions/cw_1/observations/detail%201?agent_id=reviewer",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions",
      body: { goal: "Native Cowork" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/run",
      body: { max_rounds: 4 },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/budget",
      body: { max_rounds: 4 },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/api/cowork/sessions/cw_1/budget",
      body: { budgets: { max_tokens: 120 } },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/pause",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/api/cowork/sessions/cw_1",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/messages",
      body: { content: "Direct note", recipient_ids: ["lead"] },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/tasks",
      body: { title: "Native task" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branches/branch%201/derive",
      body: { target_architecture: "swarm" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/tasks/task%2F1/assign",
      body: { assigned_agent_id: "lead" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/work-units/wu%201/retry",
      body: { reason: "Retry" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branches/branch%201/select",
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branches/branch%201/result/select-final",
      body: { result_id: "result_1" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branch-results/merge",
      body: { branch_ids: ["branch 1", "branch 2"] },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/final-result/select",
      body: { branch_id: "branch 1", result_id: "result_1" },
    });
    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/final-result/merge",
      body: { branch_ids: ["branch 1", "branch 2"] },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("does not fall back to Python by default when native cowork run fails", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeCowork = {
      route: vi.fn(async () => {
        throw new Error("native unavailable");
      }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
    });

    await expect(client.cowork.run("cw_1", { max_rounds: 4 })).rejects.toThrow("native unavailable");

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/run",
      body: { max_rounds: 4 },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("falls back to the Python gateway when native cowork fallback is explicitly enabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => {
        throw new Error("native unavailable");
      }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.run("cw_1", { max_rounds: 4 })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/run",
      body: { max_rounds: 4 },
    });
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/run",
    ]);
  });

  test("uses Python gateway for cowork run when the scheduler rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        scheduler: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.run("cw_1", { max_rounds: 4 })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/run",
    ]);
  });

  test("uses Python gateway for auto-run cowork create when the scheduler rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        scheduler: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({ goal: "Start and run", auto_run: true })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("uses Python gateway for auto-run swarm cowork create when the swarm rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({
      goal: "Auto-run swarm",
      workflow_mode: "swarm",
      auto_run: true,
    })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("keeps blueprint validation native when only mutation cowork routes are disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async (request: { method: string; path: string; body?: unknown }) => ({
        native: true,
        request,
      })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        mutations: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.validateBlueprint({ blueprint: { agents: [] } }, { preview: true })).resolves.toMatchObject({
      native: true,
      request: {
        method: "POST",
        path: "/api/cowork/blueprints/preview",
        body: { blueprint: { agents: [] } },
      },
    });
    await expect(client.cowork.addTask("cw_1", { title: "Gateway task" })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/tasks",
    ]);
  });

  test("uses Python gateway for swarm cowork routes when the swarm rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.message("cw_1", { content: "Prioritize evidence", recipient_ids: [] })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.message("cw_1", { content: "Direct note", recipient_ids: ["lead"] })).resolves.toEqual({ native: true });
    await expect(client.cowork.workUnitAction("cw_1", "wu 1", "retry", { reason: "Retry" })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.selectBranch("cw_1", "branch 1")).resolves.toEqual({ gateway: true });
    await expect(client.cowork.selectBranchResult("cw_1", "branch 1", { result_id: "result_1" })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.mergeBranchResults("cw_1", { branch_ids: ["branch 1", "branch 2"] })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.selectFinalResult("cw_1", { branch_id: "branch 1", result_id: "result_1" })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.mergeFinalResult("cw_1", { branch_ids: ["branch 1", "branch 2"] })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/messages",
      body: { content: "Direct note", recipient_ids: ["lead"] },
    });
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/messages",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/work-units/wu%201/retry",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/branches/branch%201/select",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/branches/branch%201/result/select-final",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/branch-results/merge",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/final-result/select",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/final-result/merge",
    ]);
  });

  test("uses worker recipient alias precedence for swarm message rollout gates", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.message("cw_1", {
      content: "Prioritize evidence",
      recipient_ids: ["lead"],
      recipientIds: [],
    })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/messages",
    ]);
  });

  test("uses Python gateway for swarm cowork create when the swarm rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({ goal: "Swarm review", workflow_mode: "swarm" })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("uses Python gateway for blueprint swarm cowork create when the swarm rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({
      goal: "Blueprint swarm",
      blueprint: { architecture: "swarm", agents: [] },
    })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("uses blueprint architecture before top-level create mode for swarm rollout gates", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({
      goal: "Blueprint wins",
      workflow_mode: "team",
      blueprint: { architecture: "swarm", agents: [] },
    })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("uses Python gateway for normalized swarm cowork create aliases when the swarm rollout gate is disabled", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.create({ goal: "Spaced swarm", architecture: " Swarm " })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.create({
      goal: "Blueprint spaced swarm",
      blueprint: { workflow_mode: " SWARM ", agents: [] },
    })).resolves.toEqual({ gateway: true });

    expect(nativeCowork.route).not.toHaveBeenCalled();
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions",
      "http://127.0.0.1:18790/api/cowork/sessions",
    ]);
  });

  test("uses the swarm rollout gate only for branch derivation targeting swarm architecture", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.deriveBranch("cw_1", null, { target_architecture: "swarm" })).resolves.toEqual({ gateway: true });
    await expect(client.cowork.deriveBranch("cw_1", "branch 1", { target_architecture: "team" })).resolves.toEqual({ native: true });

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branches/branch%201/derive",
      body: { target_architecture: "team" },
    });
    expect(fetchFn.mock.calls.map((call) => String((call as unknown[])[0]))).toEqual([
      "http://127.0.0.1:18790/webui/bootstrap",
      "http://127.0.0.1:18790/api/cowork/sessions/cw_1/branches/derive",
    ]);
  });

  test("uses Python branch-derive architecture precedence for swarm rollout gates", async () => {
    const fetchFn = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      if (String(url).endsWith("/webui/bootstrap")) {
        return new Response(JSON.stringify({ token: "token-1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ gateway: true }), { status: 200 });
    });
    const nativeCowork = {
      route: vi.fn(async () => ({ native: true })),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        swarm: false,
        fallbackToPython: true,
      },
    });

    await expect(client.cowork.deriveBranch("cw_1", null, {
      workflow_mode: "swarm",
      architecture: "team",
    })).resolves.toEqual({ native: true });

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/branches/derive",
      body: { workflow_mode: "swarm", architecture: "team" },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test("does not fall back to Python when cowork native fallback is disabled", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ gateway: true }), { status: 200 }));
    const nativeCowork = {
      route: vi.fn(async () => {
        throw new Error("native unavailable");
      }),
    };
    const client = createGatewayApiClient({
      config: DEFAULT_GATEWAY_CONFIG,
      fetchFn,
      nativeCowork,
      tsCoworkRuntime: {
        scheduler: true,
        fallbackToPython: false,
      },
    });

    await expect(client.cowork.run("cw_1", { max_rounds: 4 })).rejects.toThrow("native unavailable");

    expect(nativeCowork.route).toHaveBeenCalledWith({
      method: "POST",
      path: "/api/cowork/sessions/cw_1/run",
      body: { max_rounds: 4 },
    });
    expect(fetchFn).not.toHaveBeenCalled();
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

  test("prefers native WebUI refresh-token route when the session is near expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T10:00:00.000Z"));
    try {
      const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
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
        if (path === "/v1/knowledge/documents/upload") {
          return new Response(JSON.stringify({ gateway: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "unexpected route" }), { status: 404 });
      });
      const nativeWebui = {
        route: vi.fn(async (request: { method: string; path: string; headers?: Record<string, unknown> }) => ({
          token: "token-2",
          refresh_token_path: "/webui/refresh-token",
          token_ttl_s: 300,
          request,
        })),
      };
      const client = createGatewayApiClient({
        config: DEFAULT_GATEWAY_CONFIG,
        fetchFn,
        nativeWebui,
      });
      const form = () => {
        const data = new FormData();
        data.append("file", new File(["%PDF-1.4"], "native.pdf", { type: "application/pdf" }));
        return data;
      };

      await client.knowledge.uploadDocument(form());
      vi.setSystemTime(new Date("2026-06-08T10:04:15.000Z"));
      await client.knowledge.uploadDocument(form());

      expect(nativeWebui.route).toHaveBeenCalledWith({
        method: "POST",
        path: "/webui/refresh-token",
        headers: { Authorization: "Bearer token-1" },
      });
      expect(fetchFn.mock.calls.map((call) => String(call[0]))).toEqual([
        "http://127.0.0.1:18790/webui/bootstrap",
        "http://127.0.0.1:18790/v1/knowledge/documents/upload?async_index=true",
        "http://127.0.0.1:18790/v1/knowledge/documents/upload?async_index=true",
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
