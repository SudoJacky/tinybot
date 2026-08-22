// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopPetWindowClient, DesktopPetWindowSnapshot } from "../../app-core/native/desktopNativePet";
import { DesktopPetWindow } from "./DesktopPetWindow";

afterEach(() => cleanup());

describe("DesktopPetWindow", () => {
  it("renders native pet state and delegates direct manipulation to the window client", async () => {
    let stateListener: ((snapshot: DesktopPetWindowSnapshot) => void) | undefined;
    const client: DesktopPetWindowClient = {
      listen: vi.fn(async (listener) => {
        stateListener = listener;
        return () => undefined;
      }),
      moveBy: vi.fn(async () => undefined),
      requestPreferences: vi.fn(async () => undefined),
      startDragging: vi.fn(async () => undefined),
    };
    const user = userEvent.setup();
    render(<DesktopPetWindow client={client} />);
    await waitFor(() => expect(stateListener).toBeTypeOf("function"));

    stateListener?.({
      label: "Tinybot is calm",
      mood: "calm",
      preferences: { visible: true, size: "medium", position: { x: -1243, y: 318 } },
    });

    const dragSurface = await screen.findByRole("group", {
      name: "Move Tinybot desktop pet. Drag it or use the arrow keys.",
    });
    fireEvent.pointerDown(dragSurface, { button: 0 });
    fireEvent.keyDown(dragSurface, { key: "ArrowLeft", shiftKey: true });
    await user.click(screen.getByRole("button", { name: "Make Tinybot larger" }));
    await user.click(screen.getByRole("button", { name: "Hide Tinybot desktop pet" }));

    expect(client.startDragging).toHaveBeenCalledTimes(1);
    expect(client.moveBy).toHaveBeenCalledWith({ x: -24, y: 0 });
    expect(client.requestPreferences).toHaveBeenNthCalledWith(1, { size: "large" });
    expect(client.requestPreferences).toHaveBeenNthCalledWith(2, { visible: false });
  });
});
