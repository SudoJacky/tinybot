const state = {
  token: "",
  wsPath: "/ws",
  sessionsPath: "/api/sessions",
  workspaceFilesPath: "/api/workspace/files",
  skillsApiPath: "/api/skills",
  knowledgeApiPath: "/v1/knowledge",
  socket: null,
  activeChatId: "",
  activeSessionKey: "",
  messages: new Map(),
  sessionItems: [],
  streamBuffers: new Map(),
  editableFiles: [],
  activeFilePath: "",
  activeFileUpdatedAt: null,
  fileDraftDirty: false,
  tools: [],
  skills: [],
  knowledgeDocs: [],
  knowledgeStats: null,
  config: null,
  pendingMessage: null,  // 待发送的消息（创建新会话后发送）
  activeSkill: null,  // 当前编辑的 skill
  skillMode: "view",  // view, edit, create
  activeDoc: null,  // 当前查看的文档
  theme: "light",  // 当前主题
  contextWindowTokens: 65536,  // 默认上下文窗口大小
  lastUsage: null,  // 最后一次的usage数据
};

const elements = {
  sessionList: document.querySelector("#session-list"),
  sessionCount: document.querySelector("#session-count"),
  chatTitle: document.querySelector("#chat-title"),
  connectionStatus: document.querySelector("#connection-status"),
  messageList: document.querySelector("#message-list"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  newChatButton: document.querySelector("#new-chat-button"),
  refreshButton: document.querySelector("#refresh-button"),
  clearMessagesButton: document.querySelector("#clear-messages-button"),
  hintText: document.querySelector("#hint-text"),
  errorText: document.querySelector("#error-text"),
  messageTemplate: document.querySelector("#message-template"),
  fileSelect: document.querySelector("#file-select"),
  fileEditor: document.querySelector("#file-editor"),
  saveFileButton: document.querySelector("#save-file-button"),
  reloadFileButton: document.querySelector("#reload-file-button"),
  fileMeta: document.querySelector("#file-meta"),
  fileError: document.querySelector("#file-error"),
  editorTitle: document.querySelector("#editor-title"),
  editorStatus: document.querySelector("#editor-status"),
  statusProvider: document.querySelector("#status-provider"),
  statusModel: document.querySelector("#status-model"),
  statusChannel: document.querySelector("#status-channel"),
  toolsList: document.querySelector("#tools-list"),
  refreshToolsButton: document.querySelector("#refresh-tools-button"),
  skillsList: document.querySelector("#skills-list"),
  newSkillButton: document.querySelector("#new-skill-button"),
  refreshSkillsButton: document.querySelector("#refresh-skills-button"),
  editorSection: document.querySelector("#editor-section"),
  editorToggle: document.querySelector("#editor-toggle"),
  settingsButton: document.querySelector("#settings-button"),
  languageToggle: document.querySelector("#language-toggle"),
  modal: document.querySelector("#settings-modal"),
  modalOverlay: document.querySelector("#modal-overlay"),
  modalClose: document.querySelector("#modal-close"),
  configWorkspace: document.querySelector("#config-workspace"),
  configModel: document.querySelector("#config-model"),
  configProvider: document.querySelector("#config-provider"),
  configTemperature: document.querySelector("#config-temperature"),
  configMaxTokens: document.querySelector("#config-max-tokens"),
  configContextWindow: document.querySelector("#config-context-window"),
  configMaxToolIterations: document.querySelector("#config-max-tool-iterations"),
  configReasoningEffort: document.querySelector("#config-reasoning-effort"),
  configTimezone: document.querySelector("#config-timezone"),
  // Knowledge config elements
  configKnowledgeEnabled: document.querySelector("#config-knowledge-enabled"),
  configKnowledgeAutoRetrieve: document.querySelector("#config-knowledge-auto-retrieve"),
  configKnowledgeMaxChunks: document.querySelector("#config-knowledge-max-chunks"),
  configKnowledgeChunkSize: document.querySelector("#config-knowledge-chunk-size"),
  configKnowledgeChunkOverlap: document.querySelector("#config-knowledge-chunk-overlap"),
  configKnowledgeRetrievalMode: document.querySelector("#config-knowledge-retrieval-mode"),
  configKnowledgeRerankEnabled: document.querySelector("#config-knowledge-rerank-enabled"),
  configKnowledgeRerankModel: document.querySelector("#config-knowledge-rerank-model"),
  configKnowledgeRerankApiKey: document.querySelector("#config-knowledge-rerank-api-key"),
  configKnowledgeRerankApiKeyEnvVar: document.querySelector("#config-knowledge-rerank-api-key-env-var"),
  configKnowledgeRerankApiBase: document.querySelector("#config-knowledge-rerank-api-base"),
  configKnowledgeRerankTopN: document.querySelector("#config-knowledge-rerank-top-n"),
  // Embedding config elements
  configEmbeddingProvider: document.querySelector("#config-embedding-provider"),
  configEmbeddingModelName: document.querySelector("#config-embedding-model-name"),
  configEmbeddingApiKey: document.querySelector("#config-embedding-api-key"),
  configEmbeddingApiBase: document.querySelector("#config-embedding-api-base"),
  // Provider config elements
  configProviderSelect: document.querySelector("#config-provider-select"),
  configApiKey: document.querySelector("#config-api-key"),
  configApiBase: document.querySelector("#config-api-base"),
  configWebEnable: document.querySelector("#config-web-enable"),
  configWebProxy: document.querySelector("#config-web-proxy"),
  configSearchProvider: document.querySelector("#config-search-provider"),
  configExecEnable: document.querySelector("#config-exec-enable"),
  configExecTimeout: document.querySelector("#config-exec-timeout"),
  configRestrictWorkspace: document.querySelector("#config-restrict-workspace"),
  configGatewayHost: document.querySelector("#config-gateway-host"),
  configGatewayPort: document.querySelector("#config-gateway-port"),
  configHeartbeatEnable: document.querySelector("#config-heartbeat-enable"),
  configHeartbeatInterval: document.querySelector("#config-heartbeat-interval"),
  configSendProgress: document.querySelector("#config-send-progress"),
  configSendToolHints: document.querySelector("#config-send-tool-hints"),
  configSendRetries: document.querySelector("#config-send-retries"),
  saveConfigButton: document.querySelector("#save-config-button"),
  configError: document.querySelector("#config-error"),
  configSuccess: document.querySelector("#config-success"),
  // Skill modal elements
  skillModal: document.querySelector("#skill-modal"),
  skillModalOverlay: document.querySelector("#skill-modal-overlay"),
  skillModalClose: document.querySelector("#skill-modal-close"),
  skillModalTitle: document.querySelector("#skill-modal-title"),
  skillNameInput: document.querySelector("#skill-name-input"),
  skillDescInput: document.querySelector("#skill-desc-input"),
  skillAlwaysCheckbox: document.querySelector("#skill-always-checkbox"),
  skillSourceDisplay: document.querySelector("#skill-source-display"),
  skillContentEditor: document.querySelector("#skill-content-editor"),
  skillValidateButton: document.querySelector("#skill-validate-button"),
  skillSaveButton: document.querySelector("#skill-save-button"),
  skillDeleteButton: document.querySelector("#skill-delete-button"),
  skillError: document.querySelector("#skill-error"),
  skillSuccess: document.querySelector("#skill-success"),
  skillValidationResult: document.querySelector("#skill-validation-result"),
  // Theme toggle
  themeToggle: document.querySelector("#theme-toggle"),
  // Knowledge panel elements
  knowledgeSection: document.querySelector("#knowledge-section"),
  knowledgeToggle: document.querySelector("#knowledge-toggle"),
  knowledgeStatus: document.querySelector("#knowledge-status"),
  knowledgeStats: document.querySelector("#knowledge-stats"),
  statsDocs: document.querySelector("#stats-docs"),
  statsChunks: document.querySelector("#stats-chunks"),
  docsList: document.querySelector("#docs-list"),
  refreshDocsButton: document.querySelector("#refresh-docs-button"),
  rebuildIndexButton: document.querySelector("#rebuild-index-button"),
  addDocButton: document.querySelector("#add-doc-button"),
  uploadDocButton: document.querySelector("#upload-doc-button"),
  docFileUpload: document.querySelector("#doc-file-upload"),
  queryInput: document.querySelector("#query-input"),
  queryMode: document.querySelector("#query-mode"),
  queryTopK: document.querySelector("#query-top-k"),
  queryButton: document.querySelector("#query-button"),
  queryResults: document.querySelector("#query-results"),
  // Doc modal elements
  docModal: document.querySelector("#doc-modal"),
  docModalOverlay: document.querySelector("#doc-modal-overlay"),
  docModalClose: document.querySelector("#doc-modal-close"),
  docNameInput: document.querySelector("#doc-name-input"),
  docCategoryInput: document.querySelector("#doc-category-input"),
  docTagsInput: document.querySelector("#doc-tags-input"),
  docFileTypeSelect: document.querySelector("#doc-file-type-select"),
  docContentEditor: document.querySelector("#doc-content-editor"),
  docSaveButton: document.querySelector("#doc-save-button"),
  docError: document.querySelector("#doc-error"),
  docSuccess: document.querySelector("#doc-success"),
  // Doc view modal elements
  docViewModal: document.querySelector("#doc-view-modal"),
  docViewModalOverlay: document.querySelector("#doc-view-modal-overlay"),
  docViewModalClose: document.querySelector("#doc-view-modal-close"),
  docViewId: document.querySelector("#doc-view-id"),
  docViewName: document.querySelector("#doc-view-name"),
  docViewCategory: document.querySelector("#doc-view-category"),
  docViewTags: document.querySelector("#doc-view-tags"),
  docViewCreated: document.querySelector("#doc-view-created"),
  docViewContent: document.querySelector("#doc-view-content"),
  docViewDeleteButton: document.querySelector("#doc-view-delete-button"),
  docViewCloseButton: document.querySelector("#doc-view-close-button"),
  // Tools modal elements (列表弹窗)
  toolsModal: document.querySelector("#tools-modal"),
  toolsModalOverlay: document.querySelector("#tools-modal-overlay"),
  toolsModalClose: document.querySelector("#tools-modal-close"),
  toolsModalList: document.querySelector("#tools-modal-list"),
  toolsToggle: document.querySelector("#tools-toggle"),
  // Skills modal elements (列表弹窗)
  skillsModal: document.querySelector("#skills-modal"),
  skillsModalOverlay: document.querySelector("#skills-modal-overlay"),
  skillsModalClose: document.querySelector("#skills-modal-close"),
  skillsModalList: document.querySelector("#skills-modal-list"),
  skillsToggle: document.querySelector("#skills-toggle"),
  skillsCount: document.querySelector("#skills-count"),
  skillsEnabledCount: document.querySelector("#skills-enabled-count"),
  // Tool modal elements (详情弹窗)
  toolModal: document.querySelector("#tool-modal"),
  toolModalOverlay: document.querySelector("#tool-modal-overlay"),
  toolModalClose: document.querySelector("#tool-modal-close"),
  toolModalTitle: document.querySelector("#tool-modal-title"),
  toolModalName: document.querySelector("#tool-modal-name"),
  toolModalDesc: document.querySelector("#tool-modal-desc"),
  toolModalSchema: document.querySelector("#tool-modal-schema"),
  toolModalCloseButton: document.querySelector("#tool-modal-close-button"),
  // Knowledge modal elements
  knowledgeModal: document.querySelector("#knowledge-modal"),
  knowledgeModalOverlay: document.querySelector("#knowledge-modal-overlay"),
  knowledgeModalClose: document.querySelector("#knowledge-modal-close"),
  modalStatsDocs: document.querySelector("#modal-stats-docs"),
  modalStatsChunks: document.querySelector("#modal-stats-chunks"),
  // Workspace modal elements
  workspaceModal: document.querySelector("#workspace-modal"),
  workspaceModalOverlay: document.querySelector("#workspace-modal-overlay"),
  workspaceModalClose: document.querySelector("#workspace-modal-close"),
  workspaceModalTitle: document.querySelector("#workspace-modal-title"),
  workspaceToggle: document.querySelector("#workspace-toggle"),
  currentFileName: document.querySelector("#current-file-name"),
  toolsCount: document.querySelector("#tools-count"),
};

function setStatus(text, kind = "idle") {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.className = `status status-${kind}`;
}

function setError(text = "") {
  elements.errorText.textContent = text;
}

function setEditorStatus(text, kind = "idle") {
  if (elements.editorStatus) {
    elements.editorStatus.textContent = text;
    elements.editorStatus.className = `status status-${kind}`;
  }
}

function setFileError(text = "") {
  elements.fileError.textContent = text;
}

function updateUsageDisplay(usage) {
  state.lastUsage = usage;
  const container = document.querySelector("#status-usage");
  if (!usage || !container) {
    if (container) {
      container.innerHTML = "-";
    }
    return;
  }
  const prompt = usage.prompt_tokens || 0;
  const completion = usage.completion_tokens || 0;
  const total = usage.total_tokens || 0;
  const cached = usage.cached_tokens || 0;
  const contextWindow = state.contextWindowTokens || 65536;

  // 计算占比
  const ratio = Math.min(1, total / contextWindow);
  const percent = Math.round(ratio * 100);

  // 根据占比决定颜色: <50%绿色, 50-75%黄色, 75-90%橙色, >90%红色
  let colorClass = "usage-bar-safe";
  if (ratio >= 0.9) {
    colorClass = "usage-bar-danger";
  } else if (ratio >= 0.75) {
    colorClass = "usage-bar-warning";
  } else if (ratio >= 0.5) {
    colorClass = "usage-bar-caution";
  }

  // 构建进度条HTML
  const lang = getLanguage();
  const labelText = lang === "zh"
    ? `输入:${prompt} 输出:${completion}`
    : `In:${prompt} Out:${completion}`;
  const totalText = lang === "zh"
    ? `${total}/${contextWindow}`
    : `${total}/${contextWindow}`;
  const cachedText = cached > 0
    ? (lang === "zh" ? `缓存:${cached}` : `Cache:${cached}`)
    : "";

  container.innerHTML = `
    <div class="usage-bar-wrapper">
      <div class="usage-bar-track">
        <div class="usage-bar-fill ${colorClass}" style="width: ${percent}%"></div>
      </div>
      <div class="usage-bar-text">
        <span class="usage-detail">${labelText}</span>
        <span class="usage-total">${totalText} (${percent}%)</span>
        ${cachedText ? `<span class="usage-cached">${cachedText}</span>` : ""}
      </div>
    </div>
  `;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${state.token}`,
    "Content-Type": "application/json",
  };
}

function resizeComposer() {
  elements.composerInput.style.height = "auto";
  elements.composerInput.style.height = `${Math.min(elements.composerInput.scrollHeight, 220)}px`;
}

function scrollMessagesToBottom(force = false) {
  const nearBottom =
    elements.messageList.scrollHeight - elements.messageList.scrollTop - elements.messageList.clientHeight < 120;
  if (force || nearBottom) {
    elements.messageList.scrollTop = elements.messageList.scrollHeight;
  }
}

function formatTime(value) {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const lang = getLanguage();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function sessionKeyForChat(chatId) {
  return chatId ? `websocket:${chatId}` : "";
}

function roleLabel(role) {
  if (role === "assistant") {
    return "assistant";
  }
  if (role === "user") {
    return "user";
  }
  if (role === "tool") {
    return "tool";
  }
  if (role === "progress") {
    return "progress";
  }
  return "system";
}

function renderMessages() {
  const key = state.activeSessionKey;
  const messages = state.messages.get(key) || [];
  elements.messageList.textContent = "";

  if (!key) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noSession");
    elements.messageList.append(empty);
    return;
  }

  if (messages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noMessages");
    elements.messageList.append(empty);
    return;
  }

  for (const message of messages) {
    const node = createMessageNode(message);
    elements.messageList.append(node);
  }

  scrollMessagesToBottom(true);
}

function createMessageNode(message) {
  const node = elements.messageTemplate.content.firstElementChild.cloneNode(true);
  node.classList.add(`message-${roleLabel(message.role)}`);
  node.dataset.messageId = message.message_id || "";

  // Handle role display for tool messages
  let roleDisplay = roleLabel(message.role);
  if (message.role === "tool" && message.name) {
    roleDisplay = `tool: ${message.name}`;
  }
  if (message.role === "progress") {
    roleDisplay = "tool";
    if (message._tool_name) {
      roleDisplay = `tool: ${message._tool_name}`;
    }
  }
  node.querySelector(".message-role").textContent = roleDisplay;
  node.querySelector(".message-time").textContent = formatTime(message.timestamp);

  const contentEl = node.querySelector(".message-content");
  updateMessageContent(contentEl, message);

  // 添加消息复制按钮（仅对user和assistant消息）
  if (message.role === "user" || message.role === "assistant") {
    const metaEl = node.querySelector(".message-meta");
    if (metaEl) {
      const copyBtn = document.createElement("button");
      copyBtn.className = "message-copy-btn";
      copyBtn.textContent = t("ui.copy");
      copyBtn.title = t("ui.copyContent");
      copyBtn.addEventListener("click", async () => {
        try {
          const textToCopy = message.content || "";
          await navigator.clipboard.writeText(textToCopy);
          copyBtn.textContent = t("ui.copied");
          setTimeout(() => {
            copyBtn.textContent = t("ui.copy");
          }, 1500);
        } catch {
          copyBtn.textContent = t("ui.copyFailed");
          setTimeout(() => {
            copyBtn.textContent = t("ui.copy");
          }, 1500);
        }
      });
      metaEl.appendChild(copyBtn);
    }
  }

  return node;
}

function updateMessageContent(contentEl, message) {
  contentEl.textContent = "";

  if (message.reasoning_content && message.reasoning_content.trim()) {
    const reasoningEl = document.createElement("div");
    reasoningEl.className = "message-reasoning";
    reasoningEl.textContent = message.reasoning_content;
    contentEl.append(reasoningEl);
  }

  // Handle tool_calls for assistant messages
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const toolCallsEl = document.createElement("div");
    toolCallsEl.className = "tool-calls";
    for (const tc of message.tool_calls) {
      const callEl = document.createElement("div");
      callEl.className = "tool-call";
      const name = tc.function?.name || tc.name || "unknown";
      const args = tc.function?.arguments || tc.arguments || "";
      callEl.textContent = `▸ ${name}(${args.length > 100 ? args.slice(0, 100) + "..." : args})`;
      toolCallsEl.append(callEl);
    }
    contentEl.append(toolCallsEl);
  }

  if (message.content && message.content.trim()) {
    const textEl = document.createElement("div");
    textEl.className = "message-text";

    // 对assistant消息使用Markdown渲染
    if (message.role === "assistant" && typeof marked !== "undefined") {
      try {
        marked.setOptions({
          breaks: true,
          gfm: true,
        });
        textEl.innerHTML = marked.parse(message.content);
        // 应用代码语法高亮和添加复制按钮
        if (typeof hljs !== "undefined") {
          textEl.querySelectorAll("pre code").forEach((block) => {
            hljs.highlightElement(block);
            // 添加复制按钮到代码块
            const pre = block.parentElement;
            if (pre && !pre.querySelector(".code-copy-btn")) {
              const copyBtn = document.createElement("button");
              copyBtn.className = "code-copy-btn";
              copyBtn.textContent = t("ui.copy");
              copyBtn.addEventListener("click", async () => {
                try {
                  await navigator.clipboard.writeText(block.textContent);
                  copyBtn.textContent = t("ui.copied");
                  setTimeout(() => {
                    copyBtn.textContent = t("ui.copy");
                  }, 1500);
                } catch {
                  copyBtn.textContent = t("ui.copyFailed");
                  setTimeout(() => {
                    copyBtn.textContent = t("ui.copy");
                  }, 1500);
                }
              });
              pre.appendChild(copyBtn);
            }
          });
        }
      } catch {
        textEl.textContent = message.content;
      }
    } else if (message.role === "tool" || message.role === "progress") {
      // Tool results are often truncated/preformatted, show as code-like
      textEl.textContent = message.content;
    } else {
      textEl.textContent = message.content;
    }

    contentEl.append(textEl);
  }
}

function updateStreamMessageDOM(messageId) {
  const streamState = state.streamBuffers.get(messageId);
  if (!streamState) return;

  const existingNode = elements.messageList.querySelector(`[data-message-id="${messageId}"]`);
  if (existingNode) {
    const contentEl = existingNode.querySelector(".message-content");
    updateMessageContent(contentEl, streamState.entry);
    scrollMessagesToBottom(false);
  }
}

function renderSessions() {
  elements.sessionList.textContent = "";
  elements.sessionCount.textContent = String(state.sessionItems.length);

  if (state.sessionItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noSessions");
    elements.sessionList.append(empty);
    return;
  }

  for (const item of state.sessionItems) {
    const wrapper = document.createElement("div");
    wrapper.className = "session-item-wrapper";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "session-item";
    if (item.key === state.activeSessionKey) {
      button.classList.add("active");
    }
    button.dataset.chatId = item.chat_id;

    const key = document.createElement("span");
    key.className = "session-key";
    key.textContent = item.chat_id;

    const time = document.createElement("span");
    time.className = "session-time";
    time.textContent = item.updated_at ? `${t("ui.updatedAt")} ${formatTime(item.updated_at)}` : t("ui.noTime");

    button.append(key, time);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "button button-ghost button-small session-delete";
    deleteBtn.dataset.chatId = item.chat_id;
    deleteBtn.dataset.sessionKey = item.key;
    deleteBtn.title = t("ui.deleteSession");
    deleteBtn.textContent = "×";

    wrapper.append(button, deleteBtn);
    elements.sessionList.append(wrapper);
  }
}

function renderEditableFiles() {
  elements.fileSelect.textContent = "";
  for (const item of state.editableFiles) {
    const option = document.createElement("option");
    option.value = item.path;
    option.textContent = item.path;
    if (item.path === state.activeFilePath) {
      option.selected = true;
    }
    elements.fileSelect.append(option);
  }
}

function activateChat(chatId) {
  state.activeChatId = chatId;
  state.activeSessionKey = sessionKeyForChat(chatId);
  elements.chatTitle.textContent = chatId || t("ui.notConnected");
  renderSessions();
  renderMessages();
}

async function bootstrap() {
  setStatus(t("status.connecting"), "idle");
  const response = await fetch("/webui/bootstrap");
  if (!response.ok) {
    throw new Error(`bootstrap failed: ${response.status}`);
  }
  const payload = await response.json();
  state.token = payload.token;
  state.wsPath = payload.ws_path || "/ws";
  state.sessionsPath = payload.sessions_path || "/api/sessions";
  state.workspaceFilesPath = payload.workspace_files_path || "/api/workspace/files";
}

async function loadSessions() {
  const response = await fetch(state.sessionsPath, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load sessions failed: ${response.status}`);
  }

  const payload = await response.json();
  state.sessionItems = payload.items || [];
  renderSessions();

  if (!state.activeChatId && state.sessionItems.length > 0) {
    await attachSession(state.sessionItems[0].chat_id);
  }
}

async function loadMessages(sessionKey) {
  const response = await fetch(`${state.sessionsPath}/${encodeURIComponent(sessionKey)}/messages`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load messages failed: ${response.status}`);
  }
  const payload = await response.json();
  state.messages.set(sessionKey, payload.messages || []);
  renderMessages();
}

async function clearSession(sessionKey) {
  const response = await fetch(`${state.sessionsPath}/${encodeURIComponent(sessionKey)}/clear`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`clear session failed: ${response.status}`);
  }
  state.messages.set(sessionKey, []);
  renderMessages();
  setEditorStatus(t("status.cleared"), "connected");
}

async function deleteSession(sessionKey, chatId) {
  const response = await fetch(`${state.sessionsPath}/${encodeURIComponent(sessionKey)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`delete session failed: ${response.status}`);
  }

  // Remove from local state
  state.messages.delete(sessionKey);
  state.sessionItems = state.sessionItems.filter((item) => item.key !== sessionKey);

  // If deleted session was active, switch to another
  if (state.activeSessionKey === sessionKey) {
    if (state.sessionItems.length > 0) {
      await attachSession(state.sessionItems[0].chat_id);
    } else {
      state.activeChatId = "";
      state.activeSessionKey = "";
      elements.chatTitle.textContent = t("ui.notConnected");
    }
  }

  renderSessions();
  renderMessages();
}

async function loadEditableFiles() {
  const response = await fetch(state.workspaceFilesPath, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load files failed: ${response.status}`);
  }
  const payload = await response.json();
  state.editableFiles = payload.items || [];
  if (!state.activeFilePath && state.editableFiles.length > 0) {
    state.activeFilePath = state.editableFiles[0].path;
  }
  renderEditableFiles();
  if (state.activeFilePath) {
    await loadFile(state.activeFilePath);
  }
}

async function loadSystemStatus() {
  const response = await fetch("/api/status", {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load status failed: ${response.status}`);
  }
  const payload = await response.json();

  // Update status display
  if (payload.provider && payload.provider.name) {
    elements.statusProvider.textContent = payload.provider.name;
  } else {
    elements.statusProvider.textContent = t("status.notConfigured");
  }

  if (payload.model) {
    elements.statusModel.textContent = payload.model;
  } else {
    elements.statusModel.textContent = t("status.notConfigured");
  }

  if (payload.channels && payload.channels.websocket) {
    const wsChannel = payload.channels.websocket;
    elements.statusChannel.textContent = wsChannel.running ? t("status.running") : t("status.stopped");
    elements.statusChannel.className = wsChannel.running ? "status-value status-ok" : "status-value status-warn";
  }
}

async function loadTools() {
  const response = await fetch("/api/tools", {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load tools failed: ${response.status}`);
  }
  const payload = await response.json();
  state.tools = payload.tools || [];
  renderTools();
  // If tools modal is open, update the list
  if (elements.toolsModal && elements.toolsModal.classList.contains("active")) {
    renderToolsModalList();
  }
}

async function loadSkills() {
  const response = await fetch("/api/skills", {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load skills failed: ${response.status}`);
  }
  const payload = await response.json();
  state.skills = payload.skills || [];
  renderSkills();
  // If skills modal is open, update the list
  if (elements.skillsModal && elements.skillsModal.classList.contains("active")) {
    renderSkillsModalList();
  }
}

function renderTools() {
  // 只更新统计信息
  elements.toolsCount.textContent = state.tools.length;
}

function renderSkills() {
  // 只更新统计信息
  const enabledSkills = state.config?.skills?.enabled || null;
  const isAllEnabled = !enabledSkills || enabledSkills.includes("*");

  let enabledCount = 0;
  for (const skill of state.skills) {
    if (skill.available && skill.always) {
      enabledCount++;
    } else if (skill.available) {
      if (isAllEnabled || enabledSkills.includes(skill.name)) {
        enabledCount++;
      }
    }
  }

  elements.skillsCount.textContent = state.skills.length;
  elements.skillsEnabledCount.textContent = enabledCount;
}

// 弹窗内渲染工具列表
function renderToolsModalList() {
  elements.toolsModalList.textContent = "";

  if (state.tools.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noTools");
    elements.toolsModalList.append(empty);
    return;
  }

  for (const tool of state.tools) {
    const item = document.createElement("div");
    item.className = "modal-list-item";

    const name = document.createElement("span");
    name.className = "modal-list-item-name";
    name.textContent = tool.name;

    const desc = document.createElement("span");
    desc.className = "modal-list-item-desc";
    desc.textContent = tool.description || t("msg.noDescription");

    item.append(name, desc);
    item.addEventListener("click", () => viewTool(tool.name));
    elements.toolsModalList.append(item);
  }
}

// 弹窗内渲染技能列表
function renderSkillsModalList() {
  elements.skillsModalList.textContent = "";

  if (state.skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noSkills");
    elements.skillsModalList.append(empty);
    return;
  }

  const enabledSkills = state.config?.skills?.enabled || null;
  const isAllEnabled = !enabledSkills || enabledSkills.includes("*");

  for (const skill of state.skills) {
    const item = document.createElement("div");
    item.className = "modal-list-item";

    // Name
    const name = document.createElement("span");
    name.className = "modal-list-item-name";
    name.textContent = skill.name;
    name.style.cursor = "pointer";
    name.addEventListener("click", () => viewSkill(skill.name));

    // Toggle section
    const toggleSection = document.createElement("div");
    toggleSection.className = "skill-toggle-section";

    const toggleSwitch = document.createElement("div");
    toggleSwitch.className = "toggle-switch";

    if (!skill.available) {
      toggleSwitch.classList.add("toggle-unavailable");
      toggleSwitch.innerHTML = `<span class="toggle-label">${t("status.unavailable")}</span>`;
    } else if (skill.always) {
      toggleSwitch.classList.add("toggle-always", "toggle-on");
      toggleSwitch.innerHTML = `<span class="toggle-label">${t("status.always")}</span>`;
    } else {
      const isEnabled = isAllEnabled || enabledSkills.includes(skill.name);
      toggleSwitch.classList.add(isEnabled ? "toggle-on" : "toggle-off");
      toggleSwitch.classList.add("toggle-clickable");
      toggleSwitch.innerHTML = `<span class="toggle-slider"></span>`;
      toggleSwitch.title = isEnabled ? t("ui.clickToDisable") : t("ui.clickToEnable");
      toggleSwitch.addEventListener("click", () => toggleSkill(skill.name, !isEnabled));
    }

    // Delete button for workspace skills
    if (skill.source === "workspace") {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "skill-delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = t("ui.delete");
      deleteBtn.addEventListener("click", () => deleteSkill(skill.name));
      toggleSection.append(deleteBtn);
    }

    toggleSection.append(toggleSwitch);
    item.append(name, toggleSection);
    elements.skillsModalList.append(item);
  }
}

function viewTool(toolName) {
  const tool = state.tools.find(t => t.name === toolName);
  if (!tool) return;

  elements.toolModalTitle.textContent = toolName;
  elements.toolModalName.textContent = toolName;
  elements.toolModalDesc.textContent = tool.description || t("msg.noDescription");

  // Display schema/parameters
  if (tool.parameters) {
    try {
      elements.toolModalSchema.textContent = JSON.stringify(tool.parameters, null, 2);
    } catch {
      elements.toolModalSchema.textContent = tool.parameters;
    }
  } else {
    elements.toolModalSchema.textContent = t("msg.noParameters") || "无参数定义";
  }

  elements.toolModal.classList.add("active");
}

function closeToolModal() {
  elements.toolModal.classList.remove("active");
}

// 打开工具列表弹窗
function openToolsModal() {
  renderToolsModalList();
  elements.toolsModal.classList.add("active");
}

function closeToolsModal() {
  elements.toolsModal.classList.remove("active");
}

// 打开技能列表弹窗
function openSkillsModal() {
  renderSkillsModalList();
  elements.skillsModal.classList.add("active");
}

function closeSkillsModal() {
  elements.skillsModal.classList.remove("active");
}

async function toggleSkill(skillName, enable) {
  try {
    // Get current enabled skills
    let currentEnabled = state.config?.skills?.enabled || [];
    const isAllEnabled = !currentEnabled || currentEnabled.includes("*");

    // Build new enabled list
    let newEnabled;
    if (enable) {
      // Enable this skill
      if (isAllEnabled) {
        // If all enabled, keep "*"
        newEnabled = ["*"];
      } else {
        // Add skill to list if not already there
        newEnabled = currentEnabled.includes(skillName) ? currentEnabled : [...currentEnabled, skillName];
      }
    } else {
      // Disable this skill
      if (isAllEnabled) {
        // If all enabled, we need to build explicit list excluding this skill
        const allSkillNames = state.skills
          .filter(s => s.available && s.name !== skillName && !s.always)
          .map(s => s.name);
        newEnabled = allSkillNames;
      } else {
        // Remove skill from list
        newEnabled = currentEnabled.filter(s => s !== skillName);
      }
    }

    // Send PATCH request
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify({ skills: { enabled: newEnabled } }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `${t("settings.saveFailed")}: ${response.status}`);
    }

    const result = await response.json();
    state.config = result.config || state.config;
    // Update skills config in state
    if (state.config && result.config?.skills) {
      state.config.skills = result.config.skills;
    }

    // Reload skills to refresh enabled status
    await loadSkills();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
  }
}

// ============ Skill Modal Functions ============

function openSkillModal() {
  elements.skillModal.classList.add("active");
  elements.skillError.textContent = "";
  elements.skillSuccess.textContent = "";
  elements.skillValidationResult.textContent = "";
  elements.skillValidationResult.className = "skill-validation-result";
}

function closeSkillModal() {
  elements.skillModal.classList.remove("active");
  state.activeSkill = null;
  state.skillMode = "view";
}

async function viewSkill(skillName) {
  try {
    const response = await fetch(`${state.skillsApiPath}/${encodeURIComponent(skillName)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      throw new Error(`load skill failed: ${response.status}`);
    }

    const payload = await response.json();
    state.activeSkill = payload;
    state.skillMode = "edit";

    // Populate modal
    elements.skillModalTitle.textContent = payload.name;
    elements.skillNameInput.value = payload.name;
    elements.skillNameInput.disabled = true;  // Can't rename existing skill
    elements.skillDescInput.value = payload.tinybot_meta?.description || payload.metadata?.description || "";
    elements.skillAlwaysCheckbox.checked = payload.tinybot_meta?.always || payload.metadata?.always || false;
    // Get source from state.skills (API doesn't return source in detail endpoint)
    const skillInfo = state.skills.find(s => s.name === skillName);
    elements.skillSourceDisplay.textContent = skillInfo?.source || "unknown";
    elements.skillContentEditor.value = payload.content || "";

    // Show/hide delete button based on source
    elements.skillDeleteButton.style.display = skillInfo?.source === "workspace" ? "inline-block" : "none";

    openSkillModal();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
  }
}

async function createNewSkill() {
  state.activeSkill = null;
  state.skillMode = "create";

  elements.skillModalTitle.textContent = t("skill.new");
  elements.skillNameInput.value = "";
  elements.skillNameInput.disabled = false;
  elements.skillDescInput.value = "";
  elements.skillAlwaysCheckbox.checked = false;
  elements.skillSourceDisplay.textContent = t("skill.workspaceNew");
  elements.skillContentEditor.value = "";
  elements.skillDeleteButton.style.display = "none";

  openSkillModal();
}

async function saveSkill() {
  elements.skillError.textContent = "";
  elements.skillSuccess.textContent = "";

  const name = elements.skillNameInput.value.trim();
  const description = elements.skillDescInput.value.trim();
  const always = elements.skillAlwaysCheckbox.checked;
  const content = elements.skillContentEditor.value;

  if (!name) {
    elements.skillError.textContent = t("skill.nameRequired");
    return;
  }

  try {
    if (state.skillMode === "create") {
      // Create new skill
      const response = await fetch(state.skillsApiPath, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name, description, content, always }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t("skill.createFailed"));
      }

      const result = await response.json();
      elements.skillSuccess.textContent = t("skill.created");
      state.activeSkill = { name: result.name };
      state.skillMode = "edit";
      elements.skillNameInput.disabled = true;
      elements.skillDeleteButton.style.display = "inline-block";
    } else {
      // Update existing skill
      const response = await fetch(`${state.skillsApiPath}/${encodeURIComponent(state.activeSkill.name)}`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ description, content, always }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || t("skill.updateFailed"));
      }

      elements.skillSuccess.textContent = t("skill.updated");
    }

    // Reload skills list
    await loadSkills();
  } catch (error) {
    console.error(error);
    elements.skillError.textContent = error.message || t("status.failed");
  }
}

async function deleteSkill(skillName) {
  if (!confirm(`${t("ui.confirmDelete")} ${skillName}?`)) {
    return;
  }

  try {
    const response = await fetch(`${state.skillsApiPath}/${encodeURIComponent(skillName)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || t("skill.deleteFailed"));
    }

    // Close modal if deleting the active skill
    if (state.activeSkill?.name === skillName) {
      closeSkillModal();
    }

    // Reload skills list
    await loadSkills();
  } catch (error) {
    console.error(error);
    if (state.activeSkill?.name === skillName) {
      elements.skillError.textContent = error.message || t("status.failed");
    } else {
      setError(error.message || t("status.failed"));
    }
  }
}

async function validateSkill() {
  if (!state.activeSkill?.name) {
    elements.skillValidationResult.textContent = t("skill.saveFirst");
    elements.skillValidationResult.className = "skill-validation-result invalid";
    return;
  }

  try {
    const response = await fetch(`${state.skillsApiPath}/${encodeURIComponent(state.activeSkill.name)}/validate`, {
      method: "POST",
      headers: authHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || t("skill.validateFailed"));
    }

    const result = await response.json();
    if (result.valid) {
      elements.skillValidationResult.textContent = `✓ ${t("skill.valid")}`;
      elements.skillValidationResult.className = "skill-validation-result valid";
    } else {
      elements.skillValidationResult.textContent = `✗ ${result.message || t("skill.invalid")}`;
      elements.skillValidationResult.className = "skill-validation-result invalid";
    }
  } catch (error) {
    console.error(error);
    elements.skillValidationResult.textContent = error.message || t("status.failed");
    elements.skillValidationResult.className = "skill-validation-result invalid";
  }
}

// ============ Knowledge Functions ============

async function loadKnowledgeStats() {
  try {
    const response = await fetch(`${state.knowledgeApiPath}/stats`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      if (response.status === 503) {
        // Knowledge store not initialized
        elements.statsDocs.textContent = "-";
        elements.statsChunks.textContent = "-";
        if (elements.modalStatsDocs) elements.modalStatsDocs.textContent = "-";
        if (elements.modalStatsChunks) elements.modalStatsChunks.textContent = "-";
        return;
      }
      throw new Error(`load knowledge stats failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("knowledge stats API returned non-JSON response");
    }
    const payload = await response.json();
    state.knowledgeStats = payload;
    elements.statsDocs.textContent = payload.total_documents || 0;
    elements.statsChunks.textContent = payload.total_chunks || 0;
    if (elements.modalStatsDocs) elements.modalStatsDocs.textContent = payload.total_documents || 0;
    if (elements.modalStatsChunks) elements.modalStatsChunks.textContent = payload.total_chunks || 0;
  } catch (error) {
    console.error(error);
    elements.statsDocs.textContent = "-";
    elements.statsChunks.textContent = "-";
    if (elements.modalStatsDocs) elements.modalStatsDocs.textContent = "-";
    if (elements.modalStatsChunks) elements.modalStatsChunks.textContent = "-";
  }
}

async function loadKnowledgeDocs() {
  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents`, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      if (response.status === 503) {
        // Knowledge store not initialized
        elements.docsList.textContent = "";
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = t("status.unavailable");
        elements.docsList.append(empty);
        return;
      }
      throw new Error(`load knowledge docs failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      throw new Error("knowledge API returned non-JSON response");
    }
    const payload = await response.json();
    state.knowledgeDocs = payload.data || [];
    renderKnowledgeDocs();
  } catch (error) {
    console.error(error);
    elements.docsList.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("status.loadFailed");
    elements.docsList.append(empty);
  }
}

function renderKnowledgeDocs() {
  elements.docsList.textContent = "";

  if (state.knowledgeDocs.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("knowledge.noDocs");
    elements.docsList.append(empty);
    return;
  }

  for (const doc of state.knowledgeDocs) {
    const item = document.createElement("div");
    item.className = "doc-item";

    const headerRow = document.createElement("div");
    headerRow.className = "doc-header-row";

    const nameSection = document.createElement("div");
    nameSection.className = "doc-name-section";

    const name = document.createElement("span");
    name.className = "doc-name doc-name-clickable";
    name.textContent = doc.name;
    name.title = t("ui.clickToView");
    name.addEventListener("click", () => viewDoc(doc.id));

    nameSection.append(name);

    const metaSection = document.createElement("div");
    metaSection.className = "doc-meta-section";

    const chunks = document.createElement("span");
    chunks.className = "doc-chunks";
    chunks.textContent = `${doc.chunk_count || 0} ${t("knowledge.chunks")}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "doc-delete-btn";
    deleteBtn.textContent = "×";
    deleteBtn.title = t("ui.delete");
    deleteBtn.addEventListener("click", () => deleteDoc(doc.id, doc.name));

    metaSection.append(chunks, deleteBtn);
    headerRow.append(nameSection, metaSection);

    const descRow = document.createElement("div");
    descRow.className = "doc-desc-row";

    const category = doc.category || t("knowledge.noCategory");
    const categorySpan = document.createElement("span");
    categorySpan.className = "doc-category";
    categorySpan.textContent = category;

    const tags = doc.tags || [];
    if (tags.length > 0) {
      const tagsSpan = document.createElement("span");
      tagsSpan.className = "doc-tags";
      tagsSpan.textContent = tags.join(", ");
      descRow.append(categorySpan, tagsSpan);
    } else {
      descRow.append(categorySpan);
    }

    item.append(headerRow, descRow);
    elements.docsList.append(item);
  }
}

function openKnowledgeModal() {
  // Update modal stats from sidebar stats
  elements.modalStatsDocs.textContent = elements.statsDocs.textContent;
  elements.modalStatsChunks.textContent = elements.statsChunks.textContent;
  elements.knowledgeModal.classList.add("active");
}

function closeKnowledgeModal() {
  elements.knowledgeModal.classList.remove("active");
}

function openWorkspaceModal() {
  elements.workspaceModal.classList.add("active");
}

function closeWorkspaceModal() {
  elements.workspaceModal.classList.remove("active");
}

function openDocModal() {
  elements.docModal.classList.add("active");
  elements.docError.textContent = "";
  elements.docSuccess.textContent = "";
}

function closeDocModal() {
  elements.docModal.classList.remove("active");
  state.activeDoc = null;
}

function openDocViewModal() {
  elements.docViewModal.classList.add("active");
}

function closeDocViewModal() {
  elements.docViewModal.classList.remove("active");
  state.activeDoc = null;
}

async function viewDoc(docId) {
  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents/${encodeURIComponent(docId)}`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      throw new Error(`load doc failed: ${response.status}`);
    }

    const doc = await response.json();
    state.activeDoc = doc;

    elements.docViewId.textContent = doc.id;
    elements.docViewName.textContent = doc.name;
    elements.docViewCategory.textContent = doc.category || t("knowledge.noCategory");
    elements.docViewTags.textContent = (doc.tags || []).join(", ") || "-";
    elements.docViewCreated.textContent = doc.created_at ? formatTime(doc.created_at) : "-";
    elements.docViewContent.value = doc.content || "";

    openDocViewModal();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
  }
}

async function addDoc() {
  elements.docError.textContent = "";
  elements.docSuccess.textContent = "";

  const name = elements.docNameInput.value.trim();
  const content = elements.docContentEditor.value;

  if (!name) {
    elements.docError.textContent = t("knowledge.nameRequired");
    return;
  }
  if (!content) {
    elements.docError.textContent = t("knowledge.contentRequired");
    return;
  }

  const tags = elements.docTagsInput.value.trim()
    ? elements.docTagsInput.value.split(",").map(t => t.trim()).filter(t => t)
    : [];
  const category = elements.docCategoryInput.value.trim() || "";
  const fileType = elements.docFileTypeSelect.value;

  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        name,
        content,
        tags,
        category,
        file_type: fileType,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.addFailed"));
    }

    elements.docSuccess.textContent = t("knowledge.docAdded");
    elements.docNameInput.value = "";
    elements.docCategoryInput.value = "";
    elements.docTagsInput.value = "";
    elements.docContentEditor.value = "";

    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  } catch (error) {
    console.error(error);
    elements.docError.textContent = error.message || t("status.failed");
  }
}

async function uploadDoc() {
  const fileInput = elements.docFileUpload;
  const file = fileInput.files[0];
  if (!file) {
    return;
  }

  // Reset the input so the same file can be uploaded again
  fileInput.value = "";

  // Build FormData
  const formData = new FormData();
  formData.append("file", file);

  // Optional: category and tags
  const category = elements.docCategoryInput.value.trim();
  const tags = elements.docTagsInput.value.trim();
  if (category) {
    formData.append("category", category);
  }
  if (tags) {
    formData.append("tags", tags);
  }

  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${state.token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.uploadFailed"));
    }

    const result = await response.json();

    // Show success feedback
    elements.docSuccess.textContent = t("knowledge.uploadSuccess") || `File "${result.name}" uploaded (${result.size_bytes} bytes)`;

    // Refresh docs list
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  } catch (error) {
    console.error(error);
    elements.docError.textContent = error.message || t("status.failed");
  }
}

async function deleteDoc(docId, docName) {
  if (!confirm(`${t("ui.confirmDelete")} ${docName}?`)) {
    return;
  }

  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.deleteFailed"));
    }

    // Close view modal if deleting the active doc
    if (state.activeDoc?.id === docId) {
      closeDocViewModal();
    }

    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
  }
}

async function rebuildKnowledgeIndex() {
  if (!confirm(t("knowledge.rebuildConfirm"))) {
    return;
  }

  try {
    const response = await fetch(`${state.knowledgeApiPath}/rebuild-index`, {
      method: "POST",
      headers: authHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.rebuildFailed"));
    }

    const result = await response.json();
    const message = t("knowledge.rebuildSuccess")
      .replace("{chunks}", result.chunks_indexed || 0)
      .replace("{terms}", result.terms_created || 0);

    // Show success notification
    const successEl = document.createElement("div");
    successEl.className = "success-toast";
    successEl.textContent = message;
    successEl.style.cssText = "position:fixed;top:20px;right:20px;padding:12px 20px;background:#2e7d32;color:#fff;border-radius:4px;z-index:1000;";
    document.body.appendChild(successEl);
    setTimeout(() => successEl.remove(), 3000);

    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
  }
}

async function queryKnowledge() {
  const query = elements.queryInput.value.trim();
  if (!query) {
    elements.queryResults.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("knowledge.queryRequired");
    elements.queryResults.append(empty);
    return;
  }

  const mode = elements.queryMode.value;
  const topK = parseInt(elements.queryTopK.value) || 5;

  try {
    elements.queryResults.textContent = "";
    const loading = document.createElement("div");
    loading.className = "empty-state";
    loading.textContent = t("status.loading");
    elements.queryResults.append(loading);

    const response = await fetch(`${state.knowledgeApiPath}/query`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        query,
        top_k: topK,
        mode,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.queryFailed"));
    }

    const result = await response.json();
    renderQueryResults(result);
  } catch (error) {
    console.error(error);
    elements.queryResults.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state error-text";
    empty.textContent = error.message || t("status.failed");
    elements.queryResults.append(empty);
  }
}

function renderQueryResults(result) {
  elements.queryResults.textContent = "";

  if (!result.data || result.data.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("knowledge.noResults");
    elements.queryResults.append(empty);
    return;
  }

  for (const item of result.data) {
    const resultItem = document.createElement("div");
    resultItem.className = "query-result-item";

    const header = document.createElement("div");
    header.className = "query-result-header";

    const docName = document.createElement("span");
    docName.className = "query-result-doc-name";
    docName.textContent = item.doc_name || "unknown";

    const score = document.createElement("span");
    score.className = "query-result-score";
    score.textContent = formatKnowledgeScore(item);

    header.append(docName, score);

    const meta = document.createElement("div");
    meta.className = "query-result-meta";
    const methods = item.matched_methods && item.matched_methods.length
      ? item.matched_methods.join("+")
      : (item.method || "unknown");
    const lineText = item.line_start && item.line_end
      ? `L${item.line_start}-${item.line_end}`
      : "";
  const parts = [
    methods,
    item.rerank_model ? `rerank ${item.rerank_model}` : "",
    item.section_path || "",
    lineText,
    item.block_type || "",
    ].filter(Boolean);
    meta.textContent = parts.join(" · ");

    const content = document.createElement("div");
    content.className = "query-result-content";
    content.textContent = item.content || "";

    const debug = document.createElement("div");
    debug.className = "query-result-debug";
    debug.textContent = formatKnowledgeDebug(item);

    resultItem.append(header, meta, content, debug);
    elements.queryResults.append(resultItem);
  }
}

function formatKnowledgeScore(item) {
  if (item.rerank_score != null) {
    return `rerank ${Number(item.rerank_score).toFixed(4)}`;
  }
  if (item.rrf_score != null) {
    return `rrf ${Number(item.rrf_score).toFixed(4)}`;
  }
  if (item.bm25_score != null) {
    return `bm25 ${Number(item.bm25_score).toFixed(3)}`;
  }
  if (item.dense_distance != null) {
    return `dist ${Number(item.dense_distance).toFixed(3)}`;
  }
  return `${Number(item.score || 0).toFixed(3)}`;
}

function formatKnowledgeDebug(item) {
  const parts = [];
  if (item.rerank_rank != null) {
    const rerank = item.rerank_score != null
      ? `rerank #${item.rerank_rank} score ${Number(item.rerank_score).toFixed(4)}`
      : `rerank #${item.rerank_rank}`;
    parts.push(rerank);
  }
  if (item.dense_rank != null) {
    const dense = item.dense_distance != null
      ? `dense #${item.dense_rank} dist ${Number(item.dense_distance).toFixed(3)}`
      : `dense #${item.dense_rank}`;
    parts.push(dense);
  }
  if (item.sparse_rank != null) {
    const sparse = item.bm25_score != null
      ? `sparse #${item.sparse_rank} bm25 ${Number(item.bm25_score).toFixed(3)}`
      : `sparse #${item.sparse_rank}`;
    parts.push(sparse);
  }
  return parts.join(" · ");
}

function toggleKnowledgePanel() {
  toggleCollapsibleSection(elements.knowledgeSection);
  elements.knowledgeToggle.setAttribute("aria-expanded",
    !elements.knowledgeSection.classList.contains("collapsed"));
}

function toggleCollapsibleSection(section) {
  if (section.classList.contains("collapsed")) {
    section.classList.remove("collapsed");
    section.setAttribute("aria-expanded", "true");
  } else {
    section.classList.add("collapsed");
    section.setAttribute("aria-expanded", "false");
  }
}

function toggleEditorPanel() {
  toggleCollapsibleSection(elements.editorSection);
  elements.editorToggle.setAttribute("aria-expanded",
    !elements.editorSection.classList.contains("collapsed"));
}

// ============ Theme Functions ============

function initTheme() {
  // 从 localStorage 读取主题偏好，默认为 light
  const savedTheme = localStorage.getItem("tinybot-theme") || "light";
  state.theme = savedTheme;
  applyTheme(savedTheme);
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  state.theme = theme;
  // 保存到 localStorage
  localStorage.setItem("tinybot-theme", theme);
  // 同步切换highlight.js主题
  const lightTheme = document.getElementById("hljs-light-theme");
  const darkTheme = document.getElementById("hljs-dark-theme");
  if (lightTheme && darkTheme) {
    if (theme === "dark") {
      lightTheme.disabled = true;
      darkTheme.disabled = false;
    } else {
      lightTheme.disabled = false;
      darkTheme.disabled = true;
    }
  }
  // 重新高亮所有代码块
  if (typeof hljs !== "undefined") {
    document.querySelectorAll(".message-text pre code").forEach((block) => {
      hljs.highlightElement(block);
    });
  }
}

function toggleTheme() {
  const newTheme = state.theme === "light" ? "dark" : "light";
  applyTheme(newTheme);
}

function openModal() {
  elements.modal.classList.add("active");
  elements.configError.textContent = "";
  elements.configSuccess.textContent = "";
}

function closeModal() {
  elements.modal.classList.remove("active");
}

async function loadConfig() {
  const response = await fetch("/api/config", {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load config failed: ${response.status}`);
  }
  const payload = await response.json();
  state.config = payload;
  populateConfigForm(payload);
}

function populateConfigForm(config) {
  // Agent defaults - API返回camelCase格式
  const agents = config.agents || {};
  const defaults = agents.defaults || {};

  // 填充所有字段，使用当前配置值（兼容camelCase和snake_case）
  elements.configWorkspace.value = defaults.workspace || defaults.workspacePath || "~/.tinybot/workspace";
  elements.configModel.value = defaults.model || "";
  elements.configProvider.value = defaults.provider || "auto";
  elements.configTemperature.value = defaults.temperature !== undefined ? defaults.temperature : 0.1;
  elements.configMaxTokens.value = defaults.maxTokens || defaults.max_tokens || 8192;
  elements.configContextWindow.value = defaults.contextWindowTokens || defaults.context_window_tokens || 65536;
  state.contextWindowTokens = defaults.contextWindowTokens || defaults.context_window_tokens || 65536;
  elements.configMaxToolIterations.value = defaults.maxToolIterations || defaults.max_tool_iterations || 200;
  elements.configReasoningEffort.value = defaults.reasoningEffort || defaults.reasoning_effort || "";
  elements.configTimezone.value = defaults.timezone || "UTC";

  // Knowledge config
  const knowledge = config.knowledge || {};
  elements.configKnowledgeEnabled.checked = knowledge.enabled === true;
  elements.configKnowledgeAutoRetrieve.checked = knowledge.autoRetrieve || knowledge.auto_retrieve === true;
  elements.configKnowledgeMaxChunks.value = knowledge.maxChunks || knowledge.max_chunks || 5;
  elements.configKnowledgeChunkSize.value = knowledge.chunkSize || knowledge.chunk_size || 500;
  elements.configKnowledgeChunkOverlap.value = knowledge.chunkOverlap || knowledge.chunk_overlap || 100;
  elements.configKnowledgeRetrievalMode.value = knowledge.retrievalMode || knowledge.retrieval_mode || "hybrid";
  elements.configKnowledgeRerankEnabled.checked = knowledge.rerankEnabled || knowledge.rerank_enabled === true;
  elements.configKnowledgeRerankModel.value = knowledge.rerankModel || knowledge.rerank_model || "qwen3-rerank";
  elements.configKnowledgeRerankApiKey.value = knowledge.rerankApiKey || knowledge.rerank_api_key || "";
  elements.configKnowledgeRerankApiKeyEnvVar.value = knowledge.rerankApiKeyEnvVar || knowledge.rerank_api_key_env_var || "DASHSCOPE_API_KEY";
  elements.configKnowledgeRerankApiBase.value = knowledge.rerankApiBase || knowledge.rerank_api_base || "https://dashscope.aliyuncs.com/compatible-api/v1";
  elements.configKnowledgeRerankTopN.value = knowledge.rerankTopN || knowledge.rerank_top_n || 0;

  // Embedding config (nested in agents.defaults)
  const embedding = defaults.embedding || {};
  elements.configEmbeddingProvider.value = embedding.provider || "local";
  elements.configEmbeddingModelName.value = embedding.modelName || embedding.model_name || "all-MiniLM-L6-v2";
  elements.configEmbeddingApiKey.value = embedding.apiKey || embedding.api_key || "";
  elements.configEmbeddingApiBase.value = embedding.apiBase || embedding.api_base || "";

  // Providers - 根据当前provider选择加载对应的配置
  const providers = config.providers || {};
  const currentProviderName = defaults.provider || "auto";

  // 如果是auto模式，Provider配置区域显示custom的配置
  const displayProvider = currentProviderName === "auto" ? "custom" : currentProviderName;
  elements.configProviderSelect.value = displayProvider;
  loadProviderConfig(providers, displayProvider);

  // Tools
  const tools = config.tools || {};
  const web = tools.web || {};
  elements.configWebEnable.checked = web.enable === true;
  elements.configWebProxy.value = web.proxy || "";
  const searchConfig = web.search || {};
  elements.configSearchProvider.value = searchConfig.provider || "duckduckgo";

  const exec = tools.exec || {};
  elements.configExecEnable.checked = exec.enable === true;
  elements.configExecTimeout.value = exec.timeout || 60;

  elements.configRestrictWorkspace.checked = tools.restrictToWorkspace || tools.restrict_to_workspace === true;

  // Gateway
  const gateway = config.gateway || {};
  elements.configGatewayHost.value = gateway.host || "0.0.0.0";
  elements.configGatewayPort.value = gateway.port || 18790;

  const heartbeat = gateway.heartbeat || {};
  elements.configHeartbeatEnable.checked = heartbeat.enabled === true;
  elements.configHeartbeatInterval.value = heartbeat.intervalS || heartbeat.interval_s || 1800;

  // Channels
  const channels = config.channels || {};
  elements.configSendProgress.checked = channels.sendProgress || channels.send_progress === true;
  elements.configSendToolHints.checked = channels.sendToolHints || channels.send_tool_hints === true;
  elements.configSendRetries.value = channels.sendMaxRetries || channels.send_max_retries || 3;
}

function loadProviderConfig(providers, providerName) {
  const provider = providers[providerName] || {};
  // API返回的是camelCase格式 (apiKey, apiBase)
  elements.configApiKey.value = provider.apiKey || provider.api_key || "";
  elements.configApiBase.value = provider.apiBase || provider.api_base || "";
}

function toggleConfigGroup(groupTitle) {
  const groupContent = groupTitle.nextElementSibling;
  const isCollapsed = groupContent.classList.contains("collapsed");
  if (isCollapsed) {
    groupContent.classList.remove("collapsed");
    groupTitle.classList.remove("collapsed");
    groupTitle.setAttribute("aria-expanded", "true");
  } else {
    groupContent.classList.add("collapsed");
    groupTitle.classList.add("collapsed");
    groupTitle.setAttribute("aria-expanded", "false");
  }
}

async function saveConfig() {
  elements.configError.textContent = "";
  elements.configSuccess.textContent = "";

  // Helper: only include non-empty values
  const getValue = (el, type = "string") => {
    let val = type === "number" ? (el.value ? parseFloat(el.value) || parseInt(el.value) : null) : el.value.trim();
    if (type === "string" && val === "") val = null;
    if (type === "number" && (val === null || val === "" || isNaN(val))) val = null;
    return val;
  };

  // Build payload - matching backend schema structure
  // agents.defaults contains the actual agent config fields
  const payload = {
    agents: {
      defaults: {
        model: getValue(elements.configModel),
        provider: getValue(elements.configProvider),
        workspace: getValue(elements.configWorkspace),
        temperature: getValue(elements.configTemperature, "number"),
        max_tokens: getValue(elements.configMaxTokens, "number"),
        context_window_tokens: getValue(elements.configContextWindow, "number"),
        max_tool_iterations: getValue(elements.configMaxToolIterations, "number"),
        reasoning_effort: getValue(elements.configReasoningEffort),
        timezone: getValue(elements.configTimezone),
        embedding: {
          provider: getValue(elements.configEmbeddingProvider),
          model_name: getValue(elements.configEmbeddingModelName),
          api_key: getValue(elements.configEmbeddingApiKey),
          api_base: getValue(elements.configEmbeddingApiBase),
        },
      },
    },
    knowledge: {
      enabled: elements.configKnowledgeEnabled.checked,
      auto_retrieve: elements.configKnowledgeAutoRetrieve.checked,
      max_chunks: getValue(elements.configKnowledgeMaxChunks, "number"),
      chunk_size: getValue(elements.configKnowledgeChunkSize, "number"),
      chunk_overlap: getValue(elements.configKnowledgeChunkOverlap, "number"),
      retrieval_mode: getValue(elements.configKnowledgeRetrievalMode),
      rerank_enabled: elements.configKnowledgeRerankEnabled.checked,
      rerank_model: getValue(elements.configKnowledgeRerankModel),
      rerank_api_key: getValue(elements.configKnowledgeRerankApiKey),
      rerank_api_key_env_var: getValue(elements.configKnowledgeRerankApiKeyEnvVar),
      rerank_api_base: getValue(elements.configKnowledgeRerankApiBase),
      rerank_top_n: getValue(elements.configKnowledgeRerankTopN, "number"),
    },
    tools: {
      web: {
        enable: elements.configWebEnable.checked,
        proxy: getValue(elements.configWebProxy),
        search: {
          provider: getValue(elements.configSearchProvider),
        },
      },
      exec: {
        enable: elements.configExecEnable.checked,
        timeout: getValue(elements.configExecTimeout, "number"),
      },
      restrict_to_workspace: elements.configRestrictWorkspace.checked,
    },
    gateway: {
      host: getValue(elements.configGatewayHost),
      port: getValue(elements.configGatewayPort, "number"),
      heartbeat: {
        enabled: elements.configHeartbeatEnable.checked,
        interval_s: getValue(elements.configHeartbeatInterval, "number"),
      },
    },
    channels: {
      send_progress: elements.configSendProgress.checked,
      send_tool_hints: elements.configSendToolHints.checked,
      send_max_retries: getValue(elements.configSendRetries, "number"),
    },
    providers: {},
  };

  // Add selected provider config
  const providerName = elements.configProviderSelect.value;
  payload.providers[providerName] = {
    api_key: getValue(elements.configApiKey),
    api_base: getValue(elements.configApiBase),
  };

  try {
    const response = await fetch("/api/config", {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || `${t("settings.saveFailed")}: ${response.status}`);
    }

    const result = await response.json();
    elements.configSuccess.textContent = t("settings.saved");
    state.config = result.config;
    await loadSystemStatus();
  } catch (error) {
    elements.configError.textContent = error.message || t("settings.saveFailed");
  }
}

async function loadFile(path, { preserveDraft = false } = {}) {
  const response = await fetch(`${state.workspaceFilesPath}/${encodeURIComponent(path)}`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    throw new Error(`load file failed: ${response.status}`);
  }

  const payload = await response.json();
  state.activeFilePath = payload.path;
  state.activeFileUpdatedAt = payload.updated_at;
  state.fileDraftDirty = false;
  // Update modal title and sidebar file name
  if (elements.workspaceModalTitle) {
    elements.workspaceModalTitle.textContent = payload.path;
  }
  if (elements.editorTitle) {
    elements.editorTitle.textContent = payload.path;
  }
  elements.fileSelect.value = payload.path;
  elements.fileEditor.value = preserveDraft ? elements.fileEditor.value : payload.content || "";
  elements.fileMeta.textContent = payload.updated_at
    ? `${t("ui.lastUpdate")} ${formatTime(payload.updated_at)}`
    : t("ui.fileNotCreated");
  // Update sidebar compact file name
  if (elements.currentFileName) {
    elements.currentFileName.textContent = payload.path;
  }
  setEditorStatus(t("status.loaded"), "connected");
  setFileError("");
}

async function saveActiveFile() {
  if (!state.activeFilePath) {
    return;
  }

  setEditorStatus(t("status.saving"), "idle");
  setFileError("");

  const response = await fetch(`${state.workspaceFilesPath}/${encodeURIComponent(state.activeFilePath)}`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({
      content: elements.fileEditor.value,
      expected_updated_at: state.activeFileUpdatedAt,
    }),
  });

  if (response.status === 409) {
    const payload = await response.json();
    setEditorStatus(t("status.conflict"), "error");
    setFileError(t("msg.versionConflict"));
    state.activeFileUpdatedAt = payload.updated_at || null;
    return;
  }

  if (!response.ok) {
    throw new Error(`save file failed: ${response.status}`);
  }

  const payload = await response.json();
  state.activeFileUpdatedAt = payload.updated_at;
  state.fileDraftDirty = false;
  elements.fileMeta.textContent = `${t("ui.lastUpdate")} ${formatTime(payload.updated_at)}`;
  setEditorStatus(t("status.saved"), "connected");
  await loadEditableFiles();
}

function websocketUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${state.wsPath}?token=${encodeURIComponent(state.token)}`;
}

function ensureMessageBucket(sessionKey) {
  if (!state.messages.has(sessionKey)) {
    state.messages.set(sessionKey, []);
  }
  return state.messages.get(sessionKey);
}

function pushMessage(sessionKey, message) {
  const bucket = ensureMessageBucket(sessionKey);
  bucket.push(message);
  if (sessionKey === state.activeSessionKey) {
    renderMessages();
  }
}

function upsertStreamMessage(chatId, messageId, deltaText, isReasoning = false) {
  const sessionKey = sessionKeyForChat(chatId);
  const bucket = ensureMessageBucket(sessionKey);
  let streamState = state.streamBuffers.get(messageId);

  if (!streamState) {
    const entry = {
      role: "assistant",
      content: "",
      reasoning_content: "",
      timestamp: new Date().toISOString(),
      message_id: messageId,
    };
    bucket.push(entry);
    streamState = { sessionKey, entry };
    state.streamBuffers.set(messageId, streamState);

    // Only render full list when adding a new message
    if (sessionKey === state.activeSessionKey) {
      renderMessages();
    }
  } else {
    // Append to appropriate content field
    if (isReasoning) {
      streamState.entry.reasoning_content += deltaText;
    } else {
      streamState.entry.content += deltaText;
    }

    // Only update the specific DOM element for incremental updates
    if (sessionKey === state.activeSessionKey) {
      updateStreamMessageDOM(messageId);
    }
  }
}

async function connectWebSocket() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl());
    state.socket = socket;

    socket.addEventListener("open", () => {
      setStatus(t("status.connected"), "connected");
      setError("");
    });

    socket.addEventListener("message", async (event) => {
      const payload = JSON.parse(event.data);

      if (payload.event === "ready") {
        resolve();
        return;
      }

      if (payload.event === "chat_created") {
        activateChat(payload.chat_id);
        await loadSessions();
        setStatus(t("status.connected"), "connected");

        // 如果有待发送的消息，自动发送
        if (state.pendingMessage) {
          const content = state.pendingMessage;
          state.pendingMessage = null;

          const sessionKey = state.activeSessionKey;
          pushMessage(sessionKey, {
            role: "user",
            content,
            timestamp: new Date().toISOString(),
          });

          sendSocketMessage({
            type: "message",
            chat_id: state.activeChatId,
            content,
          });
        }
        return;
      }

      if (payload.event === "attached") {
        activateChat(payload.chat_id);
        await loadMessages(sessionKeyForChat(payload.chat_id));
        return;
      }

      if (payload.event === "delta") {
        upsertStreamMessage(payload.chat_id, payload.message_id || crypto.randomUUID(), payload.text || "", payload.is_reasoning || false);
        return;
      }

      if (payload.event === "message") {
        // Check if this is a progress/tool hint message
        if (payload._progress) {
          // Progress messages are temporary hints, not persisted messages
          pushMessage(sessionKeyForChat(payload.chat_id), {
            role: "progress",
            content: payload.text || "",
            timestamp: new Date().toISOString(),
            _tool_hint: payload._tool_hint || false,
            _tool_detail: payload._tool_detail || false,
            _tool_result: payload._tool_result || false,
            _tool_name: payload._tool_name || "",
          });
        } else {
          // Regular assistant message
          pushMessage(sessionKeyForChat(payload.chat_id), {
            role: "assistant",
            content: payload.text || "",
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      if (payload.event === "stream_end") {
        if (payload.message_id) {
          state.streamBuffers.delete(payload.message_id);
        }
        return;
      }

      if (payload.event === "usage") {
        updateUsageDisplay(payload.usage);
        return;
      }

      if (payload.event === "file_updated") {
        await loadEditableFiles();
        if (payload.path === state.activeFilePath && !state.fileDraftDirty) {
          await loadFile(payload.path);
        } else if (payload.path === state.activeFilePath) {
          setFileError(t("msg.externalFileUpdate"));
          setEditorStatus(t("status.externalUpdate"), "error");
        }
        return;
      }

      if (payload.event === "error") {
        setError(payload.message || t("status.serverError"));
        if (payload.path) {
          setFileError(payload.message || t("status.serverError"));
        }
      }
    });

    socket.addEventListener("close", () => {
      setStatus(t("status.disconnected"), "error");
    });

    socket.addEventListener("error", () => {
      setStatus(t("status.failed"), "error");
      reject(new Error("websocket connection failed"));
    });
  });
}

function sendSocketMessage(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    throw new Error("websocket is not connected");
  }
  state.socket.send(JSON.stringify(payload));
}

async function createNewChat() {
  sendSocketMessage({ type: "new_chat" });
}

async function attachSession(chatId) {
  sendSocketMessage({ type: "attach", chat_id: chatId });
}

async function submitMessage() {
  const content = elements.composerInput.value.trim();
  if (!content) {
    return;
  }

  // 触发发送按钮动画
  const sendBtn = elements.composerForm.querySelector(".composer-send");
  if (sendBtn) {
    sendBtn.classList.add("sending");
    setTimeout(() => {
      sendBtn.classList.remove("sending");
    }, 600);
  }

  // 如果没有活跃会话，先创建新会话
  if (!state.activeChatId) {
    state.pendingMessage = content;  // 保存待发送的消息
    elements.composerInput.value = "";
    resizeComposer();
    setError("");
    setStatus(t("status.creatingSession"), "idle");
    createNewChat();
    return;
  }

  const sessionKey = state.activeSessionKey;
  pushMessage(sessionKey, {
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  });

  elements.composerInput.value = "";
  resizeComposer();
  setError("");

  sendSocketMessage({
    type: "message",
    chat_id: state.activeChatId,
    content,
  });
}

function bindEvents() {
  elements.composerInput.addEventListener("input", resizeComposer);
  elements.composerInput.addEventListener("keydown", async (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      await submitMessage();
    }
  });

  elements.composerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitMessage();
  });

  elements.newChatButton.addEventListener("click", async () => {
    await createNewChat();
  });

  elements.refreshButton.addEventListener("click", async () => {
    await loadSessions();
    await loadEditableFiles();
    await loadSystemStatus();
  });

  elements.clearMessagesButton.addEventListener("click", async () => {
    if (state.activeSessionKey) {
      try {
        await clearSession(state.activeSessionKey);
      } catch (error) {
        console.error(error);
        setError(error.message || t("status.failed"));
      }
    }
  });

  elements.sessionList.addEventListener("click", async (event) => {
    // Handle delete button
    const deleteBtn = event.target.closest(".session-delete");
    if (deleteBtn) {
      const sessionKey = deleteBtn.dataset.sessionKey;
      const chatId = deleteBtn.dataset.chatId;
      if (confirm(`${t("ui.confirmDelete")} ${chatId}？`)) {
        try {
          await deleteSession(sessionKey, chatId);
        } catch (error) {
          console.error(error);
          setError(error.message || t("status.failed"));
        }
      }
      return;
    }

    // Handle session selection
    const target = event.target.closest(".session-item");
    if (!target) {
      return;
    }
    await attachSession(target.dataset.chatId);
  });

  elements.fileSelect.addEventListener("change", async (event) => {
    const nextPath = event.target.value;
    if (!nextPath) {
      return;
    }
    await loadFile(nextPath);
  });

  elements.fileEditor.addEventListener("input", () => {
    state.fileDraftDirty = true;
    setEditorStatus(t("status.editing"), "idle");
  });

  elements.saveFileButton.addEventListener("click", async () => {
    try {
      await saveActiveFile();
    } catch (error) {
      console.error(error);
      setEditorStatus(t("status.saveFailed"), "error");
      setFileError(error.message || t("status.saveFailed"));
    }
  });

  elements.reloadFileButton.addEventListener("click", async () => {
    try {
      await loadFile(state.activeFilePath);
    } catch (error) {
      console.error(error);
      setEditorStatus(t("status.loadFailed"), "error");
      setFileError(error.message || t("status.loadFailed"));
    }
  });

  elements.refreshSkillsButton.addEventListener("click", async () => {
    try {
      await loadSkills();
    } catch (error) {
      console.error(error);
    }
  });

  elements.newSkillButton.addEventListener("click", async () => {
    await createNewSkill();
  });

  // Tools modal events
  elements.toolsToggle.addEventListener("click", openToolsModal);
  elements.toolsToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openToolsModal();
    }
  });
  elements.toolsModalOverlay.addEventListener("click", closeToolsModal);
  elements.toolsModalClose.addEventListener("click", closeToolsModal);

  // Skills modal events
  elements.skillsToggle.addEventListener("click", openSkillsModal);
  elements.skillsToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openSkillsModal();
    }
  });
  elements.skillsModalOverlay.addEventListener("click", closeSkillsModal);
  elements.skillsModalClose.addEventListener("click", closeSkillsModal);

  // Workspace modal events
  elements.workspaceToggle.addEventListener("click", openWorkspaceModal);
  elements.workspaceToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openWorkspaceModal();
    }
  });
  elements.workspaceModalOverlay.addEventListener("click", closeWorkspaceModal);
  elements.workspaceModalClose.addEventListener("click", closeWorkspaceModal);

  // 设置弹窗事件
  elements.settingsButton.addEventListener("click", openModal);
  elements.modalOverlay.addEventListener("click", closeModal);
  elements.modalClose.addEventListener("click", closeModal);

  // Skill detail modal events
  elements.skillModalOverlay.addEventListener("click", closeSkillModal);
  elements.skillModalClose.addEventListener("click", closeSkillModal);
  elements.skillValidateButton.addEventListener("click", async () => {
    await validateSkill();
  });
  elements.skillSaveButton.addEventListener("click", async () => {
    await saveSkill();
  });
  elements.skillDeleteButton.addEventListener("click", async () => {
    if (state.activeSkill?.name) {
      await deleteSkill(state.activeSkill.name);
    }
  });

  // Tool detail modal events
  elements.toolModalOverlay.addEventListener("click", closeToolModal);
  elements.toolModalClose.addEventListener("click", closeToolModal);
  elements.toolModalCloseButton.addEventListener("click", closeToolModal);

  // Knowledge modal events
  elements.knowledgeToggle.addEventListener("click", openKnowledgeModal);
  elements.knowledgeToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openKnowledgeModal();
    }
  });
  elements.knowledgeModalOverlay.addEventListener("click", closeKnowledgeModal);
  elements.knowledgeModalClose.addEventListener("click", closeKnowledgeModal);

  // Knowledge panel events
  elements.refreshDocsButton.addEventListener("click", async () => {
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  });
  elements.rebuildIndexButton.addEventListener("click", rebuildKnowledgeIndex);
  elements.addDocButton.addEventListener("click", openDocModal);
  elements.uploadDocButton.addEventListener("click", () => {
    elements.docFileUpload.click();
  });
  elements.docFileUpload.addEventListener("change", uploadDoc);
  elements.queryButton.addEventListener("click", queryKnowledge);
  elements.queryInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      queryKnowledge();
    }
  });

  // Doc modal events
  elements.docModalOverlay.addEventListener("click", closeDocModal);
  elements.docModalClose.addEventListener("click", closeDocModal);
  elements.docSaveButton.addEventListener("click", async () => {
    await addDoc();
  });

  // Doc view modal events
  elements.docViewModalOverlay.addEventListener("click", closeDocViewModal);
  elements.docViewModalClose.addEventListener("click", closeDocViewModal);
  elements.docViewCloseButton.addEventListener("click", closeDocViewModal);
  elements.docViewDeleteButton.addEventListener("click", async () => {
    if (state.activeDoc?.id) {
      await deleteDoc(state.activeDoc.id, state.activeDoc.name);
    }
  });

  // ESC键关闭弹窗 + 全局快捷键
  document.addEventListener("keydown", (event) => {
    // ESC关闭弹窗
    if (event.key === "Escape") {
      if (elements.modal.classList.contains("active")) {
        closeModal();
      }
      if (elements.skillModal.classList.contains("active")) {
        closeSkillModal();
      }
      if (elements.docModal.classList.contains("active")) {
        closeDocModal();
      }
      if (elements.docViewModal.classList.contains("active")) {
        closeDocViewModal();
      }
      return;
    }

    // 全局快捷键（需要在输入框外生效）
    if (event.ctrlKey || event.metaKey) {
      // Ctrl+N: 新建会话
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        createNewChat();
        return;
      }

      // Ctrl+L: 清空当前会话
      if (event.key === "l" || event.key === "L") {
        event.preventDefault();
        if (state.activeSessionKey) {
          clearSession(state.activeSessionKey).catch(console.error);
        }
        return;
      }

      // Ctrl+S: 保存文件编辑
      if (event.key === "s" || event.key === "S") {
        event.preventDefault();
        if (state.activeFilePath && state.fileDraftDirty) {
          saveActiveFile().catch(console.error);
        }
        return;
      }

      // Ctrl+/: 显示快捷键帮助
      if (event.key === "/" || event.key === "?") {
        event.preventDefault();
        showShortcutHelp();
        return;
      }
    }
  });

  // 配置组折叠
  document.querySelectorAll(".config-group-title.clickable").forEach((title) => {
    title.addEventListener("click", () => {
      toggleConfigGroup(title);
    });
    title.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleConfigGroup(title);
      }
    });
  });

  // Provider select change - 更新Provider配置区域
  elements.configProviderSelect.addEventListener("change", () => {
    const providers = state.config?.providers || {};
    loadProviderConfig(providers, elements.configProviderSelect.value);
  });

  // Agent Provider select change - 同步更新Provider配置区域的选择
  elements.configProvider.addEventListener("change", () => {
    const selectedProvider = elements.configProvider.value;
    // 如果是auto，Provider配置区域显示custom
    const displayProvider = selectedProvider === "auto" ? "custom" : selectedProvider;
    elements.configProviderSelect.value = displayProvider;
    const providers = state.config?.providers || {};
    loadProviderConfig(providers, displayProvider);
  });

  elements.saveConfigButton.addEventListener("click", async () => {
    await saveConfig();
  });

  // 语言切换按钮
  updateLanguageButton();
  elements.languageToggle.addEventListener("click", () => {
    const newLang = getLanguage() === "zh" ? "en" : "zh";
    setLanguage(newLang);
    updateLanguageButton();
    renderDynamicContent();
  });

  // 主题切换按钮
  elements.themeToggle.addEventListener("click", toggleTheme);

  // 监听语言变化事件（来自 i18n.js）
  window.addEventListener("languagechange", () => {
    updateLanguageButton();
    renderDynamicContent();
    // 重新渲染usage显示
    if (state.lastUsage) {
      updateUsageDisplay(state.lastUsage);
    }
  });
}

function updateLanguageButton() {
  const lang = getLanguage();
  elements.languageToggle.textContent = lang === "zh" ? "EN" : "中文";
}

function renderDynamicContent() {
  // 重新渲染所有动态内容
  renderSessions();
  renderMessages();
  renderTools();
  renderSkills();
  renderKnowledgeDocs();
  // 更新文件编辑器状态
  if (state.activeFilePath && state.activeFileUpdatedAt) {
    elements.fileMeta.textContent = `${t("ui.lastUpdate")} ${formatTime(state.activeFileUpdatedAt)}`;
  } else if (state.activeFilePath) {
    elements.fileMeta.textContent = t("ui.fileNotCreated");
  }
  // 更新聊天标题
  if (state.activeChatId) {
    elements.chatTitle.textContent = state.activeChatId;
  } else {
    elements.chatTitle.textContent = t("ui.notConnected");
  }
}

// 快捷键帮助
function showShortcutHelp() {
  const shortcuts = [
    { key: "Ctrl+N", desc: t("shortcuts.newChat") },
    { key: "Ctrl+L", desc: t("shortcuts.clearSession") },
    { key: "Ctrl+S", desc: t("shortcuts.saveEdit") },
    { key: "Ctrl+/", desc: t("shortcuts.showHelp") },
    { key: "Enter", desc: t("shortcuts.sendMessage") },
    { key: "Shift+Enter", desc: t("shortcuts.newLine") },
    { key: "Esc", desc: t("shortcuts.closeModal") },
  ];

  // 创建快捷键帮助弹窗
  const modal = document.createElement("div");
  modal.className = "modal active";
  modal.innerHTML = `
    <div class="modal-overlay"></div>
    <div class="modal-content" style="width: min(90vw, 400px);">
      <header class="modal-header">
        <h2>${t("shortcuts.title")}</h2>
        <button class="button button-ghost" type="button">✕</button>
      </header>
      <div class="modal-body">
        <div class="shortcut-list">
          ${shortcuts.map(s => `
            <div class="shortcut-item">
              <span class="shortcut-key">${s.key}</span>
              <span class="shortcut-desc">${s.desc}</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;

  // 点击关闭
  const closeBtn = modal.querySelector(".button-ghost");
  const overlay = modal.querySelector(".modal-overlay");
  closeBtn.addEventListener("click", () => modal.remove());
  overlay.addEventListener("click", () => modal.remove());

  document.body.appendChild(modal);
}

async function init() {
  // 显示初始化骨架屏
  showInitSkeleton();

  initTheme();
  bindEvents();
  resizeComposer();

  try {
    await bootstrap();
    await connectWebSocket();
    await loadSessions();
    await loadEditableFiles();
    await loadSystemStatus();
    await loadTools();
    await loadSkills();
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
    await loadConfig();
    if (state.activeFilePath) {
      sendSocketMessage({ type: "subscribe_file", path: state.activeFilePath });
    }
    // 移除骨架屏
    removeInitSkeleton();
    setStatus(t("status.connected"), "connected");
  } catch (error) {
    console.error(error);
    removeInitSkeleton();
    setStatus(t("status.initFailed"), "error");
    setError(error.message || t("status.initFailed"));
  }
}

function showInitSkeleton() {
  const skeletonHTML = `
    <div class="skeleton-overlay" id="init-skeleton">
      <div class="skeleton-container">
        <div class="skeleton-message">
          <div class="skeleton-meta">
            <div class="skeleton skeleton-role"></div>
            <div class="skeleton skeleton-time"></div>
          </div>
          <div class="skeleton skeleton-content"></div>
          <div class="skeleton skeleton-content-short"></div>
        </div>
        <div class="skeleton-message" style="align-self: flex-end; width: 70%;">
          <div class="skeleton-meta">
            <div class="skeleton skeleton-role"></div>
            <div class="skeleton skeleton-time"></div>
          </div>
          <div class="skeleton skeleton-content" style="width: 80%;"></div>
        </div>
        <div class="init-loading-text">${getLanguage() === "zh" ? "正在初始化..." : "Initializing..."}</div>
      </div>
    </div>
  `;
  elements.messageList.innerHTML = skeletonHTML;
}

function removeInitSkeleton() {
  const skeleton = document.getElementById("init-skeleton");
  if (skeleton) {
    skeleton.remove();
  }
}

init();
