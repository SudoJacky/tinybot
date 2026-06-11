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
