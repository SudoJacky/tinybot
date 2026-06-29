// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { mountConversationThreadIsland } from "./conversationThreadIsland";

async function flushDetailPanelOpeningMotion() {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
  await nextTick();
}

describe("conversation thread Vue island", () => {
  test("renders messages in order", async () => {
    const host = document.createElement("section");

    const mounted = mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Hello"],
          references: [],
          time: "10:28 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["Hi"],
          references: [{ detail: "", kind: "File", title: "README.md" }],
          time: "10:29 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.getAttribute("data-desktop-vue-island")).toBe("conversation-thread");
    expect(host.className).toBe("desktop-conversation-thread");
    expect(host.getAttribute("aria-label")).toBe("Message Timeline");
    expect(host.getAttribute("data-desktop-chat-region")).toBe("message-timeline");
    expect(host.getAttribute("role")).toBe("log");
    expect(host.getAttribute("aria-live")).toBe("polite");
    expect(Array.from(host.querySelectorAll(".desktop-conversation-message")).map((message) => message.getAttribute("data-desktop-vue-island"))).toEqual([
      "conversation-message",
      "conversation-message",
    ]);
    expect(host.querySelector(".desktop-conversation-meta strong")).toBeNull();
    expect(host.querySelector(".desktop-conversation-reference")?.textContent).toBe("File: README.md");

    mounted.unmount();
    expect(host.textContent).toBe("");
  });

  test("renders empty state", () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "No messages in this session.",
      messages: [],
    });

    expect(host.textContent).toBe("No messages in this session.");
  });

  test("renders inline Agent UI form cards inside the message timeline", async () => {
    const host = document.createElement("section");
    const actions: string[] = [];

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      inlineForms: [{
        cancel_label: "Cancel",
        correlation: { chat_id: "chat-1" },
        fields: [{
          label: "Target",
          name: "target",
          required: true,
          type: "text",
        }],
        form_id: "form-1",
        status: "pending",
        submit_label: "Submit",
        title: "Need deployment target",
      }],
      messages: [{
        author: "Tinybot",
        body: ["I need one more detail."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [],
      }],
      onInlineFormCancel: (form) => actions.push(`cancel:${form.form_id}`),
      onInlineFormSubmit: (form, values) => actions.push(`submit:${form.form_id}:${values.target}`),
    });
    await nextTick();
    await nextTick();

    const inlineCard = host.querySelector(".desktop-agent-ui-form-inline");
    expect(inlineCard?.getAttribute("data-desktop-chat-region")).toBe("agent-form-card");
    expect(inlineCard?.getAttribute("data-agent-ui-form-id")).toBe("form-1");
    expect(inlineCard?.textContent).toContain("Need deployment target");
    const field = inlineCard?.querySelector<HTMLInputElement>('[data-agent-ui-form-field="target"]');
    field!.value = "production";
    inlineCard?.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="submit"]')?.click();
    inlineCard?.querySelector<HTMLButtonElement>('[data-agent-ui-form-action="cancel"]')?.click();

    expect(actions).toEqual(["submit:form-1:production", "cancel:form-1"]);
  });

  test("renders chat Cowork runs inline with selectable agent rows", async () => {
    const host = document.createElement("section");
    const selections: unknown[] = [];

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      coworkRuns: [{
        activeAgentCount: 1,
        agentCount: 2,
        agents: [
          {
            attentionLabel: "",
            id: "agent-1",
            label: "Planner",
            latestActivity: "drafted plan",
            roleOrTask: "Plan workspace changes",
            status: "running",
          },
          {
            attentionLabel: "reply needed",
            id: "agent-2",
            label: "Reviewer",
            latestActivity: "waiting",
            roleOrTask: "Review output",
            status: "blocked",
          },
        ],
        attentionLabel: "reply needed",
        finalOutput: "Implementation summary ready.",
        id: "cowork-1",
        status: "running",
        taskProgress: "1/3",
        title: "Native chat parity",
        workflow: "Adaptive Starter",
      }],
      messages: [{
        author: "Tinybot",
        body: ["I started a Cowork run."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [],
      }],
      onCoworkAgentInspect: (selection) => selections.push(selection),
    });
    await nextTick();
    await nextTick();

    const surface = host.querySelector(".desktop-chat-cowork-surface");
    expect(surface?.getAttribute("data-desktop-chat-region")).toBe("chat-cowork-surface");
    expect(surface?.textContent).toContain("Cowork run");
    expect(surface?.textContent).toContain("Native chat parity");
    expect(surface?.textContent).toContain("Agents");
    expect(surface?.textContent).toContain("2");
    expect(surface?.textContent).toContain("Tasks");
    expect(surface?.textContent).toContain("1/3");
    expect(surface?.textContent).toContain("Final output");
    expect(surface?.textContent).toContain("Implementation summary ready.");

    host.querySelector<HTMLButtonElement>('[data-desktop-cowork-agent-id="agent-2"]')?.click();
    expect(selections).toEqual([{ agentId: "agent-2", sessionId: "cowork-1" }]);
    await nextTick();

    const inspector = host.querySelector<HTMLElement>(".desktop-cowork-agent-detail-panel");
    expect(inspector?.getAttribute("aria-label")).toBe("Cowork agent details");
    expect(inspector?.getAttribute("data-desktop-cowork-agent-id")).toBe("agent-2");
    expect(inspector?.textContent).toContain("Reviewer");
    expect(inspector?.textContent).toContain("Review output");
    expect(inspector?.textContent).toContain("reply needed");
    await flushDetailPanelOpeningMotion();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-cowork-agent-detail-visible")).toBe("true");

    vi.useFakeTimers();
    inspector?.querySelector<HTMLButtonElement>(".desktop-cowork-agent-detail-close")?.click();
    await nextTick();
    expect(host.querySelector(".desktop-cowork-agent-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("closing");
    vi.advanceTimersByTime(560);
    await nextTick();
    vi.useRealTimers();
    expect(host.querySelector(".desktop-cowork-agent-detail-panel")).toBeNull();
  });

  test("renders subagent shelf and opens trace inspector", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I spawned a greeter."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: JSON.stringify({
            task: "Say hello",
            trace: {
              steps: [{
                id: "tool:call-1:completed",
                kind: "tool_call",
                status: "completed",
                title: "say",
                summary: "Child tool say completed.",
                resultPreview: "你好",
              }],
            },
          }),
          approvalStatus: "",
          id: "delegate-1",
          kind: "result",
          name: "spawn",
          responseText: "你好",
          status: "completed",
        }],
      }],
    });
    await nextTick();
    await nextTick();

    const shelf = host.querySelector(".desktop-subagent-shelf");
    expect(shelf?.getAttribute("data-subagent-count")).toBe("1");
    expect(shelf?.getAttribute("data-subagent-shelf-layout")).toBe("composer-tray");
    expect(shelf?.getAttribute("data-subagent-shelf-placement")).toBe("composer-adjacent");
    expect(host.querySelector(".desktop-conversation-layout > .desktop-subagent-shelf")).toBeNull();
    expect(shelf?.parentElement).toBe(host.querySelector(".desktop-conversation-body-layout"));
    expect(shelf?.previousElementSibling).toBe(host.querySelector(".desktop-conversation-layout"));
    expect(shelf?.textContent).toContain("spawn");
    expect(shelf?.textContent).toContain("Completed");
    expect(shelf?.querySelector("[data-subagent-shelf-row]")).toBeTruthy();

    const cssText = document.getElementById("desktop-conversation-agent-flow-styles")?.textContent ?? "";
    const layoutRule = cssText.match(/\.desktop-conversation-layout,\n    body\.desktop-native-workbench \.desktop-conversation-layout \{([\s\S]*?)\}/)?.[1] ?? "";
    const shelfRule = cssText.match(/\.desktop-subagent-shelf \{([\s\S]*?)\}/)?.[1] ?? "";
    const nativeShelfRule = cssText.match(/body\.desktop-native-workbench \.desktop-subagent-shelf \{([\s\S]*?)\}/)?.[1] ?? "";
    const shelfListRule = cssText.match(/\.desktop-subagent-shelf-list \{([\s\S]*?)\}/)?.[1] ?? "";
    const shelfItemRule = cssText.match(/\.desktop-subagent-shelf-item \{([\s\S]*?)\}/)?.[1] ?? "";
    const shelfActivityRule = cssText.match(/\.desktop-subagent-shelf-activity \{([\s\S]*?)\}/)?.[1] ?? "";
    expect(layoutRule).toContain("grid-template-rows: minmax(0, 1fr);");
    expect(layoutRule).not.toContain("grid-row: 1;");
    expect(layoutRule).not.toContain("grid-column: 1;");
    expect(shelfRule).toContain("position: sticky;");
    expect(shelfRule).toContain("bottom: 0;");
    expect(shelfRule).toContain("border-radius: 18px 18px 0 0;");
    expect(shelfRule).toContain("justify-self: center;");
    expect(shelfRule).toContain("z-index: 2;");
    expect(nativeShelfRule).toContain("grid-row: 3;");
    expect(nativeShelfRule).toContain("width: min(calc(100% - 72px), calc(var(--desktop-chat-column-width, 920px) - 96px));");
    expect(shelfListRule).toContain("display: grid;");
    expect(shelfListRule).toContain("overflow-y: auto;");
    expect(shelfListRule).toContain("overflow-x: hidden;");
    expect(shelfItemRule).toContain("grid-template-columns: auto minmax(92px, .8fr) max-content minmax(0, 1.2fr);");
    expect(shelfItemRule).toContain("width: 100%;");
    expect(shelfActivityRule).not.toContain("grid-column:");

    shelf?.querySelector<HTMLButtonElement>("[data-subagent-shelf-item]")?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const inspector = host.querySelector(".desktop-delegate-detail-panel");
    expect(inspector?.getAttribute("aria-label")).toBe("Delegated agent details");
    expect(inspector?.textContent).toContain("Subagent timeline");
    expect(inspector?.textContent).toContain("say");
    expect(inspector?.textContent).toContain("你好");
  });

  test("groups delegated trace details into transcript tools approvals and context", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I observed a child agent."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "Spawn greeter",
          approvalStatus: "",
          delegatedTrace: {
            childRunId: "child-run-1",
            steps: [
              {
                id: "reasoning-1",
                kind: "reasoning",
                status: "completed",
                summary: "The child agent planned a short greeting.",
                title: "Thinking",
              },
              {
                argsPreview: "{\"text\":\"hello\"}",
                id: "tool-1",
                kind: "tool_call",
                resultPreview: "hello",
                status: "completed",
                summary: "Child tool say completed.",
                title: "say",
              },
              {
                approvalId: "approval-child-1",
                approvalStatus: "approved",
                id: "approval-1",
                kind: "approval",
                status: "approved",
                summary: "Child approval was granted.",
                title: "Approval checkpoint",
              },
              {
                id: "final-1",
                kind: "message",
                resultPreview: "hello",
                status: "completed",
                title: "Final response",
              },
              {
                id: "artifact-1",
                kind: "artifact",
                resultPreview: "notes/hello.md",
                status: "completed",
                summary: "Created notes/hello.md",
                title: "hello.md",
              },
            ],
            artifacts: [{
              id: "artifact-1",
              kind: "file",
              path: "notes/hello.md",
              summary: "Greeting note",
            }],
          },
          delegateId: "delegate-1",
          delegateTask: "Say hello",
          finalOutput: "hello",
          id: "delegate-1",
          kind: "result",
          name: "spawn_agent",
          responseText: "hello",
          status: "completed",
          traceRef: "child-run-1",
        }],
      }],
    });
    await nextTick();
    await nextTick();

    host.querySelector<HTMLButtonElement>("[data-subagent-shelf-item]")?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const inspector = host.querySelector(".desktop-delegate-detail-panel");
    expect(inspector?.textContent).toContain("Subagent timeline");
    expect(inspector?.textContent).toContain("Transcript");
    expect(inspector?.textContent).toContain("Tools");
    expect(inspector?.textContent).toContain("Approvals");
    expect(inspector?.textContent).toContain("Artifacts");
    expect(inspector?.textContent).toContain("Raw context");
    expect(inspector?.textContent).toContain("child-run-1");
    expect(inspector?.textContent).toContain("hello");

    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="transcript"]')?.click();
    await nextTick();
    expect(inspector?.querySelector('[data-subagent-observability-tab-panel="transcript"]')?.textContent)
      .toContain("The child agent planned a short greeting.");

    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="approvals"]')?.click();
    await nextTick();
    expect(inspector?.querySelector('[data-subagent-observability-tab-panel="approvals"]')?.textContent)
      .toContain("Child approval was granted.");

    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="artifacts"]')?.click();
    await nextTick();
    const artifactPanel = inspector?.querySelector('[data-subagent-observability-tab-panel="artifacts"]');
    expect(artifactPanel?.textContent).toContain("Greeting note");
    expect(artifactPanel?.textContent).toContain("notes/hello.md");
  });

  test("lazy loads persisted delegated trace when opening a subagent inspector", async () => {
    const host = document.createElement("section");
    const onDelegateTraceLoad = vi.fn(async () => ({
      delegateId: "delegate-1",
      traceRef: "child-run-1",
      events: [{
        event_id: "child-message-1",
        event_type: "agent.message",
        payload: {
          content: "child said hello",
        },
        status: "completed",
      }],
    }));

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I spawned a greeter."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "Say hello",
          approvalStatus: "",
          delegateId: "delegate-1",
          delegateTask: "Say hello",
          id: "delegate-1",
          kind: "result",
          name: "spawn_agent",
          responseText: "done",
          sessionKey: "WebSocket:chat-1",
          status: "completed",
          traceRef: "child-run-1",
        }],
      }],
      onDelegateTraceLoad,
    });
    await nextTick();

    host.querySelector<HTMLButtonElement>("[data-subagent-shelf-item]")?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();
    await nextTick();

    expect(onDelegateTraceLoad).toHaveBeenCalledWith({
      activityId: "delegate-1",
      delegateId: "delegate-1",
      sessionKey: "WebSocket:chat-1",
      traceRef: "child-run-1",
    });
    const inspector = host.querySelector(".desktop-delegate-detail-panel");
    expect(inspector?.textContent).toContain("Subagent timeline");
    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="transcript"]')?.click();
    await nextTick();
    expect(inspector?.querySelector('[data-subagent-observability-tab-panel="transcript"]')?.textContent)
      .toContain("child said hello");
  });

  test("renders subagent observability as switchable inspector tabs", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I observed a child agent."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "Spawn greeter",
          approvalStatus: "approved",
          delegatedTrace: {
            childRunId: "child-run-1",
            steps: [
              {
                id: "message-1",
                kind: "message",
                resultPreview: "child transcript output",
                status: "completed",
                title: "Assistant response",
              },
              {
                argsPreview: "{\"text\":\"hello\"}",
                id: "tool-1",
                kind: "tool_call",
                resultPreview: "tool result output",
                status: "completed",
                title: "say",
              },
              {
                approvalId: "approval-child-1",
                approvalStatus: "approved",
                id: "approval-1",
                kind: "approval",
                status: "approved",
                title: "Approval checkpoint",
              },
            ],
          },
          delegateId: "delegate-1",
          delegateTask: "Say hello",
          finalOutput: "child transcript output",
          id: "delegate-1",
          kind: "result",
          name: "spawn_agent",
          responseText: "done",
          status: "completed",
          traceRef: "child-run-1",
        }],
      }],
    });
    await nextTick();

    host.querySelector<HTMLButtonElement>("[data-subagent-shelf-item]")?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const inspector = host.querySelector(".desktop-delegate-detail-panel");
    const tabs = inspector?.querySelector('[role="tablist"][aria-label="Subagent observability"]');
    expect(tabs?.textContent).toContain("Overview");
    expect(tabs?.textContent).toContain("Transcript");
    expect(tabs?.textContent).toContain("Tools");
    expect(inspector?.querySelector('[data-subagent-observability-tab-panel="overview"]')?.textContent).toContain("child-run-1");

    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="transcript"]')?.click();
    await nextTick();

    const transcriptPanel = inspector?.querySelector('[data-subagent-observability-tab-panel="transcript"]');
    expect(transcriptPanel?.textContent).toContain("child transcript output");
    expect(transcriptPanel?.textContent).not.toContain("tool result output");
    expect(inspector?.querySelector('[data-subagent-observability-tab-panel="tools"]')).toBeNull();
  });

  test("lazy loads subagent artifacts from the inspector artifact tab", async () => {
    const host = document.createElement("section");
    const onArtifactLoad = vi.fn(async () => ({
      artifactId: "artifact-1",
      content: "# Artifact body\n\nchild artifact details",
      kind: "markdown",
      title: "hello.md",
    }));

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I observed a child artifact."],
        references: [],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "Spawn greeter",
          approvalStatus: "",
          delegatedTrace: {
            artifacts: [{
              id: "artifact-1",
              kind: "markdown",
              path: "notes/hello.md",
              summary: "Greeting note",
              title: "hello.md",
            }],
            childRunId: "child-run-1",
            steps: [],
          },
          delegateId: "delegate-1",
          delegateTask: "Say hello",
          id: "delegate-1",
          kind: "result",
          name: "spawn_agent",
          responseText: "done",
          sessionKey: "WebSocket:chat-1",
          status: "completed",
          traceRef: "child-run-1",
        }],
      }],
      onArtifactLoad,
    });
    await nextTick();

    host.querySelector<HTMLButtonElement>("[data-subagent-shelf-item]")?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const inspector = host.querySelector(".desktop-delegate-detail-panel");
    inspector?.querySelector<HTMLButtonElement>('[data-subagent-observability-tab="artifacts"]')?.click();
    await nextTick();

    inspector?.querySelector<HTMLButtonElement>('[data-subagent-artifact-id="artifact-1"]')?.click();
    await nextTick();
    await nextTick();

    expect(onArtifactLoad).toHaveBeenCalledWith({
      activityId: "delegate-1",
      artifactId: "artifact-1",
      delegateId: "delegate-1",
      sessionKey: "WebSocket:chat-1",
      traceRef: "child-run-1",
    });
    const artifactPanel = inspector?.querySelector('[data-subagent-observability-tab-panel="artifacts"]');
    expect(artifactPanel?.textContent).toContain("hello.md");
    expect(artifactPanel?.textContent).toContain("child artifact details");
  });

  test("keeps expanded agent flow groups from clipping step content", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Use a subagent"],
          references: [],
          time: "10:29 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          reasoningContent: "I should create a child agent.",
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [{
            approvalStatus: "",
            argsText: "{\"task\":\"Say hello\"}",
            id: "delegate-1",
            kind: "call",
            name: "spawn_agent",
            responseText: "",
            status: "running",
          }],
        },
        {
          author: "Tinybot",
          body: [],
          references: [],
          time: "10:32 AM",
          tone: "assistant",
          toolActivities: [{
            approvalStatus: "",
            argsText: "{\"target\":\"delegate-1\"}",
            id: "wait-1",
            kind: "result",
            name: "wait_agent",
            responseText: "The child agent returned a detailed result that should remain visible.",
            status: "completed",
          }],
        },
        {
          author: "Tinybot",
          body: ["Done"],
          references: [],
          time: "10:33 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const group = host.querySelector<HTMLDetailsElement>(".desktop-agent-flow-group");
    group!.open = true;
    group!.dispatchEvent(new Event("toggle"));
    await nextTick();

    const cssText = document.getElementById("desktop-conversation-agent-flow-styles")?.textContent ?? "";
    const groupRule = cssText.match(/\.desktop-assistant-step-group\.desktop-agent-flow-group,[\s\S]*?body\.desktop-native-workbench \.desktop-assistant-step-group\.desktop-agent-flow-group \{([\s\S]*?)\}/)?.[1] ?? "";
    const stepListRule = cssText.match(/\.desktop-agent-flow-step-list,[\s\S]*?body\.desktop-native-workbench \.desktop-agent-flow-step-list\.desktop-assistant-step-list \{([\s\S]*?)\}/)?.[1] ?? "";
    const firstStep = host.querySelector<HTMLElement>(".desktop-agent-flow-step");
    const stepList = host.querySelector<HTMLElement>(".desktop-agent-flow-step-list");
    Object.defineProperty(stepList, "scrollHeight", { configurable: true, value: 480 });
    group!.dispatchEvent(new Event("toggle"));
    await nextTick();

    expect(group!.style.getPropertyValue("--desktop-agent-flow-content-height")).toBe("480px");
    expect(firstStep?.getAttribute("style")).toContain("--desktop-agent-flow-step-index: 0");
    expect(groupRule).toContain("display: block;");
    expect(groupRule).toContain("align-self: start;");
    expect(groupRule).not.toContain("display: grid;");
    expect(groupRule).not.toContain("grid-template-rows:");
    expect(groupRule).toContain("overflow: visible;");
    expect(groupRule).not.toContain("overflow: hidden;");
    expect(stepListRule).toContain("position: static;");
    expect(stepListRule).toContain("contain: none;");
    expect(stepListRule).toContain("transition:");
    expect(stepListRule).toContain("max-height 300ms");
    expect(stepListRule).toContain("opacity 220ms");
    expect(stepListRule).toContain("transform 300ms");
    expect(cssText).toMatch(/\.desktop-agent-flow-group\[open\] \.desktop-agent-flow-step-list[\s\S]*max-height:\s*var\(--desktop-agent-flow-content-height, 1200px\);/);
    expect(cssText).toMatch(/\.desktop-agent-flow-group\[open\] \.desktop-agent-flow-step,[\s\S]*body\.desktop-native-workbench \.desktop-agent-flow-group\[open\] \.desktop-agent-flow-step[\s\S]*animation-delay:\s*calc\(var\(--desktop-agent-flow-step-index, 0\) \* 55ms\);/);
    expect(cssText).toMatch(/\.desktop-agent-flow-step[\s\S]*overflow:\s*visible;/);
    expect(cssText).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.desktop-agent-flow-step-list/);
  });

  test("dispatches memory reference inspection from reference cards", async () => {
    const host = document.createElement("section");
    const inspections: unknown[] = [];

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I used memory."],
        references: [{
          detail: "Saved preference",
          kind: "memory",
          title: "memory/MEMORY.md:42",
        }],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [],
      }],
      onReferenceInspect: (reference) => inspections.push(reference),
    });
    await nextTick();
    await nextTick();

    const reference = host.querySelector<HTMLElement>(".desktop-message-reference-item");
    expect(reference?.getAttribute("role")).toBe("button");
    expect(reference?.getAttribute("tabindex")).toBe("0");
    reference?.click();

    expect(inspections).toEqual([{
      detail: "Saved preference",
      kind: "memory",
      title: "memory/MEMORY.md:42",
    }]);
    await nextTick();

    const panel = host.querySelector<HTMLElement>(".desktop-reference-detail-panel");
    expect(panel?.getAttribute("aria-label")).toBe("Reference details");
    expect(panel?.textContent).toContain("memory/MEMORY.md:42");
    expect(panel?.textContent).toContain("Saved preference");
    await flushDetailPanelOpeningMotion();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-reference-detail-visible")).toBe("true");

    vi.useFakeTimers();
    panel?.querySelector<HTMLButtonElement>(".desktop-reference-detail-close")?.click();
    await nextTick();
    expect(host.querySelector(".desktop-reference-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("closing");
    vi.advanceTimersByTime(560);
    await nextTick();
    vi.useRealTimers();
    expect(host.querySelector(".desktop-reference-detail-panel")).toBeNull();
  });

  test("shows memory reference source path and highlighted original text in the right detail panel", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I used memory."],
        references: [{
          detail: "Use uv for Python commands.",
          kind: "memory",
          noteId: "note_1",
          rawLine: 4,
          rawPath: "memory/notes.jsonl",
          scope: "project",
          sourceLine: 18,
          sourcePath: "memory/MEMORY.md",
          sourceText: "Use uv for Python commands.",
          title: "note_1",
          type: "instruction",
        }],
        time: "10:30 AM",
        tone: "assistant",
        toolActivities: [],
      }],
    });
    await nextTick();
    await nextTick();

    host.querySelector<HTMLElement>(".desktop-message-reference-item")?.click();
    await nextTick();

    const panel = host.querySelector<HTMLElement>(".desktop-reference-detail-panel");
    expect(panel?.getAttribute("data-tool-detail-mode")).toBe("push");
    expect(panel?.textContent).toContain("memory/MEMORY.md:18");
    expect(panel?.textContent).toContain("memory/notes.jsonl:4");
    expect(panel?.textContent).toContain("project");
    expect(panel?.textContent).toContain("instruction");
    const highlighted = panel?.querySelector<HTMLElement>(".desktop-reference-source-line.highlighted");
    expect(highlighted?.getAttribute("data-line")).toBe("18");
    expect(highlighted?.textContent).toContain("Use uv for Python commands.");
  });

  test("updates streamed messages without remounting the thread root", async () => {
    const host = document.createElement("section");

    const mounted = mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [],
    });
    await nextTick();

    mounted.update({
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.textContent).toContain("first chunk");
    const firstAssistant = host.querySelectorAll(".desktop-conversation-message")[1];

    mounted.update({
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk second chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.textContent).toContain("first chunk second chunk");
    expect(host.querySelectorAll(".desktop-conversation-message")[1]).toBe(firstAssistant);
  });

  test("restores conversation timeline scroll after streamed updates", async () => {
    const host = document.createElement("section");

    const mounted = mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const timeline = host.querySelector<HTMLElement>(".desktop-conversation-timeline");
    expect(timeline).not.toBeNull();
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 500 });
    timeline!.scrollTop = 420;

    mounted.update({
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk second chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    timeline!.scrollTop = 0;
    await nextTick();
    await nextTick();

    expect(host.querySelector<HTMLElement>(".desktop-conversation-timeline")?.scrollTop).toBe(420);
  });

  test("does not override user scrolling after a streamed update queues restoration", async () => {
    const host = document.createElement("section");

    const mounted = mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const timeline = host.querySelector<HTMLElement>(".desktop-conversation-timeline");
    expect(timeline).not.toBeNull();
    Object.defineProperty(timeline, "scrollHeight", { configurable: true, value: 1200 });
    Object.defineProperty(timeline, "clientHeight", { configurable: true, value: 500 });
    timeline!.scrollTop = 420;

    mounted.update({
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Stream this"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["first chunk second chunk"],
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    timeline!.scrollTop = 120;
    timeline!.dispatchEvent(new Event("scroll"));
    await nextTick();
    await nextTick();

    expect(host.querySelector<HTMLElement>(".desktop-conversation-timeline")?.scrollTop).toBe(120);
  });

  test("collapses completed assistant process steps in event order before the final answer", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["List the workspace"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          reasoningContent: "I should inspect the workspace.",
          references: [],
          time: "10:30 AM",
          tone: "assistant",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [{
            approvalStatus: "",
            argsText: "{\"path\":\".\"}",
            id: "tool-list",
            kind: "call",
            name: "list_dir",
            responseText: "workspace files",
            status: "completed",
          }],
        },
        {
          author: "Tinybot",
          body: [],
          reasoningContent: "I found a few top-level entries and will inspect them.",
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [{
            approvalStatus: "",
            argsText: "{\"path\":\"apps\"}",
            id: "tool-apps",
            kind: "call",
            name: "list_dir",
            responseText: "apps files",
            status: "completed",
          }],
        },
        {
          author: "Tinybot",
          body: ["The workspace contains `apps`, `tinybot`, and `tests`."],
          reasoningContent: "I have enough context to answer.",
          references: [{ detail: "workspace", kind: "File", title: "." }],
          time: "10:32 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const summaries = host.querySelectorAll(".desktop-assistant-step-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.textContent).toContain("Processed");
    expect(summaries[0]?.textContent).toContain("5 steps");
    expect(host.textContent).toContain("The workspace contains");
    expect(host.querySelector(".desktop-conversation-reference")?.textContent).toContain("File: .");
    expect(host.querySelectorAll(".desktop-conversation-meta strong")).toHaveLength(0);

    const details = host.querySelector<HTMLDetailsElement>(".desktop-assistant-step-group");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("I should inspect the workspace.");
    expect(details?.textContent).toContain("I found a few top-level entries");
    expect(details?.textContent).toContain("list_dir");
    expect(details?.textContent).toContain("I have enough context to answer.");
    expect(details?.querySelectorAll(".desktop-tool-activity")).toHaveLength(2);
    details!.open = true;
    details?.dispatchEvent(new Event("toggle"));
    await nextTick();

    const processEntries = Array.from(details!.querySelectorAll<HTMLElement>(
      ".desktop-message-reasoning-body, .desktop-tool-activity-title",
    )).map((entry) => entry.textContent);
    expect(processEntries).toEqual([
      "I should inspect the workspace.",
      "list_dir",
      "I found a few top-level entries and will inspect them.",
      "list_dir",
      "I have enough context to answer.",
    ]);
    const toolRow = details!.querySelector<HTMLElement>(".desktop-tool-activity");
    expect(toolRow?.closest(".desktop-assistant-step-group")).toBe(details);
    expect(Array.from(details!.querySelectorAll(".desktop-message-reasoning-toggle")).map((button) => button.textContent)).toEqual([
      "Thinking",
      "Thinking",
      "Thinking complete",
    ]);
    const finalAnswer = Array.from(host.querySelectorAll<HTMLElement>(".desktop-conversation-message"))
      .find((message) => message.textContent?.includes("The workspace contains"));
    const assistantRunGroup = host.querySelector<HTMLElement>(".desktop-assistant-run-group");
    expect(assistantRunGroup).toBeTruthy();
    expect(details?.closest(".desktop-assistant-run-group")).toBe(assistantRunGroup);
    expect(finalAnswer?.closest(".desktop-assistant-run-group")).toBe(assistantRunGroup);
    expect(details && finalAnswer ? details.compareDocumentPosition(finalAnswer) & Node.DOCUMENT_POSITION_FOLLOWING : 0).not.toBe(0);
    expect(finalAnswer?.querySelector(".desktop-message-reasoning-toggle")).toBeNull();
    expect(host.querySelectorAll(".desktop-message-copy-button")).toHaveLength(1);
    expect(host.querySelector(".desktop-assistant-step-group .desktop-message-copy-button")).toBeNull();
  });

  test("collapses inline process content restored as one assistant final message", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Use subagent"],
          references: [],
          time: "10:31 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: ["我会等待审批后继续。"],
          reasoningContent: "The subagent needs approval before it can continue.",
          references: [],
          time: "10:32 AM",
          tone: "assistant",
          toolActivities: [{
            approvalId: "approval-1",
            approvalStatus: "approval_required",
            argsText: "spawn({\"task\":\"say hi\"})",
            id: "call-spawn",
            kind: "result",
            name: "spawn",
            responseText: "Waiting for approval.",
            status: "blocked",
          }],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const summaries = host.querySelectorAll(".desktop-assistant-step-summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.textContent).toContain("Processed");
    expect(summaries[0]?.textContent).toContain("1 step");
    expect(summaries[0]?.textContent).toContain("1 delegated agent call");
    const details = host.querySelector<HTMLDetailsElement>(".desktop-assistant-step-group");
    expect(details?.textContent).toContain("The subagent needs approval");
    expect(details?.querySelectorAll(".desktop-tool-activity")).toHaveLength(1);
    const injectedStyles = document.getElementById("desktop-conversation-agent-flow-styles")?.textContent ?? "";
    expect(injectedStyles).toContain("body.desktop-native-workbench .desktop-conversation-layout");
    expect(injectedStyles).toContain("height: auto");
    expect(injectedStyles).toContain("max-height: none");
    expect(injectedStyles).toContain("overflow: hidden");
    expect(injectedStyles).toContain("minmax(0, auto)");
    expect(injectedStyles).toContain("display: flex");
    expect(injectedStyles).toContain("flex-direction: column");
    expect(injectedStyles).toContain("flex: 0 0 auto");
    expect(injectedStyles).not.toContain("animation: desktopAgentFlowEnter");
    expect(injectedStyles).toContain("body.desktop-native-workbench .desktop-assistant-step-group.desktop-agent-flow-group");
    expect(injectedStyles).toContain("body.desktop-native-workbench .desktop-agent-flow-step-card");
    const finalAnswer = Array.from(host.querySelectorAll<HTMLElement>(".desktop-conversation-message"))
      .find((message) => message.textContent?.includes("我会等待审批后继续。"));
    expect(finalAnswer?.querySelector(".desktop-message-reasoning-toggle")).toBeNull();
    expect(finalAnswer?.querySelector(".desktop-tool-activity")).toBeNull();
  });

  test("keeps active assistant work visible until a final answer exists", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["List the workspace"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          reasoningContent: "I am checking files.",
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [{
            approvalStatus: "",
            argsText: "{\"path\":\".\"}",
            id: "tool-active",
            kind: "call",
            name: "list_dir",
            responseText: "",
            status: "pending",
          }],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.querySelector(".desktop-assistant-step-summary")).toBeNull();
    expect(host.textContent).toContain("I am checking files.");
    expect(host.textContent).toContain("list_dir");
  });

  test("opens a tool detail panel from the right before closing it from outside click", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I used a tool."],
        references: [],
        time: "10:31 AM",
        tone: "assistant",
        toolActivities: [{
          approvalStatus: "",
          argsText: "{\"path\":\"README.md\"}",
          id: "tool-read",
          kind: "call",
          name: "read_file",
          responseText: "{\"ok\":true}",
          runChainItemKey: "assistant-1:tool-read",
          sessionKey: "WebSocket:chat-1",
          status: "running",
        }],
      }],
    });
    await nextTick();
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="tool-read"] .desktop-tool-activity-row')?.click();
    await nextTick();

    const layout = host.querySelector<HTMLElement>(".desktop-conversation-layout");
    const timeline = host.querySelector<HTMLElement>(".desktop-conversation-timeline");
    expect(layout?.getAttribute("data-detail-panel-state")).toBe("opening");
    expect(layout?.getAttribute("data-tool-detail-visible")).toBe("false");
    expect(host.querySelector(".desktop-detail-panel-slot")?.getAttribute("data-detail-panel-state")).toBe("opening");
    expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("opening");

    await flushDetailPanelOpeningMotion();

    expect(layout?.getAttribute("data-detail-panel-state")).toBe("open");
    expect(host.querySelector(".desktop-conversation-body-layout")?.getAttribute("data-detail-panel-mode")).toBe("push");
    expect(layout?.getAttribute("data-tool-detail-visible")).toBe("true");
    expect(host.querySelector(".desktop-detail-panel-slot")?.getAttribute("data-detail-panel-state")).toBe("open");
    expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("open");

    vi.useFakeTimers();
    try {
      timeline?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await nextTick();

      expect(layout?.getAttribute("data-detail-panel-state")).toBe("closing");
      expect(layout?.getAttribute("data-tool-detail-visible")).toBe("false");
      expect(host.querySelector(".desktop-detail-panel-slot")?.getAttribute("data-detail-panel-state")).toBe("closing");
      expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("closing");

      vi.advanceTimersByTime(420);
      await nextTick();
      expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("closing");

      vi.advanceTimersByTime(140);
      await nextTick();
      expect(host.querySelector(".desktop-tool-detail-panel")).toBeNull();
      expect(layout?.getAttribute("data-detail-panel-state")).toBe("closed");
    } finally {
      vi.useRealTimers();
    }
  });

  test("opens one resizable tool detail panel and switches selected tool rows", async () => {
    const host = document.createElement("section");
    const approvals: unknown[] = [];
    host.addEventListener("desktop-tool-approval-action", (event) => {
      approvals.push((event as CustomEvent).detail);
    });

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "Tinybot",
          body: ["I used tools."],
          references: [],
          time: "10:31 AM",
          tone: "assistant",
          toolActivities: [
            {
              approvalId: "approval-1",
              approvalStatus: "approval_required",
              argsText: "{\"path\":\"README.md\"}",
              id: "tool-read",
              kind: "call",
              name: "read_file",
              responseText: "{\"ok\":true}",
              runChainItemKey: "assistant-1:tool-read",
              sessionKey: "WebSocket:chat-1",
              status: "blocked",
            },
            {
              approvalStatus: "",
              argsText: "{\"command\":\"npm test\"}",
              id: "tool-shell",
              kind: "result",
              name: "shell_exec",
              responseText: "failed",
              status: "failed",
            },
          ],
        },
      ],
    });
    await nextTick();
    await nextTick();

    expect(host.querySelector(".desktop-tool-detail-panel")).toBeNull();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-tool-detail-visible")).toBe("false");
    expect(host.querySelector<HTMLElement>(".desktop-conversation-layout")?.style.getPropertyValue("--desktop-tool-detail-width")).toBe("");

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="tool-read"] .desktop-tool-activity-row')?.click();
    await nextTick();

    const panel = host.querySelector<HTMLElement>(".desktop-tool-detail-panel");
    await flushDetailPanelOpeningMotion();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-tool-detail-visible")).toBe("true");
    expect(host.querySelector<HTMLElement>(".desktop-conversation-layout")?.style.getPropertyValue("--desktop-tool-detail-width")).toBe("50%");
    expect(panel?.getAttribute("aria-label")).toBe("Tool call details");
    expect(panel?.getAttribute("data-tool-detail-mode")).toBe("push");
    expect(panel?.closest(".desktop-conversation-layout")).toBeNull();
    expect(host.querySelector(".desktop-conversation-layout > .desktop-detail-panel-slot")).toBeNull();
    expect(host.querySelector(".desktop-conversation-body-layout > .desktop-detail-panel-slot")).toBe(panel?.parentElement);
    expect(panel?.textContent).toContain("read_file");
    expect(panel?.textContent).toContain("Pending approval");
    expect(panel?.textContent).toContain("\"path\": \"README.md\"");
    expect(panel?.textContent).toContain("\"ok\": true");
    expect(panel?.textContent).toContain("approval-1");
    expect(panel?.textContent).toContain("WebSocket:chat-1");
    expect(panel?.textContent).toContain("No stderr available");
    expect(panel?.textContent).toContain("Duration unavailable");
    expect(host.querySelector('[data-desktop-tool-activity-id="tool-read"] .desktop-tool-activity-row')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelectorAll(".desktop-tool-detail-panel")).toHaveLength(1);

    panel?.querySelector<HTMLButtonElement>('[data-desktop-approval-action="approveOnce"]')?.click();
    panel?.querySelector<HTMLButtonElement>('[data-desktop-approval-action="approveSession"]')?.click();
    panel?.querySelector<HTMLButtonElement>('[data-desktop-approval-action="deny"]')?.click();
    expect(approvals).toEqual([
      { action: "approveOnce", approvalId: "approval-1", runChainItemKey: "assistant-1:tool-read", sessionKey: "WebSocket:chat-1", toolActivityId: "tool-read", toolName: "read_file" },
      { action: "approveSession", approvalId: "approval-1", runChainItemKey: "assistant-1:tool-read", sessionKey: "WebSocket:chat-1", toolActivityId: "tool-read", toolName: "read_file" },
      { action: "deny", approvalId: "approval-1", runChainItemKey: "assistant-1:tool-read", sessionKey: "WebSocket:chat-1", toolActivityId: "tool-read", toolName: "read_file" },
    ]);

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="tool-shell"] .desktop-tool-activity-row')?.click();
    await nextTick();
    expect(host.querySelector(".desktop-tool-detail-panel")?.textContent).toContain("shell_exec");
    expect(host.querySelector(".desktop-tool-detail-panel")?.textContent).not.toContain("approval-1");
    expect(host.querySelector('[data-desktop-tool-activity-id="tool-read"] .desktop-tool-activity-row')?.getAttribute("aria-selected")).toBe("false");
    expect(host.querySelector('[data-desktop-tool-activity-id="tool-shell"] .desktop-tool-activity-row')?.getAttribute("aria-selected")).toBe("true");
    expect(host.querySelectorAll(".desktop-tool-detail-panel")).toHaveLength(1);

    vi.useFakeTimers();
    host.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await nextTick();
    expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("closing");
    vi.advanceTimersByTime(560);
    await nextTick();
    vi.useRealTimers();
    expect(host.querySelector(".desktop-tool-detail-panel")).toBeNull();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-tool-detail-visible")).toBe("false");
    expect(host.querySelector<HTMLElement>(".desktop-conversation-layout")?.style.getPropertyValue("--desktop-tool-detail-width")).toBe("");
  });

  test("renders delegated workflow and artifact inspector rows with safe previews", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: ["I coordinated extra work."],
        references: [],
        time: "10:31 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "Review implementation",
          approvalStatus: "",
          id: "delegate-cowork",
          kind: "call",
          name: "Cowork: Review implementation",
          responseText: "2 agents active",
          runChainItemKey: "turn-1:delegate-cowork",
          status: "running",
        }, {
          argsText: "",
          approvalStatus: "",
          id: "artifact-output",
          kind: "result",
          name: "Artifact: npm test",
          responseText: "<script>alert(1)</script> api_key=secret",
          runChainItemKey: "turn-1:artifact-output",
          status: "completed",
        }],
      }],
    });
    await nextTick();
    await nextTick();

    expect(host.textContent).toContain("Cowork: Review implementation");
    expect(host.textContent).toContain("Artifact: npm test");

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="artifact-output"] .desktop-tool-activity-row')?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const panel = host.querySelector<HTMLElement>(".desktop-tool-detail-panel");
    expect(panel?.getAttribute("aria-label")).toBe("Artifact details");
    expect(panel?.getAttribute("data-inspector-kind")).toBe("artifact");
    expect(panel?.textContent).toContain("Artifact: npm test");
    expect(panel?.textContent).not.toContain("<script>");
    expect(panel?.textContent).not.toContain("api_key=secret");
    expect(panel?.textContent).toContain("[unsafe omitted]");
    expect(panel?.textContent).toContain("[redacted]");

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="delegate-cowork"] .desktop-tool-activity-row')?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const delegatePanel = host.querySelector<HTMLElement>(".desktop-tool-detail-panel");
    expect(delegatePanel?.getAttribute("aria-label")).toBe("Delegated agent details");
    expect(delegatePanel?.getAttribute("data-inspector-kind")).toBe("delegate");
    expect(delegatePanel?.textContent).toContain("Review implementation");
    expect(delegatePanel?.textContent).toContain("2 agents active");
  });

  test("shows approval actions for pending delegated tool details", async () => {
    const host = document.createElement("section");
    const approvals: unknown[] = [];
    host.addEventListener("desktop-tool-approval-action", (event) => {
      approvals.push((event as CustomEvent).detail);
    });

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: [],
        references: [],
        time: "10:31 AM",
        tone: "assistant",
        toolActivities: [{
          approvalId: "approval-spawn",
          approvalStatus: "approval_required",
          argsText: "{\"task\":\"say hello\",\"agent_kind\":\"spawn\"}",
          id: "call-spawn",
          kind: "result",
          name: "spawn",
          responseText: "Waiting for approval.",
          runChainItemKey: "turn-1:call-spawn",
          sessionKey: "WebSocket:chat-1",
          status: "blocked",
        }],
      }],
    });
    await nextTick();
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="call-spawn"] .desktop-tool-activity-row')?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const panel = host.querySelector<HTMLElement>(".desktop-tool-detail-panel");
    expect(panel?.getAttribute("aria-label")).toBe("Delegated agent details");
    expect(panel?.getAttribute("data-inspector-kind")).toBe("delegate");
    expect(panel?.getAttribute("data-agent-call-kind")).toBe("spawn");
    expect(panel?.textContent).toContain("Pending approval");
    expect(panel?.textContent).toContain("Spawned agent workflow");
    expect(Array.from(panel?.querySelectorAll("[data-desktop-approval-action]") ?? []).map((button) => button.getAttribute("data-desktop-approval-action"))).toEqual([
      "approveOnce",
      "approveSession",
      "deny",
    ]);

    panel?.querySelector<HTMLButtonElement>('[data-desktop-approval-action="approveOnce"]')?.click();
    expect(approvals).toEqual([{
      action: "approveOnce",
      approvalId: "approval-spawn",
      runChainItemKey: "turn-1:call-spawn",
      sessionKey: "WebSocket:chat-1",
      toolActivityId: "call-spawn",
      toolName: "spawn",
    }]);
  });

  test("windows very large timelines and keeps the latest visible nodes", async () => {
    const host = document.createElement("section");
    const messages = Array.from({ length: 340 }, (_, index) => ({
      author: index % 2 === 0 ? "You" : "Tinybot",
      body: [`Message ${index}`],
      references: [],
      time: "10:31 AM",
      tone: index % 2 === 0 ? "user" as const : "assistant" as const,
      toolActivities: [],
    }));

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages,
    });
    await nextTick();
    await nextTick();

    const timeline = host.querySelector<HTMLElement>(".desktop-conversation-timeline");
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-large-timeline-windowed")).toBe("true");
    expect(timeline?.getAttribute("data-total-node-count")).toBe("340");
    expect(timeline?.getAttribute("data-rendered-node-count")).toBe("301");
    expect(host.querySelector(".desktop-conversation-large-window-placeholder")?.getAttribute("data-omitted-node-count")).toBe("40");
    expect(host.textContent).not.toContain("Message 0");
    expect(host.textContent).toContain("Message 339");
  });

  test("respects reduced motion for inspector transitions", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    }));
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [{
        author: "Tinybot",
        body: [],
        references: [],
        time: "10:31 AM",
        tone: "assistant",
        toolActivities: [{
          argsText: "npm test",
          approvalStatus: "",
          id: "tool-shell",
          kind: "call",
          name: "shell",
          responseText: "",
          runChainItemKey: "turn-1:tool-shell",
          status: "running",
        }],
      }],
    });
    await nextTick();

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="tool-shell"] .desktop-tool-activity-row')?.click();
    await nextTick();

    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-reduced-motion")).toBe("true");
    expect(host.querySelector(".desktop-tool-detail-panel")?.getAttribute("data-tool-detail-motion")).toBe("open");

    const css = readFileSync("src/styles.css", "utf8");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition: none !important");

    window.matchMedia = originalMatchMedia;
  });
});
