// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentGraphDraft } from "../../app-core/agent-graph/agentGraphDefinition";
import type { AgentGraphStore, StoredAgentGraph } from "../../app-core/agent-graph/agentGraphStore";
import type { AppServices } from "../services";
import AgentGraphsRoute from "./AgentGraphsRoute";

afterEach(cleanup);

describe("AgentGraphsRoute", () => {
  it("creates and discards an isolated in-memory graph draft", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices()} />);

    expect(screen.getByRole("heading", { name: "Agent Graphs" })).toBeTruthy();
    expect(screen.getByText("No graphs yet")).toBeTruthy();
    await screen.findByRole("button", { name: "Definition workspace: tinybot" });

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
    render(<AgentGraphsRoute services={createServices()} />);
    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
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

  it("configures each Agent node with a workspace known to Chat", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices({
      projectWorkspaces: ["\\\\?\\D:\\code\\tinybot", "E:\\services\\payments"],
    })} />);

    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));
    await user.click(screen.getByLabelText("Agent node"));

    const workspaceChoice = screen.getByRole("button", { name: "Execution workspace: tinybot" });
    await user.click(workspaceChoice);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    await user.click(screen.getByRole("menuitemradio", { name: /payments/i }));

    expect(screen.getByRole("button", { name: "Execution workspace: payments" })).toBeTruthy();
    expect(screen.getByLabelText("Agent node").textContent).toContain("payments");
  });

  it("loads and saves workspace-owned Graph definitions with revisions", async () => {
    const user = userEvent.setup();
    const definition = createAgentGraphDraft({
      id: "graph-research",
      name: "Research flow",
      workspacePath: "D:\\code\\tinybot",
    });
    const services = createServices({
      storedGraphs: [{ definition, revision: "sha256:before" }],
    });
    render(<AgentGraphsRoute services={services} />);

    await user.click(await screen.findByRole("button", { name: /Research flow/ }));
    expect(screen.getByText("Saved")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "Graph name" }));
    await user.type(screen.getByRole("textbox", { name: "Graph name" }), "Updated research");
    await user.click(screen.getByRole("button", { name: "Save Graph" }));

    expect(services.agentGraphStore.save).toHaveBeenCalledWith({
      workspacePath: "D:\\code\\tinybot",
      definition: expect.objectContaining({ id: "graph-research", name: "Updated research" }),
      expectedRevision: "sha256:before",
    });
    expect(await screen.findByText("Saved")).toBeTruthy();
  });
});

function createServices({
  projectWorkspaces = [],
  storedGraphs = [],
}: {
  projectWorkspaces?: string[];
  storedGraphs?: StoredAgentGraph[];
} = {}) {
  return {
    agentGraphStore: {
      list: vi.fn().mockResolvedValue(storedGraphs),
      save: vi.fn(async (input: Parameters<AgentGraphStore["save"]>[0]) => ({
        definition: input.definition,
        revision: "sha256:saved",
      })),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    sessionStore: {
      list: vi.fn().mockResolvedValue([{
        id: "thread-1",
        title: "Tinybot",
        updatedAtMs: 1,
        workingDirectory: "D:\\code\\tinybot",
      }]),
    },
    projectGroupStore: {
      list: vi.fn().mockResolvedValue(projectWorkspaces.length ? [{
        projectGroupId: "project-1",
        name: "Services",
        workspaceIds: projectWorkspaces,
      }] : []),
    },
  } as unknown as AppServices & {
    agentGraphStore: {
      list: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
  };
}

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
