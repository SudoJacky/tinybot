import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_GATEWAY_CONFIG, resolveGatewayConfig } from "./gatewayConfig";
import {
  DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
  checkGatewayHealth,
  createGatewayApiClient,
  resolveTsCoworkRuntimeRollout,
  type GatewayHealth,
  type TsCoworkRuntimeRollout,
} from "./gatewayHttpClient";
import { createDesktopNativeCoworkApi } from "./desktopNativeCowork";
import { createDesktopNativeSkillsApi } from "./desktopNativeSkills";
import { createDesktopNativeWebuiApi } from "./desktopNativeWebui";
import {
  AGENT_UI_FORM_STATUSES,
  buildAgentUiFormCancelRequest,
  buildAgentUiFormSubmitRequest,
  createAgentUiEventState,
  isAgentUiFormSubmittable,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  validateAgentUiFormValues,
  type AgentUiForm,
  type AgentUiFormField,
} from "./agentUiEvents";
import {
  flushGatewaySocketQueue,
  openGatewaySocket,
  sendGatewaySocketJson,
  type NormalizedGatewayEvent,
} from "./gatewayWebSocketClient";
import { resolveGatewayStatusView } from "./gatewayStatusView";
import { createDesktopChatSessionController } from "./desktopChatSessionController";
import { type NativeChatMessage } from "./nativeChat";
import {
  buildDesktopSecretField,
  buildDesktopSettingsFormState,
  validateDesktopSettingsForm,
  type DesktopProviderCatalogItem,
} from "./desktopSettingsProviders";
import {
  buildDesktopKnowledgeDocumentRows,
  buildDesktopKnowledgeReadinessView,
} from "./desktopKnowledgeTraceability";
import {
  buildDesktopSkillRows,
  buildDesktopToolRows,
  buildDesktopToolsConfigHint,
} from "./desktopToolsSkills";
import {
  buildDesktopCoworkCockpitView,
  buildDesktopCoworkSessionRows,
} from "./desktopCowork";
import { buildDesktopGatewayRuntimeRows } from "./desktopGatewayRuntimeControls";
import type { GatewayRuntimeStatus } from "./desktopGatewayStartup";

type DesktopStatus = {
  app_name: string;
  gateway_http: string;
  gateway_ws: string;
  browser_mode: string;
};

const gatewayConfig = resolveGatewayConfig(DEFAULT_GATEWAY_CONFIG);
const gatewayClientOptions: {
  config: typeof gatewayConfig;
  nativeCowork: ReturnType<typeof createDesktopNativeCoworkApi>;
  nativeSkills: ReturnType<typeof createDesktopNativeSkillsApi>;
  nativeWebui: ReturnType<typeof createDesktopNativeWebuiApi>;
  tsCoworkRuntime: TsCoworkRuntimeRollout;
} = {
  config: gatewayConfig,
  nativeCowork: createDesktopNativeCoworkApi({ invoke }),
  nativeSkills: createDesktopNativeSkillsApi({ invoke }),
  nativeWebui: createDesktopNativeWebuiApi({ invoke }),
  tsCoworkRuntime: DEFAULT_TS_COWORK_RUNTIME_ROLLOUT,
};
const gatewayApi = createGatewayApiClient(gatewayClientOptions);
const chatController = createDesktopChatSessionController({
  api: {
    listSessions: () => gatewayApi.sessions.list(),
    loadMessages: (sessionKey) => gatewayApi.sessions.messages(sessionKey),
  },
  sendSocketMessage: (message) => sendSocketMessage(message),
});
const chatState = chatController.state;
const agentUiState = createAgentUiEventState();

let lastHealth: GatewayHealth | null = null;
let lastRuntimeStatus: GatewayRuntimeStatus | null = null;
let gatewaySocket: WebSocket | null = null;
const pendingSocketMessages: unknown[] = [];
let activeWorkspaceFile: { path: string; updatedAt: string | null } | null = null;

function text(id: string, value: string) {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (element) {
    element.textContent = value;
  }
}

function setDot(id: string, state: "ok" | "warn" | "idle") {
  const element = document.querySelector<HTMLElement>(`#${id}`);
  if (!element) {
    return;
  }
  element.classList.remove("ok", "warn", "idle");
  element.classList.add(state);
}

function log(message: string) {
  text("activity-log", message);
  text("last-check", new Date().toLocaleTimeString());
}

async function invokeOptional<T>(command: string): Promise<T | null> {
  if (!hasTauriRuntime()) {
    text("shell-status", "Browser preview: Tauri shell commands unavailable");
    return null;
  }

  try {
    return await invoke<T>(command);
  } catch (error) {
    text("shell-status", `Desktop shell command failed: ${String(error)}`);
    return null;
  }
}

async function runGatewayCommand(command: "start_gateway" | "stop_gateway") {
  if (!hasTauriRuntime()) {
    log("Gateway start/stop requires the Tauri desktop shell.");
    return;
  }

  try {
    const status = await invoke<GatewayRuntimeStatus>(command);
    renderGatewayRuntime(status);
  } catch (error) {
    log(`Gateway command failed: ${String(error)}`);
  }
  await loadDesktopStatus();
}

async function loadDesktopStatus() {
  const desktopStatus = await invokeOptional<DesktopStatus>("desktop_status");
  if (desktopStatus) {
    text("shell-status", `${desktopStatus.app_name} shell ready`);
    text("gateway-http", desktopStatus.gateway_http || gatewayConfig.httpBaseUrl);
    text("gateway-ws", desktopStatus.gateway_ws || gatewayConfig.wsUrl);
    text("browser-status", desktopStatus.browser_mode);
    setDot("browser-dot", "idle");
  }

  const runtimeStatus = await invokeOptional<GatewayRuntimeStatus>("gateway_status");
  if (runtimeStatus) {
    lastRuntimeStatus = runtimeStatus;
    renderGatewayRuntime(runtimeStatus);
  }

  lastHealth = await checkGatewayHealth({ config: gatewayConfig });
  renderGatewayHealth(lastHealth, runtimeStatus);
}

window.addEventListener("DOMContentLoaded", () => {
  bindNavigation();
  document
    .querySelector("#refresh-status")
    ?.addEventListener("click", () => void loadDesktopStatus());
  document
    .querySelector("#start-gateway")
    ?.addEventListener("click", () => void runGatewayCommand("start_gateway"));
  document
    .querySelector("#stop-gateway")
    ?.addEventListener("click", () => void runGatewayCommand("stop_gateway"));
  document
    .querySelector("#open-hosted-webui")
    ?.addEventListener("click", () => openHostedWebui());
  document
    .querySelector("#reload-hosted-webui")
    ?.addEventListener("click", () => openHostedWebui(true));
  document
    .querySelector("#new-chat")
    ?.addEventListener("click", () => startNewChat());
  document
    .querySelector("#refresh-chat")
    ?.addEventListener("click", () => void loadSessions());
  document
    .querySelector("#interrupt-chat")
    ?.addEventListener("click", () => interruptActiveChat());
  document
    .querySelector("#chat-form")
    ?.addEventListener("submit", (event) => submitChatMessage(event));
  document
    .querySelector("#session-list")
    ?.addEventListener("click", (event) => void handleSessionListClick(event));
  document
    .querySelector("#native-workspace-file-list")
    ?.addEventListener("click", (event) => void handleWorkspaceFileClick(event));
  document
    .querySelector("#native-workspace-save")
    ?.addEventListener("click", () => void saveActiveWorkspaceFile());
  document
    .querySelector("#native-cowork-session-list")
    ?.addEventListener("click", (event) => void handleCoworkSessionClick(event));
  document
    .querySelector("#native-agent-ui-surfaces")
    ?.addEventListener("submit", (event) => void submitAgentUiForm(event));
  document
    .querySelector("#native-agent-ui-surfaces")
    ?.addEventListener("click", (event) => void cancelAgentUiForm(event));
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-hosted-fallback]")) {
    button.addEventListener("click", () => openHostedWebui());
  }

  void loadDesktopStatus();
});

function renderGatewayRuntime(status: GatewayRuntimeStatus) {
  text("gateway-http", status.gateway_http);
  text("gateway-ws", status.gateway_ws);
  text("gateway-owner", ownerLabel(status.owner));
  text("gateway-command", status.command);
  const lines = buildDesktopGatewayRuntimeRows(status, gatewayConfig.httpBaseUrl)
    .map((row) => `${row.label}: ${row.value}`);
  log(lines.join("\n"));
}

function renderGatewayHealth(health: GatewayHealth, runtimeStatus: GatewayRuntimeStatus | null) {
  const view = resolveGatewayStatusView(health, runtimeStatus);
  const owner = runtimeStatus ? ownerLabel(runtimeStatus.owner) : "Unknown";
  text("gateway-owner", owner);
  text("gateway-status", view.statusText);
  setDot("gateway-dot", view.dotState);

  const hostedReady = view.hostedReady;
  const nativeReady = view.nativeReady;
  setButtonDisabled("open-hosted-webui", !hostedReady);
  setButtonDisabled("new-chat", !nativeReady);
  setButtonDisabled("refresh-chat", !nativeReady);
  setChatNavEnabled(nativeReady);
  setBrowserNavEnabled(nativeReady);
  setSecondaryNavEnabled(nativeReady);
  text(
    "hosted-status",
    hostedReady
      ? `Ready at ${health.httpBaseUrl}. The existing gateway-hosted WebUI can be loaded inside the desktop shell.`
      : `Unavailable while gateway is ${view.statusText.toLowerCase()}.`,
  );
  text("hosted-heading-status", hostedReady ? health.httpBaseUrl : "Gateway offline");
  renderHostedAvailability(hostedReady);
  if (nativeReady) {
    ensureChatSocket();
    void loadSessions();
    void loadSecondaryModules();
  } else {
    closeChatSocket();
    renderChatStatus(`${view.detailText}. Hosted WebUI remains available when the gateway is reachable.`);
    renderSecondaryOffline();
  }
}

function openHostedWebui(forceReload = false) {
  if (!lastHealth || !resolveGatewayStatusView(lastHealth, lastRuntimeStatus).hostedReady) {
    renderHostedAvailability(false);
    activateView("hosted-view");
    return;
  }

  const frame = document.querySelector<HTMLIFrameElement>("#hosted-frame");
  if (frame && (forceReload || frame.src !== `${lastHealth.httpBaseUrl}/`)) {
    frame.src = lastHealth.httpBaseUrl;
  }
  renderHostedAvailability(true);
  activateView("hosted-view");
}

function renderHostedAvailability(ready: boolean) {
  const frame = document.querySelector<HTMLIFrameElement>("#hosted-frame");
  const offline = document.querySelector<HTMLElement>("#hosted-offline");
  if (frame) {
    frame.hidden = !ready;
  }
  if (offline) {
    offline.hidden = ready;
  }
}

function bindNavigation() {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view-target]")) {
    button.addEventListener("click", () => activateView(button.dataset.viewTarget ?? "runtime-view"));
  }
}

function activateView(viewId: string) {
  for (const view of document.querySelectorAll<HTMLElement>(".view")) {
    const active = view.id === viewId;
    view.hidden = !active;
    view.classList.toggle("active", active);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view-target]")) {
    button.classList.toggle("active", button.dataset.viewTarget === viewId);
  }
}

async function loadSessions() {
  if (!lastHealth || lastHealth.state !== "running") {
    return;
  }
  try {
    const sessionCount = await chatController.loadSessions();
    renderChat();
    renderChatStatus(sessionCount ? "Sessions loaded from gateway." : "No sessions yet.");
  } catch (error) {
    renderChatStatus(`Failed to load sessions: ${String(error)}`);
  }
}

async function selectSession(sessionKey: string, chatId: string) {
  try {
    ensureChatSocket();
    await chatController.selectSession(sessionKey, chatId);
    renderChat();
  } catch (error) {
    renderChatStatus(`Failed to load messages: ${String(error)}`);
  }
}

function startNewChat() {
  ensureChatSocket();
  chatController.startNewChat();
  renderChatStatus("Creating chat session.");
}

function submitChatMessage(event: Event) {
  event.preventDefault();
  const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const content = input?.value.trim() ?? "";
  if (!content) {
    return;
  }
  ensureChatSocket();
  const result = chatController.submitMessage(content, true);
  if (result.status === "creating") {
    renderChatStatus("Creating chat session before sending.");
    return;
  }
  if (result.status === "sent") {
    renderChatStatus("Message sent.");
    renderChat();
  }
  if (input) {
    input.value = "";
  }
}

function interruptActiveChat() {
  if (!chatController.interruptActiveChat()) {
    return;
  }
  renderChatStatus("Interrupt requested.");
}

async function handleSessionListClick(event: Event) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-session-key]") : null;
  if (!target) {
    return;
  }
  await selectSession(target.dataset.sessionKey ?? "", target.dataset.chatId ?? "");
}

function ensureChatSocket() {
  if (gatewaySocket && gatewaySocket.readyState <= WebSocket.OPEN) {
    return;
  }
  const wsUrl = lastHealth?.wsUrl || gatewayConfig.wsUrl;
  gatewaySocket = openGatewaySocket(resolveGatewayConfig({ ...gatewayConfig, wsUrl }), {
    onOpen: () => {
      const flushed = flushGatewaySocketQueue(gatewaySocket, pendingSocketMessages);
      renderChatStatus(flushed ? `WebSocket connected. Sent ${flushed} queued message(s).` : "WebSocket connected.");
    },
    onClose: () => renderChatStatus("WebSocket disconnected."),
    onError: () => renderChatStatus("WebSocket connection failed."),
    onEvent: (event) => void handleChatEvent(event),
  });
}

async function handleChatEvent(event: NormalizedGatewayEvent) {
  const handledAgentUi = applyAgentUiFrame(event.raw);
  let pendingMessageSent = false;
  try {
    const result = await chatController.handleGatewayEvent(event);
    pendingMessageSent = result.pendingMessageSent;
  } catch (error) {
    renderChatStatus(`Failed to refresh messages: ${String(error)}`);
  }
  if (handledAgentUi) {
    renderAgentUiSurfaces();
  }
  if (pendingMessageSent) {
    const input = document.querySelector<HTMLTextAreaElement>("#chat-input");
    if (input) {
      input.value = "";
    }
  }
  if (event.kind === "error") {
    renderChatStatus(event.message);
  }
  renderChat();
}

function sendSocketMessage(message: unknown) {
  ensureChatSocket();
  const result = sendGatewaySocketJson(gatewaySocket, message, pendingSocketMessages);
  if (result === "queued") {
    renderChatStatus("WebSocket connecting. Message queued.");
  }
}

function closeChatSocket() {
  gatewaySocket?.close();
  gatewaySocket = null;
}

function renderChat() {
  const activeSession = chatState.sessions.find((session) => session.key === chatState.activeSessionKey);
  text("active-chat-title", activeSession?.title || "No session selected");
  text("active-chat-meta", activeSession?.updatedAt ? `Updated ${formatTime(activeSession.updatedAt)}` : "Native chat preview");
  setButtonDisabled("interrupt-chat", !chatState.activeSessionKey || !chatState.respondingSessionKeys.has(chatState.activeSessionKey));
  renderSessionList();
  renderMessageList();
  renderAgentUiSurfaces();
}

function renderSessionList() {
  const list = document.querySelector<HTMLElement>("#session-list");
  if (!list) {
    return;
  }
  list.textContent = "";
  if (!chatState.sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty-list";
    empty.textContent = "No sessions yet.";
    list.append(empty);
    return;
  }
  for (const session of chatState.sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-row";
    button.classList.toggle("active", session.key === chatState.activeSessionKey);
    button.dataset.sessionKey = session.key;
    button.dataset.chatId = session.chatId;
    const title = document.createElement("strong");
    title.textContent = session.title || "New session";
    const meta = document.createElement("span");
    meta.textContent = session.updatedAt ? formatTime(session.updatedAt) : session.chatId;
    button.append(title, meta);
    list.append(button);
  }
}

function renderMessageList() {
  const list = document.querySelector<HTMLElement>("#native-message-list");
  if (!list) {
    return;
  }
  list.textContent = "";
  const messages = chatState.messages.get(chatState.activeSessionKey) ?? [];
  if (!chatState.activeSessionKey) {
    list.append(emptyMessage("Select or create a session."));
    return;
  }
  if (!messages.length) {
    list.append(emptyMessage("No messages in this session."));
    return;
  }
  for (const message of messages) {
    list.append(createMessageNode(message));
  }
  list.scrollTop = list.scrollHeight;
}

function createMessageNode(message: NativeChatMessage): HTMLElement {
  const node = document.createElement("article");
  node.className = `native-message ${message.role === "user" ? "user" : "assistant"}`;
  const content = document.createElement("div");
  content.className = "native-message-content";
  if (message.reasoningContent) {
    const reasoning = document.createElement("p");
    reasoning.className = "native-reasoning";
    reasoning.textContent = message.reasoningContent;
    content.append(reasoning);
  }
  const body = document.createElement("p");
  body.textContent = message.content || (message.reasoningContent ? "" : " ");
  content.append(body);
  const meta = document.createElement("span");
  meta.className = "native-message-meta";
  meta.textContent = message.role === "user" ? "" : formatTime(message.timestamp);
  node.append(content, meta);
  return node;
}

function emptyMessage(message: string): HTMLElement {
  const node = document.createElement("p");
  node.className = "empty-chat";
  node.textContent = message;
  return node;
}

function renderChatStatus(message: string) {
  text("chat-status", message);
}

function setChatNavEnabled(enabled: boolean) {
  const item = document.querySelector<HTMLButtonElement>("[data-view-target='chat-view']");
  if (item) {
    item.disabled = !enabled;
  }
}

function setBrowserNavEnabled(enabled: boolean) {
  const item = document.querySelector<HTMLButtonElement>("[data-view-target='browser-view']");
  if (item) {
    item.disabled = !enabled;
  }
}

function setSecondaryNavEnabled(enabled: boolean) {
  for (const target of ["settings-view", "knowledge-view", "workspace-view", "cowork-view"]) {
    const item = document.querySelector<HTMLButtonElement>(`[data-view-target='${target}']`);
    if (item) {
      item.disabled = !enabled;
    }
  }
}

function setButtonDisabled(id: string, disabled: boolean) {
  const button = document.querySelector<HTMLButtonElement>(`#${id}`);
  if (button) {
    button.disabled = disabled;
  }
}

async function loadSecondaryModules() {
  text("settings-status", "Loading settings, providers, tools, and skills.");
  text("knowledge-status", "Loading knowledge overview and documents.");
  text("workspace-status", "Loading editable workspace files.");
  text("cowork-status", "Loading Cowork sessions.");
  await Promise.all([
    loadSettingsModules(),
    loadKnowledgeModules(),
    loadWorkspaceFiles(),
    loadCoworkSessions(),
  ]);
}

function renderSecondaryOffline() {
  text("settings-status", "Unavailable while gateway is offline. Use Hosted WebUI after runtime starts.");
  text("knowledge-status", "Unavailable while gateway is offline. Use Hosted WebUI after runtime starts.");
  text("workspace-status", "Unavailable while gateway is offline. Use Hosted WebUI after runtime starts.");
  text("cowork-status", "Unavailable while gateway is offline. Use Hosted WebUI after runtime starts.");
  renderRows("native-provider-list", []);
  renderRows("native-tool-list", []);
  renderRows("native-skill-list", []);
  renderRows("native-knowledge-stats", []);
  renderRows("native-knowledge-documents", []);
  renderRows("native-workspace-file-list", []);
  renderRows("native-cowork-session-list", []);
}

async function loadSettingsModules() {
  try {
    const [config, providersPayload, toolsPayload, skillsPayload] = await Promise.all([
      gatewayApi.config.get(),
      gatewayApi.config.providers(),
      gatewayApi.tools.list(),
      gatewayApi.skills.list(),
    ]);
    const providers = arrayFromPayload(providersPayload, "providers");
    const providerCatalog = providers.map(toDesktopProviderCatalogItem);
    syncTsCoworkRuntimeRollout(config);
    const settingsState = buildDesktopSettingsFormState(config, providerCatalog);
    const validationErrors = validateDesktopSettingsForm(settingsState);
    const providerSecret = buildDesktopSecretField(settingsState.providerEditor.apiKey);
    const toolRows = buildDesktopToolRows(toolsPayload, config);
    const toolConfigHint = buildDesktopToolsConfigHint(config);
    const skillRows = buildDesktopSkillRows(skillsPayload, config);
    renderRows(
      "native-provider-list",
      providers.map((provider) => ({
        title: stringValue(provider.displayName) || stringValue(provider.id),
        meta: [
          stringValue(provider.status),
          boolLabel(provider.default, "Default"),
          providerSecret.empty ? "" : "API key configured",
        ].filter(Boolean).join(" | "),
      })),
    );
    renderRows(
      "native-tool-list",
      toolRows.map((tool) => ({
        title: tool.displayName || tool.name,
        meta: [tool.description, tool.meta, tool.configHint, tool.riskHint].filter(Boolean).join(" | "),
      })),
    );
    renderRows(
      "native-skill-list",
      skillRows.map((skill) => ({
        title: skill.name,
        meta: skill.meta,
      })),
    );
    const defaultModel = settingsState.agent.model;
    const validationText = validationErrors.length ? ` ${validationErrors.length} setting warning(s).` : "";
    const toolsText = toolConfigHint.show ? ` ${toolConfigHint.disabledToolGroups.join(", ")} tools disabled.` : "";
    text("settings-status", defaultModel ? `Loaded native settings overview. Default model: ${defaultModel}.${validationText}${toolsText}` : `Loaded native settings overview.${validationText}${toolsText}`);
  } catch (error) {
    text("settings-status", `Failed to load settings overview: ${String(error)}`);
  }
}

function toDesktopProviderCatalogItem(provider: Record<string, unknown>): DesktopProviderCatalogItem {
  return {
    id: stringValue(provider.id),
    displayName: stringValue(provider.displayName),
    baseUrl: stringValue(provider.baseUrl),
    status: stringValue(provider.status),
  };
}

async function loadKnowledgeModules() {
  try {
    const [statsPayload, documentsPayload] = await Promise.all([
      gatewayApi.knowledge.stats(),
      gatewayApi.knowledge.documents(),
    ]);
    const stats = isRecord(statsPayload) ? statsPayload : {};
    const readiness = buildDesktopKnowledgeReadinessView(stats);
    renderRows(
      "native-knowledge-stats",
      [
        {
          title: "Readiness",
          meta: `${readiness.score}% / ${readiness.titleKey}`,
        },
        ...readiness.rows.map((row) => ({
          title: readableKey(row.id),
          meta: [row.tone, row.statusKey].join(" / "),
        })),
      ],
    );
    const documents = buildDesktopKnowledgeDocumentRows(documentsPayload);
    renderRows(
      "native-knowledge-documents",
      documents.map((document) => ({
        title: document.title,
        meta: document.meta,
      })),
    );
    text("knowledge-status", `Loaded ${documents.length} document(s). Knowledge readiness ${readiness.score}%. Graph and traceability panes remain pending.`);
  } catch (error) {
    text("knowledge-status", `Failed to load knowledge overview: ${String(error)}`);
  }
}

async function loadWorkspaceFiles() {
  try {
    const payload = await gatewayApi.workspace.files();
    const files = arrayFromPayload(payload, "items");
    renderRows(
      "native-workspace-file-list",
      files.map((file) => ({
        title: stringValue(file.path),
        meta: file.exists === false ? "Not created" : stringValue(file.updated_at) || "Available",
        action: "workspace-file",
        value: stringValue(file.path),
      })),
    );
    text("workspace-status", `Loaded ${files.length} editable workspace file(s).`);
  } catch (error) {
    text("workspace-status", `Failed to load workspace files: ${String(error)}`);
  }
}

async function handleWorkspaceFileClick(event: Event) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-workspace-file]") : null;
  const path = target?.dataset.workspaceFile ?? "";
  if (!path) {
    return;
  }
  try {
    const payload = await gatewayApi.workspace.file(path);
    if (!isRecord(payload)) {
      throw new Error("invalid workspace file response");
    }
    activeWorkspaceFile = {
      path: stringValue(payload.path) || path,
      updatedAt: typeof payload.updated_at === "string" ? payload.updated_at : null,
    };
    text("native-workspace-file-title", activeWorkspaceFile.path);
    text("native-workspace-file-meta", activeWorkspaceFile.updatedAt ? `Updated ${formatTime(activeWorkspaceFile.updatedAt)}` : "File not created yet");
    const editor = document.querySelector<HTMLTextAreaElement>("#native-workspace-editor");
    if (editor) {
      editor.value = stringValue(payload.content);
    }
    setButtonDisabled("native-workspace-save", false);
  } catch (error) {
    text("workspace-status", `Failed to load workspace file: ${String(error)}`);
  }
}

async function saveActiveWorkspaceFile() {
  const editor = document.querySelector<HTMLTextAreaElement>("#native-workspace-editor");
  if (!activeWorkspaceFile || !editor) {
    return;
  }
  try {
    const payload = await gatewayApi.workspace.putFile(activeWorkspaceFile.path, {
      content: editor.value,
      expected_updated_at: activeWorkspaceFile.updatedAt,
    });
    if (isRecord(payload)) {
      activeWorkspaceFile.updatedAt = typeof payload.updated_at === "string" ? payload.updated_at : activeWorkspaceFile.updatedAt;
      text("native-workspace-file-meta", activeWorkspaceFile.updatedAt ? `Saved ${formatTime(activeWorkspaceFile.updatedAt)}` : "Saved");
    }
    text("workspace-status", `Saved ${activeWorkspaceFile.path}.`);
    await loadWorkspaceFiles();
  } catch (error) {
    text("workspace-status", `Failed to save workspace file: ${String(error)}`);
  }
}

async function loadCoworkSessions() {
  try {
    const payload = await gatewayApi.cowork.sessions();
    const sessions = buildDesktopCoworkSessionRows(payload);
    renderRows(
      "native-cowork-session-list",
      sessions.map((session) => ({
        title: session.title,
        meta: session.meta,
        action: "cowork-session",
        value: session.id,
      })),
    );
    text("cowork-status", `Loaded ${sessions.length} Cowork session(s). Full graph, mailbox, trace, and activity panels remain in Hosted WebUI.`);
  } catch (error) {
    text("cowork-status", `Failed to load Cowork sessions: ${String(error)}`);
  }
}

async function handleCoworkSessionClick(event: Event) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-cowork-session]") : null;
  const sessionId = target?.dataset.coworkSession ?? "";
  if (!sessionId) {
    return;
  }
  try {
    const payload = await gatewayApi.cowork.session(sessionId);
    const session = isRecord(payload) && isRecord(payload.session) ? payload.session : payload;
    const view = buildDesktopCoworkCockpitView(session);
    const summary = document.querySelector<HTMLElement>("#native-cowork-summary");
    if (summary) {
      summary.textContent = formatCoworkCockpitSummary(view);
    }
    text("cowork-status", `Loaded summary for ${sessionId}.`);
  } catch (error) {
    text("cowork-status", `Failed to load Cowork summary: ${String(error)}`);
  }
}

function renderRows(id: string, rows: { title: string; meta?: string; action?: string; value?: string }[]) {
  const container = document.querySelector<HTMLElement>(`#${id}`);
  if (!container) {
    return;
  }
  container.textContent = "";
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "module-empty";
    empty.textContent = "No items.";
    container.append(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "module-row";
    const title = row.action ? document.createElement("button") : document.createElement("strong");
    title.textContent = row.title || "Untitled";
    if (title instanceof HTMLButtonElement) {
      title.type = "button";
      if (row.action === "workspace-file") {
        title.dataset.workspaceFile = row.value ?? "";
      }
      if (row.action === "cowork-session") {
        title.dataset.coworkSession = row.value ?? "";
      }
    }
    item.append(title);
    if (row.meta) {
      const meta = document.createElement("span");
      meta.textContent = row.meta;
      item.append(meta);
    }
    container.append(item);
  }
}

function arrayFromPayload(payload: unknown, ...keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) {
    return payload.filter(isRecord);
  }
  if (!isRecord(payload)) {
    return [];
  }
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value.filter(isRecord);
    }
  }
  return [];
}

function boolLabel(value: unknown, label: string): string {
  return value === true ? label : "";
}

function readableKey(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatCoworkCockpitSummary(view: ReturnType<typeof buildDesktopCoworkCockpitView>): string {
  return [
    `${view.header.title} (${view.header.status})`,
    view.header.goal,
    `${view.agents.length} agent(s), ${view.tasks.length} task(s), ${view.mailbox.length} mailbox record(s), ${view.artifacts.length} artifact(s)`,
    view.graph.caption,
    view.taskCenterItems[0]?.detail ?? "",
  ].filter(Boolean).join("\n");
}

function applyAgentUiFrame(frame: Record<string, unknown>): boolean {
  const events = normalizeAgentUiEvents(frame);
  if (!events.length) {
    return false;
  }
  for (const agentEvent of events) {
    reduceAgentUiEventState(agentUiState, agentEvent);
  }
  const latestError = agentUiState.errors[agentUiState.errors.length - 1];
  if (latestError?.message) {
    renderChatStatus(latestError.message);
  }
  return true;
}

function renderAgentUiSurfaces() {
  renderBrowserSurface();
  renderFormSurfaces();
}

function renderBrowserSurface() {
  const frame = agentUiState.browserFrame;
  const hasFrame = Boolean(frame?.image_url);
  text("browser-observation-status", hasFrame ? "Live frame" : "Waiting for browser activity");
  text("browser-observation-time", frame?.captured_at ? formatTime(frame.captured_at) : "-");
  text("browser-observation-command", frame?.command ?? "");
  text("browser-status", hasFrame ? "Available through gateway observations" : "External bridge optional; no frame received");
  setDot("browser-dot", hasFrame ? "ok" : "idle");

  const image = document.querySelector<HTMLImageElement>("#browser-observation-image");
  const empty = document.querySelector<HTMLElement>("#browser-observation-empty");
  if (image) {
    image.hidden = !hasFrame;
    if (frame?.image_url) {
      image.src = frame.image_url;
    }
  }
  if (empty) {
    empty.hidden = hasFrame;
  }
}

function renderFormSurfaces() {
  const container = document.querySelector<HTMLElement>("#native-agent-ui-surfaces");
  if (!container) {
    return;
  }
  container.textContent = "";
  const forms = [...agentUiState.forms.values()].filter((form) => form.chat_id === chatState.activeChatId || !form.chat_id);
  if (!forms.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  for (const form of forms) {
    container.append(createAgentUiFormNode(form));
  }
}

function createAgentUiFormNode(form: AgentUiForm): HTMLElement {
  const card = document.createElement("article");
  card.className = `agent-ui-form-card agent-ui-form-${form.status ?? AGENT_UI_FORM_STATUSES.pending}`;
  card.dataset.agentUiFormId = form.form_id;
  const header = document.createElement("div");
  header.className = "agent-ui-form-header";
  const title = document.createElement("h4");
  title.textContent = form.title || form.form_id;
  const status = document.createElement("span");
  status.className = "agent-ui-form-status";
  status.textContent = formStatusLabel(form.status);
  header.append(title, status);
  card.append(header);

  if (form.description) {
    const description = document.createElement("p");
    description.className = "agent-ui-form-description";
    description.textContent = form.description;
    card.append(description);
  }

  const formElement = document.createElement("form");
  formElement.className = "agent-ui-form";
  formElement.dataset.agentUiFormId = form.form_id;
  for (const field of form.fields) {
    formElement.append(createAgentUiFormField(form, field));
  }
  if (isAgentUiFormSubmittable(form)) {
    const actions = document.createElement("div");
    actions.className = "agent-ui-form-actions";
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "button primary";
    submit.textContent = form.submit_label || "Submit";
    submit.disabled = form.submitting === true;
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "button";
    cancel.dataset.cancelAgentUiFormId = form.form_id;
    cancel.textContent = form.cancel_label || "Cancel";
    cancel.disabled = form.submitting === true;
    actions.append(submit, cancel);
    formElement.append(actions);
  }
  card.append(formElement);
  return card;
}

function createAgentUiFormField(form: AgentUiForm, field: AgentUiFormField): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "agent-ui-form-field";
  const label = document.createElement("span");
  label.textContent = `${field.label}${field.required ? " *" : ""}`;
  wrapper.append(label);
  const value = form.values?.[field.name] ?? form.initial_values?.[field.name] ?? field.default ?? "";
  const control = fieldControl(form, field, value);
  control.dataset.agentUiFormField = field.name;
  setControlDisabled(control, !isAgentUiFormSubmittable(form));
  wrapper.append(control);
  const error = form.errors?.[field.name];
  if (error) {
    const errorNode = document.createElement("span");
    errorNode.className = "agent-ui-form-error";
    errorNode.textContent = error;
    wrapper.append(errorNode);
  } else if (field.help) {
    const help = document.createElement("span");
    help.className = "agent-ui-form-help";
    help.textContent = field.help;
    wrapper.append(help);
  }
  return wrapper;
}

function fieldControl(form: AgentUiForm, field: AgentUiFormField, value: unknown): HTMLElement {
  if (field.type === "textarea") {
    const textarea = document.createElement("textarea");
    textarea.name = field.name;
    textarea.value = typeof value === "string" ? value : "";
    textarea.placeholder = field.placeholder ?? "";
    return textarea;
  }
  if (field.type === "select" || field.type === "multiselect") {
    const select = document.createElement("select");
    select.name = field.name;
    select.multiple = field.type === "multiselect";
    for (const option of field.options ?? []) {
      const node = document.createElement("option");
      node.value = String(option.value);
      node.textContent = option.label;
      node.selected = Array.isArray(value) ? value.includes(option.value) : value === option.value;
      select.append(node);
    }
    return select;
  }
  if (field.type === "radio") {
    return choiceGroup(form, field, value);
  }
  const input = document.createElement("input");
  input.name = field.name;
  input.type = field.type === "checkbox" ? "checkbox" : field.type === "file_path" ? "text" : field.type;
  input.placeholder = field.placeholder ?? "";
  if (field.type === "checkbox") {
    input.checked = value === true;
  } else {
    input.value = typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  return input;
}

function choiceGroup(form: AgentUiForm, field: AgentUiFormField, value: unknown): HTMLElement {
  const group = document.createElement("fieldset");
  group.className = "agent-ui-choice-group";
  group.dataset.agentUiFormField = field.name;
  group.disabled = !isAgentUiFormSubmittable(form);
  for (const option of field.options ?? []) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = field.name;
    input.value = String(option.value);
    input.checked = value === option.value;
    label.append(input, document.createTextNode(option.label));
    group.append(label);
  }
  return group;
}

async function submitAgentUiForm(event: Event) {
  event.preventDefault();
  const formEl = event.target instanceof HTMLFormElement ? event.target : null;
  const formId = formEl?.dataset.agentUiFormId ?? "";
  const form = agentUiState.forms.get(formId);
  if (!formEl || !form || !isAgentUiFormSubmittable(form)) {
    return;
  }
  const values = collectAgentUiFormValues(form, formEl);
  try {
    validateAgentUiFormValues(form, values);
  } catch (error) {
    form.values = values;
    form.errors = { form: error instanceof Error ? error.message : String(error) };
    renderFormSurfaces();
    return;
  }
  const request = buildAgentUiFormSubmitRequest(form, values);
  if (!request) {
    return;
  }
  form.submitting = true;
  renderFormSurfaces();
  try {
    const response = await gatewayApi.agentUi.submitForm(form.form_id, request);
    applyAgentUiFrame(eventFromFormResponse(response));
  } catch (error) {
    form.submitting = false;
    form.errors = { form: String(error) };
  }
  renderAgentUiSurfaces();
}

async function cancelAgentUiForm(event: Event) {
  const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-cancel-agent-ui-form-id]") : null;
  if (!target) {
    return;
  }
  const form = agentUiState.forms.get(target.dataset.cancelAgentUiFormId ?? "");
  if (!form || !isAgentUiFormSubmittable(form)) {
    return;
  }
  const request = buildAgentUiFormCancelRequest(form);
  if (!request) {
    return;
  }
  form.submitting = true;
  renderFormSurfaces();
  try {
    const response = await gatewayApi.agentUi.cancelForm(form.form_id, request);
    applyAgentUiFrame(eventFromFormResponse(response));
  } catch (error) {
    form.submitting = false;
    form.errors = { form: String(error) };
  }
  renderAgentUiSurfaces();
}

function collectAgentUiFormValues(form: AgentUiForm, root: HTMLFormElement): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (field.type === "checkbox") {
      values[field.name] = root.querySelector<HTMLInputElement>(`[name="${cssEscape(field.name)}"]`)?.checked === true;
    } else if (field.type === "number") {
      const value = root.querySelector<HTMLInputElement>(`[name="${cssEscape(field.name)}"]`)?.value ?? "";
      values[field.name] = value === "" ? "" : Number(value);
    } else if (field.type === "multiselect") {
      const select = root.querySelector<HTMLSelectElement>(`[name="${cssEscape(field.name)}"]`);
      values[field.name] = [...(select?.selectedOptions ?? [])].map((option) => typedOptionValue(field, option.value));
    } else if (field.type === "radio") {
      const input = root.querySelector<HTMLInputElement>(`[name="${cssEscape(field.name)}"]:checked`);
      values[field.name] = input ? typedOptionValue(field, input.value) : "";
    } else {
      values[field.name] = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${cssEscape(field.name)}"]`)?.value ?? "";
    }
  }
  return values;
}

function typedOptionValue(field: AgentUiFormField, rawValue: string): string | number | boolean {
  const option = field.options?.find((item) => String(item.value) === rawValue);
  return option?.value ?? rawValue;
}

function eventFromFormResponse(response: unknown): Record<string, unknown> {
  if (response && typeof response === "object" && "event" in response) {
    const event = (response as { event?: unknown }).event;
    if (event && typeof event === "object") {
      return {
        event: "agent_ui_event",
        agent_ui_event: event,
      };
    }
  }
  return {};
}

function formStatusLabel(status: AgentUiForm["status"]): string {
  switch (status) {
    case AGENT_UI_FORM_STATUSES.submitted:
      return "Submitted";
    case AGENT_UI_FORM_STATUSES.cancelled:
      return "Cancelled";
    case AGENT_UI_FORM_STATUSES.expired:
      return "Expired";
    case AGENT_UI_FORM_STATUSES.validationFailed:
      return "Needs changes";
    default:
      return "Pending";
  }
}

function cssEscape(value: string): string {
  return typeof globalThis.CSS?.escape === "function" ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");
}

function setControlDisabled(control: HTMLElement, disabled: boolean) {
  if (
    control instanceof HTMLInputElement ||
    control instanceof HTMLTextAreaElement ||
    control instanceof HTMLSelectElement ||
    control instanceof HTMLFieldSetElement
  ) {
    control.disabled = disabled;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ownerLabel(owner: GatewayRuntimeStatus["owner"]): string {
  if (owner === "shell") {
    return "Shell-owned";
  }
  if (owner === "external") {
    return "External";
  }
  return "None";
}

function hasTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function syncTsCoworkRuntimeRollout(config: unknown): void {
  gatewayClientOptions.tsCoworkRuntime = resolveTsCoworkRuntimeRollout(config);
}

function formatTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}
