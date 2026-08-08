import { describe, expect, test } from "vitest";

import { createDesktopCompactCommand, createDesktopStopCommand, createDesktopTurnSubmitCommand } from "./desktopCommand";

describe("desktop command", () => {
  test("creates a correlated turn command", () => {
    expect(createDesktopTurnSubmitCommand({
      commandId: "command-1",
      issuedAt: "2026-07-15T00:00:00.000Z",
      message: { text: "hello", model: "model-1", reasoningEffort: "high" },
      sessionId: "thread-1",
      source: { control: "composer-send", surface: "chat" },
    })).toEqual({
      schemaVersion: "tinybot.command.v1",
      commandId: "command-1",
      issuedAt: "2026-07-15T00:00:00.000Z",
      kind: "turn.submit",
      source: { control: "composer-send", surface: "chat" },
      target: { sessionId: "thread-1" },
      input: { text: "hello", model: "model-1", reasoningEffort: "high" },
    });
  });

  test("creates a stop intent without leaking active-turn lookup to the caller", () => {
    expect(createDesktopStopCommand({
      commandId: "command-2",
      issuedAt: "2026-07-15T00:00:00.000Z",
      sessionId: "thread-1",
      source: { control: "keyboard-shortcut", surface: "chat" },
    })).toEqual({
      schemaVersion: "tinybot.command.v1",
      commandId: "command-2",
      issuedAt: "2026-07-15T00:00:00.000Z",
      kind: "agent.stop",
      source: { control: "keyboard-shortcut", surface: "chat" },
      target: { sessionId: "thread-1" },
    });
  });

  test("creates a standalone context compaction intent", () => {
    expect(createDesktopCompactCommand({
      commandId: "command-3",
      issuedAt: "2026-07-15T00:00:00.000Z",
      sessionId: "thread-1",
      source: { control: "slash-compact", surface: "chat" },
    })).toEqual({
      schemaVersion: "tinybot.command.v1",
      commandId: "command-3",
      issuedAt: "2026-07-15T00:00:00.000Z",
      kind: "context.compact",
      source: { control: "slash-compact", surface: "chat" },
      target: { sessionId: "thread-1" },
    });
  });
});
