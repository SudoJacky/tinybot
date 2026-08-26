// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentGraphDraft,
  type AgentGraphDefinition,
} from "../../app-core/agent-graph/agentGraphDefinition";
import type { AgentGraphStore, StoredAgentGraph } from "../../app-core/agent-graph/agentGraphStore";
import type { AgentGraphRun, AgentGraphRuntime } from "../../app-core/agent-graph/agentGraphRuntime";
import type { ChatTimelineSnapshot } from "../../app-core/chat/agentTimelineModel";
import type { AppServices, ChatModelOption } from "../services";
import { timelineFromReactMessages } from "../chat/test/timelineFixtures";
import AgentGraphsRoute from "./AgentGraphsRoute";

afterEach(cleanup);

describe("AgentGraphsRoute", () => {
  it("stacks choice copy inside the narrow node configuration popover", () => {
    const css = readFileSync("src/react-workbench/agent-graph/AgentGraphsRoute.css", "utf8");

    expect(css).toMatch(/\.react-agent-graph-node-config \.react-settings-choice-item \.react-top-menu__menu-label\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/s);
    expect(css).toMatch(/\.react-agent-graph-node-config \.react-settings-choice-item small\s*{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("reuses the configured field appearance for the run input", () => {
    const css = readFileSync("src/react-workbench/agent-graph/AgentGraphsRoute.css", "utf8");

    expect(css).toMatch(/\.react-agent-graph-router-route input,\s*\.react-agent-graph-router-route textarea,\s*\.react-agent-graph-run__input input\s*{[^}]*border:\s*1px solid var\(--graph-border\);[^}]*border-radius:\s*7px;[^}]*background:\s*var\(--graph-panel-solid\);/s);
    expect(css).toMatch(/\.react-agent-graph-router-route input:focus-visible,\s*\.react-agent-graph-router-route textarea:focus-visible,\s*\.react-agent-graph-run__input input:focus-visible\s*{[^}]*box-shadow:/s);
  });

  it("creates and discards an isolated in-memory graph draft", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices()} />);

    expect(screen.getByRole("heading", { name: "Agent Graphs" })).toBeTruthy();
    expect(screen.getByText("Start with your first workflow")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Starter workflow preview with Input, Agent, and Output" })).toBeTruthy();
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
    expect(screen.getByText("Start with your first workflow")).toBeTruthy();
  });

  it("keeps canvas actions outside the horizontally scrolling graph surface", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices()} />);
    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));

    const canvas = screen.getByRole("region", { name: "Graph canvas" });
    const scrollSurface = canvas.closest(".react-agent-graph-canvas-scroll");
    const deleteButton = screen.getByRole("button", { name: "Delete selected" });
    const zoomInButton = screen.getByRole("button", { name: "Zoom in" });
    const toolbar = deleteButton.closest(".react-agent-graph-canvas__toolbar");

    expect(scrollSurface).toBeTruthy();
    expect(toolbar).toBeTruthy();
    expect(scrollSurface?.contains(toolbar)).toBe(false);
    expect(scrollSurface?.contains(zoomInButton)).toBe(false);
    expect(toolbar?.parentElement?.classList.contains("react-agent-graph-canvas-frame")).toBe(true);
  });

  it("pans, zooms, and fits the graph in the canvas viewport", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices()} />);
    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));

    const canvas = screen.getByRole("region", { name: "Graph canvas" });
    const frame = canvas.closest<HTMLElement>(".react-agent-graph-canvas-frame");
    const viewport = canvas.querySelector<HTMLElement>(".react-agent-graph-canvas__viewport");
    const stage = canvas.querySelector<HTMLElement>(".react-agent-graph-canvas__stage");
    expect(viewport).toBeTruthy();
    expect(stage?.dataset.zoom).toBe("1");
    expect(viewport?.dataset.zoom).toBe("1");
    expect(frame?.style.getPropertyValue("--graph-canvas-zoom")).toBe("1");
    expect(stage?.style.zoom).toBe("");
    expect(stage?.style.transform).not.toContain("scale");

    fireEvent.pointerDown(canvas, { button: 0, clientX: 180, clientY: 180, pointerId: 11 });
    fireEvent.pointerMove(canvas, { clientX: 228, clientY: 212, pointerId: 11 });
    fireEvent.pointerUp(canvas, { clientX: 228, clientY: 212, pointerId: 11 });
    expect(viewport?.dataset.panX).toBe("48");
    expect(viewport?.dataset.panY).toBe("32");

    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(stage?.dataset.zoom).toBe("1.1");
    expect(viewport?.dataset.zoom).toBe("1.1");
    expect(frame?.style.getPropertyValue("--graph-canvas-zoom")).toBe("1.1");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: 760, bottom: 400, width: 760, height: 400, x: 0, y: 0, toJSON: () => ({}) }),
    });
    const zoomWheelEvent = new Event("wheel", { bubbles: true, cancelable: true });
    Object.defineProperties(zoomWheelEvent, {
      clientX: { value: 380 },
      clientY: { value: 200 },
      ctrlKey: { value: true },
      deltaMode: { value: 0 },
      deltaY: { value: -100 },
    });
    fireEvent(canvas, zoomWheelEvent);
    expect(Number(stage?.dataset.zoom)).toBeGreaterThan(1.1);
    await user.click(screen.getByRole("button", { name: "Fit graph to view" }));
    expect(stage?.dataset.zoom).toBe("1");
    expect(viewport?.dataset.panX).toBe("3");
    expect(viewport?.dataset.panY).toBe("18");

    canvas.focus();
    await user.keyboard("{ArrowRight}{ArrowDown}");
    expect(viewport?.dataset.panX).toBe("27");
    expect(viewport?.dataset.panY).toBe("42");
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
    const conditionPaletteItem = screen.getByRole("button", { name: "Add Router node" });

    fireEvent.dragStart(conditionPaletteItem, { dataTransfer });
    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperties(dropEvent, {
      clientX: { value: 420 },
      clientY: { value: 260 },
      dataTransfer: { value: dataTransfer },
    });
    fireEvent(canvas, dropEvent);

    const conditionNode = screen.getByLabelText("Router node");
    expect(conditionNode.dataset.x).toBe("343");
    expect(conditionNode.dataset.y).toBe("222");

    conditionNode.focus();
    await user.keyboard("{ArrowRight}");
    expect(conditionNode.dataset.x).toBe("351");

    const inputNode = screen.getByLabelText("Input node");
    inputNode.focus();
    for (let step = 0; step < 10; step += 1) fireEvent.keyDown(inputNode, { key: "ArrowLeft" });
    expect(inputNode.dataset.x).toBe("-8");

    await user.click(screen.getByRole("button", { name: "Start a connection from Agent node" }));
    await user.click(screen.getByRole("button", { name: "Connect Agent to Router" }));
    const connection = screen.getByRole("button", { name: "Connection from Agent to Router" });

    fireEvent.click(connection);
    canvas.focus();
    await user.keyboard("{Delete}");
    expect(screen.queryByRole("button", { name: "Connection from Agent to Router" })).toBeNull();

    conditionNode.focus();
    await user.keyboard("{Delete}");
    expect(screen.queryByLabelText("Router node")).toBeNull();
  });

  it("configures each Agent node with a workspace known to Chat", async () => {
    const user = userEvent.setup();
    render(<AgentGraphsRoute services={createServices({
      projectWorkspaces: ["\\\\?\\D:\\code\\tinybot", "E:\\services\\payments"],
    })} />);

    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));
    await user.click(screen.getByLabelText("Agent node"));
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();
    const canvas = screen.getByRole("region", { name: "Graph canvas" });
    const configPanel = screen.getByRole("heading", { name: "Agent settings" })
      .closest<HTMLElement>(".react-agent-graph-node-config");
    const anchoredPopover = configPanel?.closest<HTMLElement>(".react-agent-graph-canvas__node-config-popover");
    expect(configPanel?.querySelector(".react-agent-graph-node-config__body")).toBeTruthy();
    expect(anchoredPopover).toBeTruthy();
    expect(canvas.contains(anchoredPopover ?? null)).toBe(true);
    expect(anchoredPopover?.dataset.anchorNodeId).toBe("agent");
    expect(anchoredPopover?.dataset.placement).toBe("below");
    expect(anchoredPopover?.style.left).toBe("377px");
    expect(anchoredPopover?.style.top).toBe("212px");

    const workspaceChoice = screen.getByRole("button", { name: "Execution workspace: tinybot" });
    await user.click(workspaceChoice);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    await user.click(screen.getByRole("menuitemradio", { name: /payments/i }));

    expect(screen.getByRole("button", { name: "Execution workspace: payments" })).toBeTruthy();
    expect(screen.getByLabelText("Agent node").textContent).toContain("payments");

    const agentNode = screen.getByLabelText("Agent node");
    agentNode.focus();
    for (let step = 0; step < 20; step += 1) fireEvent.keyDown(agentNode, { key: "ArrowDown" });
    expect(anchoredPopover?.dataset.placement).toBe("above");
    expect(Number.parseFloat(anchoredPopover?.style.top ?? "0")).toBeLessThan(
      Number.parseFloat(agentNode.dataset.y ?? "0"),
    );
  });

  it("configures node instructions, Provider, model, and reasoning effort independently", async () => {
    const user = userEvent.setup();
    const services = createServices({
      chatModels: [
        {
          default: true,
          id: "gpt-5.6-sol",
          label: "gpt-5.6-sol",
          providerId: "openai",
          providerLabel: "OpenAI",
        },
        {
          id: "gpt-5.5",
          label: "gpt-5.5",
          providerId: "openai",
          providerLabel: "OpenAI",
        },
        {
          id: "deepseek-chat",
          label: "deepseek-chat",
          providerId: "deepseek",
          providerLabel: "DeepSeek",
        },
      ],
    });
    render(<AgentGraphsRoute services={services} />);

    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));
    await user.click(screen.getByLabelText("Agent node"));

    await user.type(
      screen.getByRole("textbox", { name: /Node instructions/ }),
      "Research the topic and return a sourced report.",
    );
    await user.click(screen.getByRole("button", { name: "Provider: Inherit application default" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /OpenAI/ }));
    expect(screen.getByRole("button", { name: "Model: gpt-5.6-sol" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Model: gpt-5.6-sol" }));
    expect(screen.queryByRole("menuitemradio", { name: /deepseek-chat/ })).toBeNull();
    await user.click(screen.getByRole("menuitemradio", { name: /gpt-5\.5/ }));
    await user.click(screen.getByRole("button", { name: "Reasoning effort: Provider default" }));
    await user.click(screen.getByRole("menuitemradio", { name: /^High\b/ }));
    await user.click(screen.getByRole("button", { name: "Save Graph" }));

    expect(services.agentGraphStore.save).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({
          id: "agent",
          config: {
            instructions: "Research the topic and return a sourced report.",
            model: {
              modelId: "gpt-5.5",
              providerId: "openai",
              reasoningEffort: "high",
            },
            workspacePath: "D:\\code\\tinybot",
          },
        }), expect.objectContaining({ id: "input", kind: "input" })]),
      }),
    }));
  }, 10_000);

  it("configures Router routes and connects each stable route handle", async () => {
    const user = userEvent.setup();
    const services = createServices({
      chatModels: [{
        default: true,
        id: "gpt-5.6-sol",
        label: "gpt-5.6-sol",
        providerId: "openai",
        providerLabel: "OpenAI",
      }],
    });
    render(<AgentGraphsRoute services={services} />);

    await screen.findByRole("button", { name: "Definition workspace: tinybot" });
    await user.click(screen.getByRole("button", { name: "Create first graph" }));
    await user.click(screen.getByRole("button", { name: "Add Router node" }));
    await user.click(screen.getByLabelText("Router node"));

    const panel = screen.getByRole("heading", { name: "Router settings" })
      .closest<HTMLElement>(".react-agent-graph-node-config");
    expect(panel).toBeTruthy();
    await user.type(within(panel!).getByRole("textbox", { name: /Routing task/ }), "Choose a specialist.");
    const routeDescriptions = within(panel!).getAllByRole("textbox", { name: "When to choose this route" });
    await user.type(routeDescriptions[0], "Requests that require implementation.");
    await user.type(routeDescriptions[1], "Requests that only require a written answer.");

    await user.click(within(panel!).getByRole("button", { name: "Provider: Inherit application default" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /OpenAI/ }));
    await user.click(within(panel!).getByRole("button", { name: "Reasoning effort: Provider default" }));
    await user.click(screen.getByRole("menuitemradio", { name: /^Light\b/ }));

    await user.click(screen.getByRole("button", { name: "Start a connection from route Path A" }));
    await user.click(screen.getByRole("button", { name: "Connect Path A to Agent" }));
    await user.click(screen.getByRole("button", { name: "Start a connection from route Path B" }));
    await user.click(screen.getByRole("button", { name: "Connect Path B to Output" }));
    expect(screen.getByRole("button", { name: "Connection from Path A to Agent" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connection from Path B to Output" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Save Graph" }));
    expect(services.agentGraphStore.save).toHaveBeenCalledWith(expect.objectContaining({
      definition: expect.objectContaining({
        edges: expect.arrayContaining([
          expect.objectContaining({ source: "condition-1", sourceRouteId: "condition-1-route-a", target: "agent" }),
          expect.objectContaining({ source: "condition-1", sourceRouteId: "condition-1-route-b", target: "output" }),
        ]),
        nodes: expect.arrayContaining([expect.objectContaining({
          id: "condition-1",
          config: expect.objectContaining({
            model: { modelId: "gpt-5.6-sol", providerId: "openai", reasoningEffort: "low" },
            task: "Choose a specialist.",
          }),
        })]),
      }),
    }));
  }, 10_000);

  it("loads and saves workspace-owned Graph definitions with revisions", async () => {
    const user = userEvent.setup();
    const definition = createConfiguredGraph({
      id: "graph-research",
      name: "Research flow",
      workspacePath: "D:\\code\\tinybot",
    });
    const services = createServices({
      storedGraphs: [{ definition, revision: "sha256:before" }],
    });
    render(<AgentGraphsRoute services={services} />);

    expect(await screen.findByRole("img", { name: "Workflow preview for Research flow" })).toBeTruthy();
    expect(screen.getByText("1 Graph")).toBeTruthy();
    expect(screen.getByText("3 nodes · 2 connections")).toBeTruthy();
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

  it("opens each node in a drawer and renders Agent Threads with the Chat timeline", async () => {
    const user = userEvent.setup();
    const definition = createConfiguredGraph({
      id: "graph-research",
      name: "Research flow",
      workspacePath: "D:\\code\\tinybot",
    });
    const completedRun: AgentGraphRun = {
      schemaVersion: "tinybot.agent_graph_run.v1",
      id: "run-1",
      graphId: definition.id,
      graphRevision: "sha256:before",
      definitionWorkspacePath: "D:\\code\\tinybot",
      status: "completed",
      input: "Review this repository",
      nodeRuns: [{
        id: "run-1-node-1",
        nodeId: "agent",
        threadId: "thread-graph-1",
        status: "completed",
      }],
      output: "Repository review complete.",
    };
    const services = createServices({
      completedRun,
      nodeTimeline: timelineFromReactMessages("thread-graph-1", [{
        createdAtMs: 1,
        id: "node-user-1",
        role: "user",
        status: "complete",
        text: "Review this repository",
        turnId: "turn-graph-1",
      }, {
        createdAtMs: 2,
        id: "node-assistant-1",
        role: "assistant",
        status: "complete",
        text: "Repository review complete.",
        turnId: "turn-graph-1",
        turnStatus: "completed",
      }]),
      storedGraphs: [{ definition, revision: "sha256:before" }],
    });
    render(<AgentGraphsRoute services={services} />);

    await user.click(await screen.findByRole("button", { name: /Research flow/ }));
    await enterRunInput(user, "Review this repository");
    await user.click(screen.getByRole("button", { name: "Run" }));

    expect(services.agentGraphRuntime.start).toHaveBeenCalledWith({
      graphId: "graph-research",
      graphRevision: "sha256:before",
      definitionWorkspacePath: "D:\\code\\tinybot",
      input: "Review this repository",
    });
    await user.click(screen.getByRole("button", { name: "View" }));
    expect(screen.getByRole("button", { name: "View" }).getAttribute("aria-pressed")).toBe("true");
    const viewCanvas = screen.getByRole("region", { name: "Graph canvas" });
    const viewViewport = viewCanvas.querySelector<HTMLElement>(".react-agent-graph-canvas__viewport");
    const viewStage = viewCanvas.querySelector<HTMLElement>(".react-agent-graph-canvas__stage");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(viewStage?.dataset.zoom).toBe("1.1");
    fireEvent.pointerDown(viewCanvas, { button: 0, clientX: 200, clientY: 200, pointerId: 12 });
    fireEvent.pointerMove(viewCanvas, { clientX: 230, clientY: 220, pointerId: 12 });
    fireEvent.pointerUp(viewCanvas, { clientX: 230, clientY: 220, pointerId: 12 });
    expect(viewViewport?.dataset.panX).toBe("30");
    expect(viewViewport?.dataset.panY).toBe("20");
    await user.click(screen.getByLabelText("Agent node"));
    const agentDrawer = screen.getByRole("complementary", { name: "Agent" });
    const anchoredInspector = agentDrawer.closest<HTMLElement>(".react-agent-graph-canvas__node-config-popover");
    expect(agentDrawer.getAttribute("data-presentation")).toBe("anchored");
    expect(viewCanvas.contains(anchoredInspector ?? null)).toBe(true);
    expect(anchoredInspector?.dataset.anchorNodeId).toBe("agent");
    expect(await within(agentDrawer).findByText("Repository review complete.")).toBeTruthy();
    expect(services.chatStore.load).toHaveBeenCalledWith("thread-graph-1");
    await user.keyboard("{Delete}");
    expect(screen.getByLabelText("Agent node")).toBeTruthy();
    fireEvent.click(viewCanvas);
    expect(screen.queryByRole("complementary", { name: "Agent" })).toBeNull();

    const inputNode = screen.getByLabelText("Input node");
    await user.click(inputNode);
    expect(within(screen.getByRole("complementary", { name: "Input" })).getByText("Review this repository")).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary", { name: "Input" })).toBeNull();
    expect(document.activeElement).toBe(inputNode);
    await user.click(screen.getByLabelText("Output node"));
    expect(within(screen.getByRole("complementary", { name: "Output" })).getByText("Repository review complete.")).toBeTruthy();
  });

  it("shows the selected Router route in View mode", async () => {
    const user = userEvent.setup();
    const base = createConfiguredGraph({
      id: "graph-router-view",
      name: "Router view",
      workspacePath: "D:\\code\\tinybot",
    });
    const definition: AgentGraphDefinition = {
      ...base,
      nodes: [...base.nodes, {
        id: "router",
        kind: "condition",
        position: { x: 300, y: 230 },
        config: {
          routes: [
            { id: "code", label: "Implementation", description: "Requires code changes." },
            { id: "answer", label: "Written answer", description: "Requires only an answer." },
          ],
        },
      }],
    };
    const completedRun: AgentGraphRun = {
      schemaVersion: "tinybot.agent_graph_run.v1",
      id: "run-router",
      graphId: definition.id,
      graphRevision: "sha256:router",
      definitionWorkspacePath: "D:\\code\\tinybot",
      status: "completed",
      input: "Explain the architecture.",
      nodeRuns: [{
        id: "run-router-node-1",
        nodeId: "router",
        status: "completed",
        router: {
          rawResponse: "ROUTE_A",
          selectedEdgeId: "edge-code",
          selectedRouteId: "code",
        },
      }, {
        id: "run-router-node-2",
        nodeId: "router",
        status: "completed",
        router: {
          rawResponse: "ROUTE_B",
          selectedEdgeId: "edge-answer",
          selectedRouteId: "answer",
        },
      }],
      output: "Architecture explained.",
    };
    render(<AgentGraphsRoute services={createServices({
      completedRun,
      storedGraphs: [{ definition, revision: "sha256:router" }],
    })} />);

    await user.click(await screen.findByRole("button", { name: /Router view/ }));
    await enterRunInput(user, "Explain the architecture.");
    await user.click(screen.getByRole("button", { name: "Run" }));
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByLabelText("Router node"));

    const drawer = screen.getByRole("complementary", { name: "Router" });
    expect(within(drawer).getByText("Written answer")).toBeTruthy();
    expect(within(drawer).getByText("ROUTE_B")).toBeTruthy();
  });
});

async function enterRunInput(user: ReturnType<typeof userEvent.setup>, input: string) {
  await user.type(screen.getByRole("textbox", { name: "Run input" }), input);
}

function createConfiguredGraph(input: {
  id: string;
  name: string;
  workspacePath: string;
}): AgentGraphDefinition {
  return createAgentGraphDraft(input);
}

function createServices({
  chatModels = [],
  projectWorkspaces = [],
  storedGraphs = [],
  completedRun,
  nodeTimeline,
}: {
  chatModels?: ChatModelOption[];
  projectWorkspaces?: string[];
  storedGraphs?: StoredAgentGraph[];
  completedRun?: AgentGraphRun;
  nodeTimeline?: ChatTimelineSnapshot;
} = {}) {
  return {
    agentGraphRuntime: {
      list: vi.fn().mockResolvedValue([]),
      start: vi.fn(async (_input: Parameters<AgentGraphRuntime["start"]>[0]) => {
        if (!completedRun) throw new Error("No completed Graph Run fixture configured");
        return completedRun;
      }),
    },
    agentGraphStore: {
      list: vi.fn().mockResolvedValue(storedGraphs),
      save: vi.fn(async (input: Parameters<AgentGraphStore["save"]>[0]) => ({
        definition: input.definition,
        revision: "sha256:saved",
      })),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    chatStore: {
      load: vi.fn(async () => nodeTimeline ?? timelineFromReactMessages("empty", [])),
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
    settingsStore: {
      loadChatModels: vi.fn().mockResolvedValue(chatModels),
    },
  } as unknown as AppServices & {
    agentGraphStore: {
      list: ReturnType<typeof vi.fn>;
      save: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    agentGraphRuntime: {
      list: ReturnType<typeof vi.fn>;
      start: ReturnType<typeof vi.fn>;
    };
    chatStore: {
      load: ReturnType<typeof vi.fn>;
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
