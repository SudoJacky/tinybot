// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { timelineFromReactMessages } from "./test/timelineFixtures";
import {
  ChatPageUnderTest as ChatPage,
  createStores,
  mountWorkbenchCss,
  readWorkbenchCss,
} from "./test/ChatPageTestHarness";

describe("ChatPage", () => {
  it("uses a denser font scale for the chat surface", async () => {
    mountWorkbenchCss();
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    const chat = await screen.findByLabelText("Chat");

    expect(getComputedStyle(chat).fontSize).toBe("13px");
  });

  it("keeps expanded execution timelines at max-content height inside the conversation grid", async () => {
    const stores = createStores();
    const timeline = timelineFromReactMessages("s1", [{
      id: "u-layout",
      role: "user" as const,
      createdAtMs: Date.UTC(2026, 6, 4, 12, 1, 0),
      text: "Inspect layout",
      status: "complete" as const,
    }]);
    const turn = timeline.turns[0];
    turn.steps = [{
      agentContext: { id: "main", title: "Tinybot", type: "main" },
      id: "commentary-layout",
      kind: "message",
      messagePhase: "commentary",
      modelCallId: "call-layout",
      sequence: 1,
      status: "completed",
      summary: "Inspecting layout.",
      title: "Progress update",
    }];
    turn.executionItems = turn.steps;
    stores.chatStore.load = vi.fn(async () => timeline);

    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 2, 0)} sessionStore={stores.sessionStore} />);

    await screen.findByRole("button", { name: /Work performed Running · 1 action/ });
    mountWorkbenchCss();
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    const executionContent = document.querySelector<HTMLElement>(".react-execution-timeline__content")!;
    expect(getComputedStyle(executionTimeline).height).toBe("max-content");
    expect(getComputedStyle(executionTimeline).borderTopWidth).toBe("0px");
    expect(getComputedStyle(executionTimeline).marginLeft).toBe("0px");
    expect(getComputedStyle(executionContent).paddingLeft).toBe("0px");
  });

  it("renders the React chat layout without legacy header actions", async () => {
    const stores = createStores();
    render(<ChatPage chatStore={stores.chatStore} now={() => Date.UTC(2026, 6, 4, 12, 0, 0)} sessionStore={stores.sessionStore} />);

    expect(await screen.findByRole("button", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByText("4 min")).toBeTruthy();
    expect(screen.queryByText(/unix-ms/i)).toBeNull();
    expect(screen.getByRole("heading", { name: "Planning notes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select model" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Tools" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /delete session/i })).toBeNull();
    expect(screen.queryByText(/Agent · rust/i)).toBeNull();
  });

  it("uses the active session background for hovered and focused session rows", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.react-session-row\[data-active="true"\],\s*\.react-session-row:hover,\s*\.react-session-row:focus-within\s*{\s*background:\s*var\(--color-cream-strong\);/s,
    );
  });

  it("keeps session rows compact", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.react-session-row__select\s*{[^}]*height:\s*34px;[^}]*padding:\s*0 10px;/s,
    );
    expect(css).toContain('.react-session-row[draggable="true"]');
    expect(css).not.toContain(".react-sidebar-reorder-handle");
  });

  it("defines reduced-motion fallbacks for chat motion primitives", () => {
    const css = readWorkbenchCss();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("react-list-enter");
    expect(css).toContain("react-drawer-enter");
    expect(css).toContain("react-stepper-current");
    expect(css).toContain(".react-session-row[data-dissolving=\"true\"]");
    expect(css).toContain("transition-duration: 140ms");
    expect(css).not.toContain("react-session-particle-burst");
    expect(css).not.toContain(".react-session-row__particles");
  });

  it("applies a warm border glow treatment to the composer panel", () => {
    const css = readWorkbenchCss();
    const inputSource = readFileSync("src/components/ui/claude-style-ai-input.tsx", "utf8");

    expect(inputSource).toContain("function handlePanelPointerMove");
    expect(inputSource).toContain("--claude-ai-panel-glow-x");
    expect(inputSource).toContain("--claude-ai-panel-glow-y");
    expect(inputSource).toContain("--claude-ai-panel-glow-opacity");
    expect(css).toContain("--claude-ai-panel-glow-opacity: 0");
    expect(css).toContain("--claude-ai-panel-glow-x: 50%");
    expect(css).toContain("--claude-ai-panel-glow-y: 100%");
    expect(css).toContain("overflow: visible");
    expect(css).toContain(".claude-ai-input__panel::before");
    expect(css).toContain("circle at var(--claude-ai-panel-glow-x) var(--claude-ai-panel-glow-y)");
    expect(css).toContain("var(--color-warning) 0");
    expect(css).toContain("var(--color-primary) 24px");
    expect(css).toContain("padding: 2px");
    expect(css).toContain("transition: opacity 260ms var(--motion-ease-standard)");
    expect(css).toContain("border-color: color-mix(in srgb, var(--color-primary) 24%, var(--color-hairline))");
    expect(css).toContain("var(--color-primary)");
    expect(css).toContain("var(--color-warning)");
    expect(css).toContain("-webkit-mask-composite: xor");
    expect(css).toContain(".claude-ai-input__panel:focus-within");
    expect(css).toContain(".claude-ai-input__context-usage");
    expect(css).toContain(".claude-ai-input__context-usage-tip");
    expect(inputSource).toContain("strokeDasharray={`${view.percent} 100`}");
  });

  it("uses a restrained 180ms fade and short horizontal exit for session deletion", () => {
    const css = readWorkbenchCss();
    const source = readFileSync("src/react-workbench/chat/ChatPage.tsx", "utf8");

    expect(source).toContain("const SESSION_DELETE_DISSOLVE_MS = 180;");
    expect(source).not.toContain("SESSION_DELETE_PARTICLE");
    expect(css).toContain(".react-session-row[data-dissolving=\"true\"] {");
    expect(css).toContain("opacity: 0");
    expect(css).toContain("transform: translateX(8px)");
    expect(css).not.toContain(".react-session-row__particle");
    expect(css).not.toContain("filter: blur(0.8px)");
  });
});
