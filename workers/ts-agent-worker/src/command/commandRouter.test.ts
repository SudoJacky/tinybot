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

  test("requires exact input for priority commands", async () => {
    const router = new CommandRouter();
    router.priority("/stop", handler("priority"));
    router.prefix("/stop", handler("prefix"));

    expect(router.isPriority("/stop now")).toBe(false);
    await expect(router.dispatch("/stop now", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "prefix:/stop:now",
      metadata: { label: "prefix" },
    });
  });

  test("matches exact commands case-insensitively", async () => {
    const router = new CommandRouter();
    router.exact("/help", handler("help"));

    await expect(router.dispatch("  /HELP  ", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "help:/HELP:",
    });
  });

  test("requires whole-line matches for exact commands like the legacy runtime", async () => {
    const router = new CommandRouter();
    router.exact("/new", handler("exact"));
    router.intercept(handler("fallback"));

    await expect(router.dispatch("/new extra", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "fallback:/new:extra",
      metadata: { label: "fallback" },
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

  test("requires prefix commands to include arguments like the legacy runtime", async () => {
    const router = new CommandRouter();
    router.prefix("/approve", handler("approve"));
    router.intercept(handler("fallback"));

    await expect(router.dispatch("/approve", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "fallback:/approve:",
      metadata: { label: "fallback" },
    });
    await expect(router.dispatch("/approve approval-1 once", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "approve:/approve:approval-1 once",
      metadata: { label: "approve" },
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

  test("runs interceptors in registration order like the legacy runtime", async () => {
    const router = new CommandRouter();
    router.intercept(handler("first"));
    router.intercept(handler("second"));

    await expect(router.dispatch("/unknown thing", { traceId: "trace-1" })).resolves.toMatchObject({
      handled: true,
      output: "first:/unknown:thing",
      metadata: { label: "first" },
    });
  });

  test("preserves inbound command metadata while allowing command metadata to override", async () => {
    const router = new CommandRouter();
    router.exact("/help", async () => ({
      handled: true,
      output: "help",
      metadata: { render_as: "text", command: "/help" },
    }));

    await expect(router.dispatch("/help", {
      traceId: "trace-1",
      metadata: {
        message_id: "msg-1",
        render_as: "markdown",
      },
    })).resolves.toMatchObject({
      handled: true,
      output: "help",
      metadata: {
        message_id: "msg-1",
        render_as: "text",
        command: "/help",
      },
    });
  });

  test("returns unhandled for ordinary messages and missing slash commands", async () => {
    const router = new CommandRouter();

    await expect(router.dispatch("hello", { traceId: "trace-1" })).resolves.toEqual({ handled: false });
    await expect(router.dispatch("/missing", { traceId: "trace-1" })).resolves.toEqual({ handled: false });
  });
});
