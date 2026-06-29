// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
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

describe("conversation thread agent flow rendering", () => {
  test("renders delegated subagent workflow in the tool detail panel", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Review desktop chat"],
          references: [],
          time: "10:30 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          reasoningContent: "I will delegate a focused review.",
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
            argsText: JSON.stringify({
              agent_kind: "subagent",
              agents: [{ id: "reviewer", role: "Reviewer", status: "running" }],
              session_id: "subagent-42",
              steps: [
                { agent: "Reviewer", detail: "Trace conversationThreadIsland", status: "done", title: "Inspect chat renderer" },
                { agent: "Reviewer", detail: "Summarize UX and code risks", status: "pending", title: "Report risks" },
              ],
              task: "Review the desktop chat agent flow",
              workflow: "Focused reviewer",
            }),
            id: "subagent-review",
            kind: "call",
            name: "subagent_delegate",
            responseText: JSON.stringify({
              events: [{ agent: "Reviewer", event: "handoff", message: "Reviewer accepted the task", status: "running" }],
              status: "running",
            }),
            status: "running",
          }],
        },
        {
          author: "Tinybot",
          body: ["The delegated review is running."],
          references: [],
          time: "10:32 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const group = host.querySelector<HTMLDetailsElement>(".desktop-agent-flow-group");
    expect(group?.open).toBe(false);
    expect(group?.textContent).toContain("Processed");
    expect(group?.textContent).toContain("Subagent");
    expect(group?.getAttribute("data-agent-flow-delegated-count")).toBe("1");
    group!.open = true;

    host.querySelector<HTMLButtonElement>('[data-desktop-tool-activity-id="subagent-review"] .desktop-tool-activity-row')?.click();
    await nextTick();
    await flushDetailPanelOpeningMotion();

    const panel = host.querySelector<HTMLElement>(".desktop-tool-detail-panel");
    expect(panel?.getAttribute("data-agent-call-kind")).toBe("subagent");
    expect(panel?.textContent).toContain("Agent workflow");
    expect(panel?.textContent).toContain("Delegated subagent workflow");
    expect(panel?.textContent).toContain("Independent subagent context");
    expect(panel?.textContent).toContain("Review the desktop chat agent flow");
    expect(panel?.textContent).toContain("Focused reviewer");
    expect(panel?.textContent).toContain("Inspect chat renderer");
    expect(panel?.textContent).toContain("Reviewer");
    expect(panel?.textContent).toContain("Report risks");
  });

  test("classifies cowork and agent-team calls in the collapsed flow labels", async () => {
    const host = document.createElement("section");

    mountConversationThreadIsland(host, {
      emptyMessage: "",
      messages: [
        {
          author: "You",
          body: ["Plan a release"],
          references: [],
          time: "11:00 AM",
          tone: "user",
          toolActivities: [],
        },
        {
          author: "Tinybot",
          body: [],
          references: [],
          time: "11:01 AM",
          tone: "assistant",
          toolActivities: [
            {
              approvalStatus: "",
              argsText: JSON.stringify({ task: "Parallel release checks", workflow: "team" }),
              id: "team-call",
              kind: "call",
              name: "agent_team_run",
              responseText: "",
              status: "pending",
            },
            {
              approvalStatus: "",
              argsText: JSON.stringify({ task: "Coordinate implementation" }),
              id: "cowork-call",
              kind: "call",
              name: "cowork",
              responseText: "",
              status: "pending",
            },
          ],
        },
        {
          author: "Tinybot",
          body: ["Release planning is underway."],
          references: [],
          time: "11:02 AM",
          tone: "assistant",
          toolActivities: [],
        },
      ],
    });
    await nextTick();
    await nextTick();

    const group = host.querySelector(".desktop-agent-flow-group");
    expect(group?.textContent).toContain("Agent team");
    expect(group?.textContent).toContain("Cowork");
    expect(group?.getAttribute("data-agent-flow-delegated-count")).toBe("2");
    expect(group?.getAttribute("data-agent-flow-tool-count")).toBe("2");
  });
});
