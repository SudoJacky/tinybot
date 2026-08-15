import { describe, expect, it } from "vitest";
import {
  INITIAL_LIVE_CANVAS_STATE,
  reduceLiveCanvasState,
} from "./liveCanvasModel";

describe("liveCanvasModel", () => {
  it("opens a selected history entry with its canonical event index", () => {
    expect(reduceLiveCanvasState(INITIAL_LIVE_CANVAS_STATE, {
      type: "select",
      eventIndex: 7,
      itemId: "tool-2",
      turnId: "turn-1",
    })).toEqual({
      mode: "history",
      selection: { eventIndex: 7, itemId: "tool-2", turnId: "turn-1" },
      surface: "panel",
      visibility: "open",
    });
  });

  it("keeps the closing phase explicit until animation completion", () => {
    const open = reduceLiveCanvasState(INITIAL_LIVE_CANVAS_STATE, { type: "toggle" });
    const closing = reduceLiveCanvasState(open, { type: "close" });

    expect(closing.visibility).toBe("closing");
    expect(reduceLiveCanvasState(closing, { type: "close_complete" }).visibility).toBe("closed");
  });

  it("returns from history without discarding the selection", () => {
    const history = reduceLiveCanvasState(INITIAL_LIVE_CANVAS_STATE, {
      type: "select",
      itemId: "message-1",
      turnId: "turn-1",
    });

    expect(reduceLiveCanvasState(history, { type: "return_live" })).toEqual({
      ...history,
      mode: "live_follow",
      visibility: "open",
    });
  });
});
