import { describe, expect, test } from "vitest";

import { createDefaultCommandRouter } from "./commandRegistry";

describe("createDefaultCommandRouter", () => {
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
