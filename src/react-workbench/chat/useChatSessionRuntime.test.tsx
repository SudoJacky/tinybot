// @vitest-environment happy-dom

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { ChatEvent } from "../services";
import {
  useChatSessionRuntime,
  type ChatSessionRuntimeEffect,
  type UseChatSessionRuntimeInput,
} from "./useChatSessionRuntime";

type RuntimeStore = UseChatSessionRuntimeInput["chatStore"];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useChatSessionRuntime", () => {
  test("loads timeline and forms through one ready state and cleans up the subscription", async () => {
    const unsubscribe = vi.fn();
    const form = { form_id: "form-1" } as AgentUiForm;
    const store = runtimeStore({
      listAgentUiForms: vi.fn(async () => [form]),
      load: vi.fn(async () => timeline("session-1")),
      subscribe: vi.fn(() => unsubscribe),
    });
    const effects: ChatSessionRuntimeEffect[] = [];

    const { result, unmount } = renderHook(() => useChatSessionRuntime({
      chatStore: store,
      onEffect: (effect) => effects.push(effect),
      sessionId: "session-1",
    }));

    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    expect(result.current.state.timeline?.sessionId).toBe("session-1");
    expect(result.current.state.agentUiForms).toEqual([form]);
    expect(effects).toEqual([]);

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  test("frame-batches streaming timelines and applies only the latest snapshot", async () => {
    let listener: ((event: ChatEvent) => void) | undefined;
    const store = runtimeStore({
      load: vi.fn(async () => timeline("session-1")),
      subscribe: vi.fn((_sessionId, nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    });
    const onEffect = vi.fn<(effect: ChatSessionRuntimeEffect) => void>();
    const { result } = renderHook(() => useChatSessionRuntime({
      chatStore: store,
      onEffect,
      sessionId: "session-1",
    }));
    await waitFor(() => expect(result.current.state.status).toBe("ready"));
    onEffect.mockClear();

    act(() => {
      listener?.({ timeline: runningTimeline("session-1", "turn-1"), type: "agent_timeline_updated" });
      listener?.({ timeline: runningTimeline("session-1", "turn-2"), type: "agent_timeline_updated" });
    });

    await waitFor(() => expect(result.current.state.timeline?.turns[0]?.id).toBe("turn-2"));
    expect(onEffect).toHaveBeenCalledTimes(1);
    expect(onEffect).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      timeline: expect.objectContaining({ turns: [expect.objectContaining({ id: "turn-2" })] }),
      type: "timeline_applied",
    }));
  });

  test("surfaces load failures with diagnostics and recovers through reload", async () => {
    const load = vi.fn<() => Promise<ChatTimelineSnapshot>>()
      .mockRejectedValueOnce(new Error("timeline unavailable"))
      .mockResolvedValue(timeline("session-1"));
    const store = runtimeStore({ load });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatSessionRuntime({
      chatStore: store,
      sessionId: "session-1",
    }));

    await waitFor(() => expect(result.current.state).toMatchObject({
      error: "timeline unavailable",
      status: "failed",
    }));
    expect(errorLog).toHaveBeenCalledWith(
      "[chat-session-runtime] timeline.load.failed",
      { error: "timeline unavailable", sessionId: "session-1" },
    );

    await act(() => result.current.actions.reload());
    await waitFor(() => expect(result.current.state).toMatchObject({ error: "", status: "ready" }));
    expect(load).toHaveBeenCalledTimes(2);
  });

  test("does not hide a forms failure when the timeline load completes later", async () => {
    let resolveTimeline: ((value: ChatTimelineSnapshot) => void) | undefined;
    const store = runtimeStore({
      listAgentUiForms: vi.fn(async () => {
        throw new Error("forms unavailable");
      }),
      load: vi.fn(() => new Promise<ChatTimelineSnapshot>((resolve) => {
        resolveTimeline = resolve;
      })),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { result } = renderHook(() => useChatSessionRuntime({
      chatStore: store,
      sessionId: "session-1",
    }));
    await waitFor(() => expect(result.current.state).toMatchObject({
      error: "forms unavailable",
      status: "failed",
    }));

    act(() => resolveTimeline?.(timeline("session-1")));

    await waitFor(() => expect(result.current.state.timeline?.sessionId).toBe("session-1"));
    expect(result.current.state).toMatchObject({ error: "forms unavailable", status: "failed" });
  });
});

function runtimeStore(overrides: Partial<RuntimeStore> = {}): RuntimeStore {
  return {
    listAgentUiForms: vi.fn(async () => []),
    load: vi.fn(async (sessionId) => timeline(sessionId)),
    subscribe: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

function timeline(sessionId: string): ChatTimelineSnapshot {
  return {
    diagnostics: [],
    schemaVersion: "tinybot.chat_timeline.v1",
    sessionId,
    source: "canonical",
    turnRevisions: {},
    turns: [],
  };
}

function runningTimeline(sessionId: string, turnId: string): ChatTimelineSnapshot {
  return {
    ...timeline(sessionId),
    turns: [{ id: turnId, status: "running" } as ChatTimelineSnapshot["turns"][number]],
  };
}
