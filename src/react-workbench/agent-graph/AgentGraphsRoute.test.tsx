// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import AgentGraphsRoute from "./AgentGraphsRoute";

afterEach(cleanup);

describe("AgentGraphsRoute", () => {
  it("creates and discards an isolated in-memory graph draft", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute />);

    expect(screen.getByRole("heading", { name: "Agent Graphs" })).toBeTruthy();
    expect(screen.getByText("No graphs yet")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Create first graph" }));

    expect(screen.getByRole("region", { name: "Graph canvas" })).toBeTruthy();
    expect(screen.getByLabelText("Input node")).toBeTruthy();
    expect(screen.getByLabelText("Agent node")).toBeTruthy();
    expect(screen.getByLabelText("Output node")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("valid");

    await user.clear(screen.getByRole("textbox", { name: "Graph name" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter a graph name");

    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByText("No graphs yet")).toBeTruthy();
  });

  it("supports palette drag, keyboard movement, connections, and deletion", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute />);
    await user.click(screen.getByRole("button", { name: "Create first graph" }));

    const canvas = screen.getByRole("region", { name: "Graph canvas" });
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 760, bottom: 400, width: 760, height: 400, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const dataTransfer = createDataTransfer();
    const conditionPaletteItem = screen.getByRole("button", { name: "Add Condition node" });

    fireEvent.dragStart(conditionPaletteItem, { dataTransfer });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(dropEvent, {
      clientX: { value: 420 },
      clientY: { value: 260 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(canvas, dropEvent);

    const conditionNode = screen.getByLabelText("Condition node");
    expect(conditionNode.dataset.x).toBe("343");
    expect(conditionNode.dataset.y).toBe("227");

    conditionNode.focus();
    await user.keyboard("{ArrowRight}");
    expect(conditionNode.dataset.x).toBe("351");

    await user.click(screen.getByRole("button", { name: "Start a connection from Agent node" }));
    await user.click(screen.getByRole("button", { name: "Connect Agent to Condition" }));
    const connection = screen.getByRole("button", { name: "Connection from Agent to Condition" });

    fireEvent.click(connection);
    await user.click(screen.getByRole("button", { name: "Delete selected" }));
    expect(screen.queryByRole("button", { name: "Connection from Agent to Condition" })).toBeNull();

    conditionNode.focus();
    await user.keyboard("{Delete}");
    expect(screen.queryByLabelText("Condition node")).toBeNull();
  });
});

function createDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  return {
    dropEffect: "none",
    effectAllowed: "all",
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    types: [],
    clearData: (format?: string) => {
      if (format) values.delete(format);
      else values.clear();
    },
    getData: (format: string) => values.get(format) ?? "",
    setData: (format: string, value: string) => values.set(format, value),
    setDragImage: () => undefined,
  };
}
