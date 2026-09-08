import { expect, it, vi } from "vitest";
import type { ChatEvent, ChatStore } from "../services";
import { subscribeChatEvents } from "./chatEventSource";

it("shares native delivery and releases it only after the last module leaves", () => {
  let receive!: (event: ChatEvent) => void;
  const unsubscribe = vi.fn();
  const source: Pick<ChatStore, "subscribe"> = { subscribe: vi.fn((_sessionId, listener) => {
    receive = listener;
    return unsubscribe;
  }) };
  const chat = vi.fn();
  const browser = vi.fn();
  const leaveChat = subscribeChatEvents(source, "s1", chat);
  const leaveBrowser = subscribeChatEvents(source, "s1", browser);
  expect(source.subscribe).toHaveBeenCalledOnce();
  receive({ type: "attached" });
  expect(chat).toHaveBeenCalledOnce();
  expect(browser).toHaveBeenCalledOnce();
  leaveChat();
  expect(unsubscribe).not.toHaveBeenCalled();
  receive({ type: "attached" });
  expect(chat).toHaveBeenCalledOnce();
  expect(browser).toHaveBeenCalledTimes(2);
  leaveBrowser();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
