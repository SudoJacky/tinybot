// @vitest-environment happy-dom

import { describe, expect, test } from "vitest";
import { nextTick } from "vue";
import { mountConversationThreadIsland } from "./conversationThreadIsland";

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

  test("collapses completed assistant intermediate steps behind the final answer", async () => {
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
          body: ["I found a few top-level entries and will inspect them."],
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
          body: ["The workspace contains `apps`, `tinybot`, and `tests`."],
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
    expect(summaries[0]?.textContent).toContain("2 steps");
    expect(host.textContent).toContain("The workspace contains");
    expect(host.querySelector(".desktop-conversation-reference")?.textContent).toContain("File: .");
    expect(host.querySelectorAll(".desktop-conversation-meta strong")).toHaveLength(0);

    const details = host.querySelector<HTMLDetailsElement>(".desktop-assistant-step-group");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("I should inspect the workspace.");
    expect(details?.textContent).toContain("I found a few top-level entries");
    expect(details?.textContent).toContain("list_dir");
    details!.open = true;
    details?.dispatchEvent(new Event("toggle"));
    await nextTick();

    expect(host.textContent).toContain("I should inspect the workspace.");
    expect(host.textContent).toContain("list_dir");
    expect(host.querySelectorAll(".desktop-message-copy-button")).toHaveLength(1);
    expect(host.querySelector(".desktop-assistant-step-group .desktop-message-copy-button")).toBeNull();
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
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-tool-detail-visible")).toBe("true");
    expect(host.querySelector<HTMLElement>(".desktop-conversation-layout")?.style.getPropertyValue("--desktop-tool-detail-width")).toBe("50%");
    expect(panel?.getAttribute("aria-label")).toBe("Tool call details");
    expect(panel?.getAttribute("data-tool-detail-mode")).toBe("push");
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

    host.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    await nextTick();
    expect(host.querySelector(".desktop-tool-detail-panel")).toBeNull();
    expect(host.querySelector(".desktop-conversation-layout")?.getAttribute("data-tool-detail-visible")).toBe("false");
    expect(host.querySelector<HTMLElement>(".desktop-conversation-layout")?.style.getPropertyValue("--desktop-tool-detail-width")).toBe("");
  });
});
