// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
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
    expect(screen.getByRole("status").textContent).toContain("ready");

    await user.clear(screen.getByRole("textbox", { name: "Graph name" }));
    expect(screen.getByRole("alert").textContent).toContain("Enter a graph name");

    await user.click(screen.getByRole("button", { name: "Discard draft" }));
    expect(screen.getByText("No graphs yet")).toBeTruthy();
  });
});
