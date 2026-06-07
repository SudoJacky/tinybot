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
    expect(Array.from(host.querySelectorAll(".desktop-conversation-meta strong")).map((author) => author.textContent)).toEqual([
      "You",
      "Tinybot",
    ]);
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
});
