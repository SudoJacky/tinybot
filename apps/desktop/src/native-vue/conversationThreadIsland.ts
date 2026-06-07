import { createApp, defineComponent, h, ref, type App, type Ref } from "vue";
import { NConfigProvider, NEmpty } from "naive-ui";
import type { AgentUiForm } from "../agentUiEvents";
import { logDesktopNativeChatDebug, summarizeDebugText } from "../desktopNativeChatDebug";
import { desktopNaiveThemeOverrides } from "./desktopNaiveTheme";
import { renderAgentUiFormCardChildren } from "./agentUiFormCardIsland";
import { renderConversationMessageChildren, type ConversationMessageIslandOptions } from "./conversationMessageIsland";

export interface ConversationThreadIslandOptions {
  emptyMessage: string;
  inlineForms?: AgentUiForm[];
  messages: ConversationMessageIslandOptions[];
  onInlineFormCancel?: (form: AgentUiForm) => void;
  onInlineFormSubmit?: (form: AgentUiForm, values: Record<string, unknown>) => void;
}

export interface MountedConversationThreadIsland {
  update: (options: ConversationThreadIslandOptions) => void;
  unmount: () => void;
}

const mountedConversationThreads = new WeakMap<HTMLElement, MountedConversationThreadIsland>();

export function mountOrUpdateConversationThreadIsland(
  host: HTMLElement,
  options: ConversationThreadIslandOptions,
): MountedConversationThreadIsland {
  logDesktopNativeChatDebug("vue.thread.update", summarizeConversationThreadOptions(options));
  const mounted = mountedConversationThreads.get(host);
  if (mounted) {
    mounted.update(options);
    return mounted;
  }
  const nextMounted = mountConversationThreadIsland(host, options);
  mountedConversationThreads.set(host, nextMounted);
  return nextMounted;
}

function summarizeConversationThreadOptions(options: ConversationThreadIslandOptions): Record<string, unknown> {
  return {
    emptyMessage: options.emptyMessage,
    messageCount: options.messages.length,
    messages: options.messages.slice(-2).map((message) => ({
      body: summarizeDebugText(message.body.join("\n")),
      reasoning: summarizeDebugText(message.reasoningContent),
      tone: message.tone,
      toolActivities: message.toolActivities?.length ?? 0,
    })),
  };
}

export function mountConversationThreadIsland(
  host: HTMLElement,
  options: ConversationThreadIslandOptions,
): MountedConversationThreadIsland {
  applyHostContract(host);
  const state = ref(options);
  const app = createConversationThreadApp(state);
  app.mount(host);
  return {
    update: (nextOptions) => {
      applyHostContract(host);
      state.value = nextOptions;
    },
    unmount: () => {
      mountedConversationThreads.delete(host);
      app.unmount();
      host.replaceChildren();
    },
  };
}

function createConversationThreadApp(state: Ref<ConversationThreadIslandOptions>): App {
  return createApp(defineComponent({
    name: "ConversationThreadIsland",
    setup() {
      return () => h(NConfigProvider, { themeOverrides: desktopNaiveThemeOverrides }, {
        default: () => {
          const nodes = [
            ...state.value.messages.map((message, index) => h("article", {
            key: `${message.tone}:${index}`,
            class: "desktop-conversation-message",
            "data-desktop-vue-island": "conversation-message",
            "data-message-tone": message.tone,
          }, renderConversationMessageChildren(message))),
            ...(state.value.inlineForms ?? []).map((form) => renderInlineAgentUiForm(state.value, form)),
          ];
          return nodes.length
            ? nodes
            : (state.value.emptyMessage ? h(NEmpty, { description: state.value.emptyMessage }) : null);
        },
      });
    },
  }));
}

function renderInlineAgentUiForm(options: ConversationThreadIslandOptions, form: AgentUiForm) {
  return h("article", {
    key: `agent-form:${form.form_id}`,
    class: "desktop-agent-ui-form-card desktop-agent-ui-form-inline",
    "data-agent-ui-form-id": form.form_id,
    "data-agent-ui-form-status": form.status ?? "pending",
    "data-desktop-chat-region": "agent-form-card",
    "data-desktop-vue-island": "agent-ui-form-card",
  }, renderAgentUiFormCardChildren({
    form,
    onCancel: options.onInlineFormCancel,
    onSubmit: options.onInlineFormSubmit,
  }));
}

function applyHostContract(host: HTMLElement): void {
  host.setAttribute("data-desktop-vue-island", "conversation-thread");
  host.className = "desktop-conversation-thread";
  host.setAttribute("aria-label", "Message Timeline");
  host.setAttribute("aria-live", "polite");
  host.setAttribute("data-desktop-chat-region", "message-timeline");
  host.setAttribute("role", "log");
}
