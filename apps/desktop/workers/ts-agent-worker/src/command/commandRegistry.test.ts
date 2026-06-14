import { describe, expect, test } from "vitest";

import { createDefaultCommandRouter } from "./commandRegistry";

describe("createDefaultCommandRouter", () => {
  test("generates help text from the registered backend commands", async () => {
    const router = createDefaultCommandRouter();

    const result = await router.dispatch("/help", { traceId: "trace-1" });

    expect(result).toMatchObject({
      handled: true,
      metadata: {
        command: "/help",
        render_as: "text",
      },
    });
    expect(result.output).toContain("/new - Start a new conversation.");
    expect(result.output).toContain("/approvals - List pending approval requests.");
    expect(result.output).toContain("/approve <id> once|session - Approve a pending request.");
    expect(result.output).toContain("/deny <id> - Deny a pending request.");
    expect(result.output).toContain("/dream - Manually trigger Dream consolidation.");
    expect(result.output).toContain("/dream-log [sha] - Show Dream memory changes.");
    expect(result.output).toContain("/dream-restore [sha] - List or restore Dream memory versions.");
  });

  test("runs dream commands through the dream command bridge", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      runDream: async (request) => {
        calls.push({ type: "run", request });
        return { content: "Dream completed." };
      },
      getDreamLog: async (request) => {
        calls.push({ type: "log", request });
        return { content: "## Dream Update\n\n- Commit: `abc123`" };
      },
      restoreDream: async (request) => {
        calls.push({ type: "restore", request });
        return { content: "## Dream Restore\n\nChoose a Dream memory version to restore." };
      },
    });

    await expect(router.dispatch("/dream", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Dream completed.",
      metadata: {
        command: "/dream",
        render_as: "text",
      },
    });
    await expect(router.dispatch("/dream-log abc123 --ignored", { traceId: "trace-2", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "## Dream Update\n\n- Commit: `abc123`",
      metadata: {
        command: "/dream-log",
        render_as: "text",
      },
    });
    await expect(router.dispatch("/dream-restore", { traceId: "trace-3", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "## Dream Restore\n\nChoose a Dream memory version to restore.",
      metadata: {
        command: "/dream-restore",
        render_as: "text",
      },
    });
    expect(calls).toEqual([
      { type: "run", request: { traceId: "trace-1", sessionId: "session-1" } },
      { type: "log", request: { traceId: "trace-2", sessionId: "session-1", sha: "abc123" } },
      { type: "restore", request: { traceId: "trace-3", sessionId: "session-1" } },
    ]);
  });

  test("keeps command text rendering authoritative over bridge metadata", async () => {
    const router = createDefaultCommandRouter({
      getDreamLog: async () => ({
        content: "## Dream Update\n\n- Commit: `abc123`",
        metadata: { render_as: "markdown", changed: true },
      }),
    });

    await expect(router.dispatch("/dream-log", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "## Dream Update\n\n- Commit: `abc123`",
      metadata: {
        command: "/dream-log",
        render_as: "text",
        changed: true,
      },
    });
  });

  test("reports unavailable dream commands when the bridge is absent", async () => {
    const router = createDefaultCommandRouter();

    await expect(router.dispatch("/dream-log", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "Dream commands are unavailable in this runtime.",
      metadata: {
        command: "/dream-log",
        render_as: "text",
        available: false,
      },
    });
  });

  test("reports dream run failures like Python instead of leaking the bridge error", async () => {
    const router = createDefaultCommandRouter({
      runDream: async () => {
        throw new Error("provider unavailable");
      },
    });

    await expect(router.dispatch("/dream", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Dream failed: provider unavailable",
      metadata: {
        command: "/dream",
        render_as: "text",
      },
    });
  });

  test("reports dream log bridge failures as command text instead of leaking the error", async () => {
    const router = createDefaultCommandRouter({
      getDreamLog: async () => {
        throw new Error("git history unavailable");
      },
    });

    await expect(router.dispatch("/dream-log abc123", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Dream log failed: git history unavailable",
      metadata: {
        command: "/dream-log",
        render_as: "text",
      },
    });
  });

  test("reports dream restore bridge failures as command text instead of leaking the error", async () => {
    const router = createDefaultCommandRouter({
      restoreDream: async () => {
        throw new Error("restore lock unavailable");
      },
    });

    await expect(router.dispatch("/dream-restore abc123", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Dream restore failed: restore lock unavailable",
      metadata: {
        command: "/dream-restore",
        render_as: "text",
      },
    });
  });

  test("formats rich status snapshots with Python-compatible status content", async () => {
    const router = createDefaultCommandRouter({
      getStatusSnapshot: () => ({
        activeRunCount: 2,
        activeSessionRunCount: 1,
        sessionId: "session-1",
        version: "1.2.3",
        model: "gpt-4.1-mini",
        startTimeMs: 1_000,
        nowMs: 65_000,
        lastUsage: {
          prompt_tokens: 100,
          completion_tokens: 25,
          cached_tokens: 40,
        },
        contextWindowTokens: 8192,
        sessionMessageCount: 7,
        contextTokensEstimate: 1536,
      }),
    });

    await expect(router.dispatch("/status", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: [
        "tinybot v1.2.3",
        "Model: gpt-4.1-mini",
        "Tokens: 100 in / 25 out (40% cached)",
        "Context: 1k/8k (18%)",
        "Session: 7 messages",
        "Uptime: 1m 4s",
      ].join("\n"),
      metadata: {
        command: "/status",
        render_as: "text",
        active_run_count: 2,
        active_session_run_count: 1,
        session_id: "session-1",
      },
    });
  });

  test("clears session temporary knowledge when starting a new session", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      clearSession: async (sessionId, traceId) => {
        calls.push({ type: "session", sessionId, traceId });
        return {
          sessionId: sessionId ?? "",
          messagesBefore: 4,
          messagesAfter: 0,
          checkpointCleared: true,
        };
      },
      clearTemporaryFiles: async (sessionId, traceId) => {
        calls.push({ type: "temporary-files", sessionId, traceId });
        return { cleared: 2 };
      },
    });

    await expect(router.dispatch("/new", { traceId: "trace-new", sessionId: "websocket:chat-1" })).resolves.toMatchObject({
      handled: true,
      output: "New session started.",
      metadata: {
        command: "/new",
        render_as: "text",
        cleared: true,
        session_id: "websocket:chat-1",
        messages_before: 4,
        messages_after: 0,
        checkpoint_cleared: true,
        temporary_files_cleared: 2,
      },
    });
    expect(calls).toEqual([
      { type: "session", sessionId: "websocket:chat-1", traceId: "trace-new" },
      { type: "temporary-files", sessionId: "websocket:chat-1", traceId: "trace-new" },
    ]);
  });

  test("returns Python-compatible usage for malformed approve commands", async () => {
    const router = createDefaultCommandRouter();

    await expect(router.dispatch("/approve approval-1", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Usage: `/approve <id> once` or `/approve <id> session`.",
      metadata: {
        command: "/approve",
        render_as: "text",
        approved: false,
        resolved: false,
      },
    });
  });

  test("reports missing approvals from approve and deny commands", async () => {
    const router = createDefaultCommandRouter({
      resolvePendingApproval: async (request) => ({
        resolved: false,
        approvalId: request.approvalId,
        approved: request.approved,
        scope: request.scope,
      }),
    });

    await expect(router.dispatch("/approve approval-1 once", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Approval `approval-1` was not found. Use `/approvals` to list pending requests.",
      metadata: {
        command: "/approve",
        approval_id: "approval-1",
        approved: true,
        resolved: false,
        scope: "once",
      },
    });
    await expect(router.dispatch("/deny approval-1", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Approval `approval-1` was not found. Use `/approvals` to list pending requests.",
      metadata: {
        command: "/deny",
        approval_id: "approval-1",
        approved: false,
        resolved: false,
      },
    });
  });

  test("normalizes approve scopes case-insensitively like Python", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      resolvePendingApproval: async (request) => {
        calls.push(request);
        return {
          resolved: true,
          approvalId: request.approvalId,
          approved: true,
          scope: request.scope,
          summary: "write_file path=\"notes.md\"",
        };
      },
    });

    await expect(router.dispatch("/approve approval-1 SESSION", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Approved `approval-1` for this session: write_file path=\"notes.md\"\n\nMatching operations in this session will not ask again. Retrying now.",
      metadata: {
        command: "/approve",
        approval_id: "approval-1",
        approved: true,
        resolved: true,
        scope: "session",
      },
    });
    expect(calls).toEqual([
      {
        traceId: "trace-1",
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: true,
        scope: "session",
      },
    ]);
  });

  test("resumes approved operations after resolving pending approvals", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      resolvePendingApproval: async (request) => {
        calls.push({ type: "resolve", request });
        return {
          resolved: true,
          approvalId: request.approvalId,
          approved: true,
          scope: request.scope,
          summary: "write_file path=\"notes.md\"",
        };
      },
      resumeResolvedApproval: async (request) => {
        calls.push({ type: "resume", request });
      },
    });

    await expect(router.dispatch("/approve approval-1 once", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      metadata: {
        command: "/approve",
        approval_id: "approval-1",
        approved: true,
        resolved: true,
        scope: "once",
        retry_scheduled: true,
      },
    });
    expect(calls).toEqual([
      {
        type: "resolve",
        request: {
          traceId: "trace-1",
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: true,
          scope: "once",
        },
      },
      {
        type: "resume",
        request: {
          traceId: "trace-1",
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: true,
          scope: "once",
          summary: "write_file path=\"notes.md\"",
        },
      },
    ]);
  });

  test("resumes denied operations after resolving pending approvals", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      resolvePendingApproval: async (request) => {
        calls.push({ type: "resolve", request });
        return {
          resolved: true,
          approvalId: request.approvalId,
          approved: false,
          summary: "write_file path=\"notes.md\"",
        };
      },
      resumeResolvedApproval: async (request) => {
        calls.push({ type: "resume", request });
      },
    });

    await expect(router.dispatch("/deny approval-1", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      metadata: {
        command: "/deny",
        approval_id: "approval-1",
        approved: false,
        resolved: true,
        retry_scheduled: true,
      },
    });
    expect(calls).toEqual([
      {
        type: "resolve",
        request: {
          traceId: "trace-1",
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: false,
        },
      },
      {
        type: "resume",
        request: {
          traceId: "trace-1",
          sessionId: "session-1",
          approvalId: "approval-1",
          approved: false,
          summary: "write_file path=\"notes.md\"",
        },
      },
    ]);
  });

  test("formats successful deny command results", async () => {
    const calls: unknown[] = [];
    const router = createDefaultCommandRouter({
      resolvePendingApproval: async (request) => {
        calls.push(request);
        return {
          resolved: true,
          approvalId: request.approvalId,
          approved: false,
          summary: "write_file path=\"notes.md\"",
        };
      },
    });

    await expect(router.dispatch("/deny approval-1 extra ignored", { traceId: "trace-1", sessionId: "session-1" })).resolves.toMatchObject({
      handled: true,
      output: "Denied `approval-1`: write_file path=\"notes.md\"",
      metadata: {
        command: "/deny",
        approval_id: "approval-1",
        approved: false,
        resolved: true,
      },
    });
    expect(calls).toEqual([
      {
        traceId: "trace-1",
        sessionId: "session-1",
        approvalId: "approval-1",
        approved: false,
      },
    ]);
  });
});
