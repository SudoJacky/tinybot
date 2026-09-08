// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatTurn } from "../../app-core/chat/chatTurnContracts";
import type { ThreadEffectiveCapabilities } from "../../app-core/chat/threadCapabilities";
import type { ChatEvent, ChatStore, SessionStore, SessionSummary } from "../services";
import { createChatSessionApplication } from "./chatSessionApplication";
import { useChatApplication } from "./useChatApplication";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const session = (id: string): SessionSummary => ({ id, chatId: id, title: "New chat", status: "running", updatedAtMs: 1 });
const input = { id: "q1", content: "next", createdAt: "2026-09-08T00:00:00Z", mode: "queued" as const, status: "queued" as const, turnInput: { text: "next" } };
function timeline(sessionId: string): ChatTimelineSnapshot {
  return {
    schemaVersion: "tinybot.chat_timeline.v1", source: "canonical", sessionId, diagnostics: [], turnRevisions: {},
    turns: [{
      id: `turn-${sessionId}`, sessionKey: sessionId, userMessageId: "u1",
      userMessage: { id: "u1", role: "user", text: "hello", timestamp: "2026-09-08T00:00:00Z" },
      status: "running", steps: [], startedAt: "2026-09-08T00:00:00Z", updatedAt: "2026-09-08T00:00:00Z",
    }],
  };
}
function capabilities(threadId: string, available = true): ThreadEffectiveCapabilities {
  return {
    schemaVersion: "tinybot.effective_capabilities.v2", threadId,
    capabilities: { agent: { cancel: { available }, retry: { available: false } } },
  };
}
function setup() {
  const listeners = new Map<string, (event: ChatEvent) => void>();
  const store = {
    load: vi.fn(async (id: string) => timeline(id)),
    listAgentUiForms: vi.fn(async () => []),
    loadEffectiveCapabilities: vi.fn(async (id: string) => capabilities(id)),
    dispatch: vi.fn(async () => {}),
    subscribe: vi.fn((id: string, listener: (event: ChatEvent) => void) => {
      listeners.set(id, listener);
      return () => { listeners.delete(id); };
    }),
  };
  const sessionStore: SessionStore = {
    list: vi.fn(async () => [session("s1"), session("s2")]), create: vi.fn(async () => session("created")),
    rename: vi.fn(async () => {}), delete: vi.fn(async () => {}), archive: vi.fn(async () => {}), pin: vi.fn(async () => {}),
  };
  const sessions = createChatSessionApplication(sessionStore);
  sessions.accept(session("s1"));
  sessions.accept(session("s2"));
  const onBackgroundActivity = vi.fn();
  const options = {
    chatStore: store as unknown as ChatStore, sessions, openSessionIds: ["s1", "s2"], drafts: {}, model: {},
    now: Date.now, t: ((key: string) => key) as TFunction<"chat">,
    onDraftConsumed: vi.fn(), onBackgroundActivity,
  };
  return {
    store, sessionStore, sessions, listeners, onBackgroundActivity,
    render: () => renderHook(({ id }) => useChatApplication({ ...options, sessionId: id, session: session(id) }), { initialProps: { id: "s1" } }),
  };
}

it("ignores capability responses from the previous session", async () => {
  const { store, render } = setup();
  let resolve!: (value: ThreadEffectiveCapabilities) => void;
  const pending = new Promise<ThreadEffectiveCapabilities>((done) => { resolve = done; });
  store.loadEffectiveCapabilities.mockImplementation(async (id) => id === "s1" ? pending : capabilities(id, false));
  const { result, rerender } = render();
  await waitFor(() => expect(result.current.state.status).toBe("ready"));
  rerender({ id: "s2" });
  await waitFor(() => expect(result.current.state.timeline?.sessionId).toBe("s2"));
  await act(async () => resolve(capabilities("s1")));
  expect(result.current.state.canCancel).toBe(false);
  expect(result.current.state.error).toBe("");
});

it("acknowledges commands through the background subscription after switching tabs", async () => {
  const { store, render, listeners } = setup();
  const { result, rerender, unmount } = render();
  await waitFor(() => expect(result.current.state.canCancel).toBe(true));
  await act(async () => result.current.turns.cancel("s1"));
  const lifecycle = result.current.turns.turn("s1").lifecycle;
  if (lifecycle.stage === "idle") throw new Error("Expected a dispatched command");
  const commandId = lifecycle.command.commandId;
  act(() => listeners.get("s1")!({ type: "command.accepted", commandId }));
  expect(result.current.turns.turn("s1").lifecycle.stage).toBe("waiting_for_canonical");
  rerender({ id: "s2" });
  await waitFor(() => expect(result.current.state.timeline?.sessionId).toBe("s2"));
  const canonical = timeline("s1");
  canonical.turns[0].canonicalItems = [{
    data: { detail: { commandId, commandStatus: "acknowledged" } }, itemId: "ack", revision: 1, status: "completed",
  }] as ChatTurn["canonicalItems"];
  store.load.mockResolvedValueOnce(canonical);
  act(() => listeners.get("s1")!({ type: "command.canonical-updated", commandId }));
  await waitFor(() => expect(result.current.turns.turn("s1").lifecycle.stage).toBe("acknowledged"));
  expect(result.current.state.timeline?.sessionId).toBe("s2");
  expect(result.current.state.lifecycle.stage).toBe("idle");
  unmount();
  expect(listeners.size).toBe(0);
});

it("owns background queue continuation without replacing the active timeline", async () => {
  const { store, sessionStore, render, listeners } = setup();
  const { result, rerender } = render();
  await waitFor(() => expect(result.current.state.canCancel).toBe(true));
  act(() => result.current.turns.enqueue("s1", input));
  rerender({ id: "s2" });
  await waitFor(() => expect(result.current.state.timeline?.sessionId).toBe("s2"));
  vi.mocked(sessionStore.list).mockResolvedValue([{ ...session("s1"), status: "idle" }, session("s2")]);
  act(() => listeners.get("s1")!({ type: "agent.event", eventType: "agent.turn.completed" }));
  await waitFor(() => expect(store.dispatch).toHaveBeenCalledWith(expect.objectContaining({
    kind: "turn.submit", target: expect.objectContaining({ sessionId: "s1" }),
  })));
  expect(result.current.turns.queue("s1").inputs).toEqual([]);
  expect(result.current.state.timeline?.sessionId).toBe("s2");
});

it("moves optimistic messages and queued inputs when session data reconciles an ID", async () => {
  const { sessionStore, sessions, render, listeners } = setup();
  const { result, rerender } = render();
  await waitFor(() => expect(result.current.state.canCancel).toBe(true));
  act(() => {
    result.current.turns.enqueue("s1", input);
    listeners.get("s1")!({ type: "message", message: { id: "optimistic", role: "user", text: "hello", status: "complete", createdAtMs: 1 } });
    sessions.preview({ ...session("s1"), title: "First prompt" });
  });
  vi.mocked(sessionStore.list).mockResolvedValue([session("persisted"), session("s2")]);
  await act(async () => { await sessions.refresh(); });
  rerender({ id: "persisted" });
  expect(result.current.turns.queue("persisted").inputs).toEqual([input]);
  expect(result.current.turns.queue("s1").inputs).toEqual([]);
  expect(result.current.state.optimisticMessages.map((message) => message.id)).toEqual(["optimistic"]);
});

it("clears application state on removal without waiting for page animations", async () => {
  const { sessions, render, listeners } = setup();
  const { result } = render();
  await waitFor(() => expect(result.current.state.canCancel).toBe(true));
  act(() => {
    result.current.turns.enqueue("s1", input);
    result.current.turns.enqueue("s2", input);
    listeners.get("s1")!({ type: "message", message: { id: "optimistic", role: "user", text: "hello", status: "complete", createdAtMs: 1 } });
  });
  await act(async () => result.current.turns.cancel("s1"));
  await act(async () => sessions.delete(session("s1")));
  expect(result.current.turns.queue("s1").inputs).toEqual([]);
  expect(result.current.turns.turn("s1").lifecycle.stage).toBe("idle");
  expect(result.current.state.optimisticMessages).toEqual([]);
  expect(result.current.turns.queue("s2").inputs).toEqual([input]);
});
