import { describe, expect, test } from "vitest";

import { CommandRouter } from "./commandRouter";
import type { CommandContext, CommandResult } from "./commandTypes";

function handler(label: string) {
  return async (context: CommandContext): Promise<CommandResult> => ({
    handled: true,
    output: `${label}:${context.command}:${context.args}`,
    metadata: { label },
  });
}

describe("CommandRouter", () => {
  test("dispatches priority commands before exact and prefix handlers", async () => {
    const router = new CommandRouter();
    router.priority("/stop", handler("priority"));
    router.exact("/stop", handler("exact"));
    router.prefix("/s", handler("prefix"));

    await expect(router.dispatch("/stop", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "priority:/stop:",
      metadata: { label: "priority" },
    });
    expect(router.isPriority("/stop")).toBe(true);
  });

  test("matches exact commands case-insensitively", async () => {
    const router = new CommandRouter();
    router.exact("/help", handler("help"));

    await expect(router.dispatch("  /HELP  ", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "help:/HELP:",
    });
  });

  test("uses longest prefix match and preserves argument text", async () => {
    const router = new CommandRouter();
    router.prefix("/approve", handler("approve-short"));
    router.prefix("/approve once", handler("approve-once"));

    await expect(router.dispatch("/approve once approval-1 --reason ok", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "approve-once:/approve once:approval-1 --reason ok",
    });
  });

  test("falls back to interceptor when no command matches", async () => {
    const router = new CommandRouter();
    router.intercept(handler("fallback"));

    await expect(router.dispatch("/unknown thing", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "fallback:/unknown:thing",
    });
  });

  test("returns unhandled for ordinary messages and missing slash commands", async () => {
    const router = new CommandRouter();

    await expect(router.dispatch("hello", { traceId: "trace-1" })).resolves.toEqual({ handled: false });
    await expect(router.dispatch("/missing", { traceId: "trace-1" })).resolves.toEqual({ handled: false });
  });
});
