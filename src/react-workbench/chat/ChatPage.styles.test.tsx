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

    const toggle = await screen.findByRole("button", { name: /Work performed: Running/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    mountWorkbenchCss();
    const executionTimeline = document.querySelector<HTMLElement>(".react-execution-timeline")!;
    const executionContent = document.querySelector<HTMLElement>(".react-execution-timeline__content")!;
    expect(getComputedStyle(executionTimeline).height).toBe("max-content");
    expect(getComputedStyle(executionTimeline).borderTopWidth).toBe("0px");
    expect(getComputedStyle(executionTimeline).marginLeft).toBe("0px");
    expect(getComputedStyle(executionContent).paddingLeft).toBe("28px");
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

  it("keeps the artifact panel as the only vertical scrolling surface", () => {
    const chatCss = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");
    const sidecarCss = readFileSync("src/react-workbench/sidecar/Sidecar.css", "utf8");

    expect(sidecarCss).toMatch(
      /\.react-sidecar__artifact\s*{[^}]*overflow:\s*auto;/s,
    );
    expect(chatCss).toMatch(
      /\.react-artifact-detail__text\s*{[^}]*white-space:\s*pre-wrap;/s,
    );
    expect(chatCss).not.toMatch(
      /\.react-artifact-detail__text\s*{[^}]*max-height:/s,
    );
    expect(chatCss).not.toMatch(
      /\.react-artifact-detail__text\s*{[^}]*overflow(?:-y)?:\s*auto;/s,
    );
  });

  it("animates Sidecar layout changes and preserves a reduced-motion path", () => {
    const chatCss = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");
    const sidecarCss = readFileSync("src/react-workbench/sidecar/Sidecar.css", "utf8");

    expect(chatCss).toMatch(
      /\.react-chat-workspace\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 0;[^}]*transition:\s*grid-template-columns var\(--motion-duration-medium\) var\(--motion-ease-standard\);/s,
    );
    expect(sidecarCss).toMatch(
      /\.react-sidecar\s*{[^}]*transform:\s*translateX\(0\);[^}]*transition:\s*transform var\(--motion-duration-medium\) var\(--motion-ease-drawer\);/s,
    );
    expect(sidecarCss).toMatch(
      /\.react-sidecar\[data-hidden="true"\]\s*{[^}]*transform:\s*translateX\(100%\);/s,
    );
    expect(chatCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.react-chat-workspace\s*{\s*transition-duration:\s*0ms;/,
    );
    expect(sidecarCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.react-sidecar,[\s\S]*transition-duration:\s*0ms;/,
    );
  });

  it("keeps spreadsheet cells visually unchanged on hover", () => {
    const chatCss = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");

    expect(chatCss).toMatch(
      /\.react-office-spreadsheet__cell:hover,\s*\.react-office-spreadsheet__cell:focus-visible\s*{[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*transform:\s*none;/s,
    );
  });

  it("keeps the anchored spreadsheet change editor touch-friendly", () => {
    const chatCss = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");

    expect(chatCss).toMatch(
      /\.react-office-spreadsheet__selection-action form\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 44px;[^}]*min-height:\s*56px;/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-spreadsheet__selection-action form > button\s*{[^}]*width:\s*44px;[^}]*height:\s*44px;/s,
    );
  });

  it("overlays the PowerPoint navigation rail without resizing the slide stage", () => {
    const chatCss = readFileSync("src/react-workbench/chat/ChatPage.css", "utf8");

    expect(chatCss).toMatch(
      /\.react-office-presentation\s*{[^}]*grid-template-columns:\s*0 minmax\(0, 1fr\);/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation\[data-expanded="true"\]\s*{[^}]*width:\s*166px;[^}]*transform:\s*translateX\(8px\);/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation\s*{[^}]*transform:\s*translateX\(-8px\);[^}]*transform 180ms var\(--motion-ease-standard\),/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation button\s*{[^}]*width:\s*44px;[^}]*height:\s*28px;[^}]*min-height:\s*28px;/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation\[data-expanded="true"\] button\s*{[^}]*height:\s*auto;[^}]*min-height:\s*76px;/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation-bar\s*{[^}]*width:\s*calc\(18px \+ \(var\(--presentation-navigation-effect\) \* 10px\)\);[^}]*height:\s*calc\(2px \+ \(var\(--presentation-navigation-effect\) \* 1px\)\);/s,
    );
    expect(chatCss).toMatch(
      /\.react-office-presentation__navigation button\s*{[^}]*--presentation-navigation-effect:\s*max\([^;]*--presentation-navigation-proximity[^;]*--presentation-navigation-active[^;]*--presentation-navigation-focus[^;]*\);/s,
    );
    expect(chatCss).toContain("transform: translateX(calc(var(--presentation-navigation-effect) * 3px))");
    expect(chatCss).toContain(".react-office-presentation__navigation-bar");
    expect(chatCss).toContain("opacity 100ms var(--motion-ease-standard)");
    expect(chatCss).toContain(".react-office-presentation__thumbnail .pptx-preview-slide-wrapper");
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

  it("keeps composer popovers above the pointer-following border glow", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.claude-ai-input__panel::before\s*{[^}]*z-index:\s*0;/s,
    );
    expect(css).toMatch(
      /\.claude-ai-input__panel > \*\s*{[^}]*z-index:\s*1;/s,
    );
  });

  it("lets the empty-chat workspace menu extend past the conversation row", () => {
    const css = readWorkbenchCss();

    expect(css).toMatch(
      /\.react-chat-surface\[data-empty-session="true"\] \.react-conversation-view\s*{[^}]*overflow:\s*visible;/s,
    );
    expect(css).toMatch(
      /\.react-empty-chat-workspace__menu\s*{[^}]*z-index:\s*30;/s,
    );
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
