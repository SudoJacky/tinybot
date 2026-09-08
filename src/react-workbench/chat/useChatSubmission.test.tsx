// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import type { ChatStore } from "../services";
import { useChatSubmission } from "./useChatSubmission";

afterEach(cleanup);

function setup(dispatch: ChatStore["dispatch"]) {
  return renderHook(() => useChatSubmission({
    chatStore: { dispatch } as ChatStore,
    sessionId: "s1", now: () => 1, t: ((key: string) => key) as TFunction<"chat">,
    reload: async () => {}, refreshSessions: async () => [], materializeDraft: async () => null,
    previewSession: () => {}, consumeDraft: () => {},
  }));
}

it("retracts only the failed optimistic submission while retaining independently received messages", async () => {
  let reject!: (error: Error) => void;
  const dispatch = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  const { result } = setup(dispatch);
  let submitted!: Promise<void>;
  await act(async () => {
    submitted = result.current.submitTurn("s1", { text: "draft" }, "composer-send", "draft");
    await Promise.resolve();
  });
  expect(result.current.optimisticMessages).toHaveLength(1);
  act(() => result.current.receiveMessage("s1", { id: "other", role: "user", text: "other", status: "complete", createdAtMs: 2 }));
  await act(async () => {
    reject(new Error("submission rejected"));
    await expect(submitted).rejects.toThrow("submission rejected");
  });
  expect(result.current.optimisticMessages.map((message) => message.id)).toEqual(["other"]);
});

it("keeps optimistic messages scoped to their session when a draft receives its persisted ID", () => {
  const { result } = setup(async () => {});
  act(() => result.current.receiveMessage("draft", { id: "pending", role: "user", text: "draft", status: "complete", createdAtMs: 1 }));
  expect(result.current.optimisticMessages).toEqual([]);
  act(() => result.current.replaceSession("draft", "s1"));
  expect(result.current.optimisticMessages.map((message) => message.id)).toEqual(["pending"]);
  act(() => result.current.forgetSession("s1"));
  expect(result.current.optimisticMessages).toEqual([]);
});
