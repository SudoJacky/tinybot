import { describe, expect, test } from "vitest";
import { buildDesktopTaskCenterItems } from "./desktopTaskCenter";
import {
  applyDesktopWorkLensFocusEvent,
  createDesktopWorkLensFocusState,
} from "./desktopWorkLensFocus";

function fixtureTasks() {
  const [chat] = buildDesktopTaskCenterItems({
    chatStreams: [
      {
        id: "chat:session-1:run-1",
        title: "Streaming answer",
        status: "streaming",
        detail: "Using workspace files",
        canonical: { module: "chat", entityId: "session-1", href: "/chat/session-1" },
        cancelable: true,
      },
    ],
  });
  const [knowledge] = buildDesktopTaskCenterItems({
    knowledgeJobs: [
      {
        id: "knowledge:doc-1:index",
        title: "Index Desktop UX Notes",
        status: "failed",
        detail: "Embedding provider returned 429",
        canonical: { module: "knowledge", entityId: "doc-1", href: "/knowledge" },
        retryable: true,
      },
    ],
  });
  const [cowork] = buildDesktopTaskCenterItems({
    coworkRuns: [
      {
        id: "cowork:session-9",
        title: "Refine operator workflow",
        status: "intervention-needed",
        detail: "Branch result needs review",
        canonical: { module: "cowork", entityId: "session-9", href: "/cowork" },
      },
    ],
  });
  return { chat, knowledge, cowork };
}

describe("desktop work lens focus state", () => {
  test("follows running work focus from task center and modules", () => {
    const { chat, knowledge } = fixtureTasks();

    const focusedChat = applyDesktopWorkLensFocusEvent(createDesktopWorkLensFocusState(), {
      type: "focusWork",
      source: "taskCenter",
      task: chat,
    });
    const focusedKnowledge = applyDesktopWorkLensFocusEvent(focusedChat, {
      type: "focusWork",
      source: "knowledge",
      task: knowledge,
    });

    expect(focusedChat.current?.id).toBe("chat:session-1:run-1");
    expect(focusedChat.source).toBe("taskCenter");
    expect(focusedKnowledge.current?.id).toBe("knowledge:doc-1:index");
    expect(focusedKnowledge.source).toBe("knowledge");
    expect(focusedKnowledge.isPinned).toBe(false);
  });

  test("preserves pinned work while recording a replace candidate", () => {
    const { chat, cowork } = fixtureTasks();
    const focused = applyDesktopWorkLensFocusEvent(createDesktopWorkLensFocusState(), {
      type: "focusWork",
      source: "chat",
      task: chat,
    });
    const pinned = applyDesktopWorkLensFocusEvent(focused, { type: "pin" });
    const browsed = applyDesktopWorkLensFocusEvent(pinned, {
      type: "focusWork",
      source: "cowork",
      task: cowork,
    });

    expect(browsed.isPinned).toBe(true);
    expect(browsed.current?.id).toBe("chat:session-1:run-1");
    expect(browsed.pinned?.id).toBe("chat:session-1:run-1");
    expect(browsed.replaceCandidate?.id).toBe("cowork:session-9");
  });

  test("can replace or unpin a pinned work lens without losing candidate context", () => {
    const { chat, cowork } = fixtureTasks();
    const pinned = applyDesktopWorkLensFocusEvent(
      applyDesktopWorkLensFocusEvent(
        applyDesktopWorkLensFocusEvent(createDesktopWorkLensFocusState(), {
          type: "focusWork",
          source: "chat",
          task: chat,
        }),
        { type: "pin" },
      ),
      {
        type: "focusWork",
        source: "cowork",
        task: cowork,
      },
    );

    const replaced = applyDesktopWorkLensFocusEvent(pinned, { type: "replacePinned" });
    const unpinned = applyDesktopWorkLensFocusEvent(pinned, { type: "unpin" });

    expect(replaced.current?.id).toBe("cowork:session-9");
    expect(replaced.pinned?.id).toBe("cowork:session-9");
    expect(replaced.replaceCandidate).toBeNull();
    expect(replaced.isPinned).toBe(true);
    expect(unpinned.current?.id).toBe("cowork:session-9");
    expect(unpinned.pinned).toBeNull();
    expect(unpinned.replaceCandidate).toBeNull();
    expect(unpinned.isPinned).toBe(false);
  });

  test("opening a related resource preserves pinned work context", () => {
    const { chat } = fixtureTasks();
    const pinned = applyDesktopWorkLensFocusEvent(
      applyDesktopWorkLensFocusEvent(createDesktopWorkLensFocusState(), {
        type: "focusWork",
        source: "chat",
        task: chat,
      }),
      { type: "pin" },
    );
    const withResource = applyDesktopWorkLensFocusEvent(pinned, {
      type: "openResource",
      route: { module: "workspace", entityId: "AGENTS.md", href: "/workspace" },
    });

    expect(withResource.current?.id).toBe("chat:session-1:run-1");
    expect(withResource.isPinned).toBe(true);
    expect(withResource.lastResourceRoute).toEqual({ module: "workspace", entityId: "AGENTS.md", href: "/workspace" });
  });

  test("clears stale focus without leaving pinned or replacement state behind", () => {
    const { chat, knowledge } = fixtureTasks();
    const stale = applyDesktopWorkLensFocusEvent(
      applyDesktopWorkLensFocusEvent(
        applyDesktopWorkLensFocusEvent(createDesktopWorkLensFocusState(), {
          type: "focusWork",
          source: "chat",
          task: chat,
        }),
        { type: "pin" },
      ),
      {
        type: "focusWork",
        source: "knowledge",
        task: knowledge,
      },
    );

    const cleared = applyDesktopWorkLensFocusEvent(stale, { type: "clear" });

    expect(cleared.current).toBeNull();
    expect(cleared.pinned).toBeNull();
    expect(cleared.replaceCandidate).toBeNull();
    expect(cleared.isPinned).toBe(false);
    expect(cleared.lastResourceRoute).toBeNull();
  });
});
