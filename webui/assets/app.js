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
  configVectorStore: document.querySelector("#config-vector-store"),
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
  addDocButton: document.querySelector("#add-doc-button"),
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
};

function setStatus(text, kind = "idle") {
  elements.connectionStatus.textContent = text;
  elements.connectionStatus.className = `status status-${kind}`;
}

function setError(text = "") {
  elements.errorText.textContent = text;
}

function setEditorStatus(text, kind = "idle") {
  elements.editorStatus.textContent = text;
  elements.editorStatus.className = `status status-${kind}`;
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
}

function renderTools() {
  elements.toolsList.textContent = "";

  if (state.tools.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noTools");
    elements.toolsList.append(empty);
    return;
  }

  for (const tool of state.tools) {
    const item = document.createElement("div");
    item.className = "tool-item";

    const name = document.createElement("span");
    name.className = "tool-name";
    name.textContent = tool.name;

    const desc = document.createElement("span");
    desc.className = "tool-desc";
    desc.textContent = tool.description || t("msg.noDescription");

    item.append(name, desc);
    elements.toolsList.append(item);
  }
}

function renderSkills() {
  elements.skillsList.textContent = "";

  if (state.skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("msg.noSkills");
    elements.skillsList.append(empty);
    return;
  }

  // Get enabled skills list from config
  const enabledSkills = state.config?.skills?.enabled || null;
  const isAllEnabled = !enabledSkills || enabledSkills.includes("*");

  for (const skill of state.skills) {
    const item = document.createElement("div");
    item.className = "skill-item";

    // Header row: name + toggle switch
    const headerRow = document.createElement("div");
    headerRow.className = "skill-header-row";

    // Name section (left side)
    const nameSection = document.createElement("div");
    nameSection.className = "skill-name-section";

    const name = document.createElement("span");
    name.className = "skill-name skill-name-clickable";
    name.textContent = skill.name;
    name.title = t("ui.clickToView");
    name.addEventListener("click", () => viewSkill(skill.name));

    nameSection.append(name);

    // Toggle switch section (right side)
    const toggleSection = document.createElement("div");
    toggleSection.className = "skill-toggle-section";

    // Create toggle switch
    const toggleSwitch = document.createElement("div");
    toggleSwitch.className = "toggle-switch";

    if (!skill.available) {
      // Unavailable - gray/disabled style
      toggleSwitch.classList.add("toggle-unavailable");
      toggleSwitch.innerHTML = `<span class="toggle-label">${t("status.unavailable")}</span>`;
    } else if (skill.always) {
      // Always - special "always" style (cannot be toggled)
      toggleSwitch.classList.add("toggle-always", "toggle-on");
      toggleSwitch.innerHTML = `<span class="toggle-label">${t("status.always")}</span>`;
    } else {
      // Normal skill - can be toggled
      const isEnabled = isAllEnabled || enabledSkills.includes(skill.name);
      toggleSwitch.classList.add(isEnabled ? "toggle-on" : "toggle-off");
      toggleSwitch.classList.add("toggle-clickable");
      toggleSwitch.innerHTML = `<span class="toggle-slider"></span>`;
      toggleSwitch.title = isEnabled ? t("ui.clickToDisable") : t("ui.clickToEnable");
      toggleSwitch.addEventListener("click", () => toggleSkill(skill.name, !isEnabled));
    }

    // Delete button (only for workspace skills, positioned in toggle section)
    if (skill.source === "workspace") {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "skill-delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = t("ui.delete");
      deleteBtn.addEventListener("click", () => deleteSkill(skill.name));
      toggleSection.append(deleteBtn);
    }

    toggleSection.append(toggleSwitch);

    headerRow.append(nameSection, toggleSection);

    // Description row
    const desc = document.createElement("span");
    desc.className = "skill-desc";
    desc.textContent = skill.description || t("msg.noDescription");

    item.append(headerRow, desc);
    elements.skillsList.append(item);
  }
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
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!response.ok) {
      if (response.status === 503) {
        // Knowledge store not initialized
        elements.knowledgeStatus.textContent = t("status.unavailable");
        elements.knowledgeStatus.className = "status status-idle status-small";
        elements.statsDocs.textContent = "-";
        elements.statsChunks.textContent = "-";
        return;
      }
      throw new Error(`load knowledge stats failed: ${response.status}`);
    }

    const payload = await response.json();
    state.knowledgeStats = payload;
    elements.statsDocs.textContent = payload.total_documents || 0;
    elements.statsChunks.textContent = payload.total_chunks || 0;
    elements.knowledgeStatus.textContent = t("status.available");
    elements.knowledgeStatus.className = "status status-connected status-small";
  } catch (error) {
    console.error(error);
    elements.knowledgeStatus.textContent = t("status.failed");
    elements.knowledgeStatus.className = "status status-error status-small";
  }
}

async function loadKnowledgeDocs() {
  try {
    const response = await fetch(`${state.knowledgeApiPath}/documents`, {
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
    score.textContent = `${(item.score || 0).toFixed(3)}`;

    header.append(docName, score);

    const content = document.createElement("div");
    content.className = "query-result-content";
    content.textContent = item.content || "";

    resultItem.append(header, content);
    elements.queryResults.append(resultItem);
  }
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
  elements.configVectorStore.checked = defaults.enableVectorStore || defaults.enable_vector_store === true;

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

  // Build payload - only include changed/non-null values
  const payload = {
    agents: {
      model: getValue(elements.configModel),
      provider: getValue(elements.configProvider),
      workspace: getValue(elements.configWorkspace),
      temperature: getValue(elements.configTemperature, "number"),
      max_tokens: getValue(elements.configMaxTokens, "number"),
      context_window_tokens: getValue(elements.configContextWindow, "number"),
      max_tool_iterations: getValue(elements.configMaxToolIterations, "number"),
      reasoning_effort: getValue(elements.configReasoningEffort),
      timezone: getValue(elements.configTimezone),
      enable_vector_store: elements.configVectorStore.checked,
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
  elements.editorTitle.textContent = payload.path;
  elements.fileSelect.value = payload.path;
  elements.fileEditor.value = preserveDraft ? elements.fileEditor.value : payload.content || "";
  elements.fileMeta.textContent = payload.updated_at
    ? `${t("ui.lastUpdate")} ${formatTime(payload.updated_at)}`
    : t("ui.fileNotCreated");
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

  elements.refreshToolsButton.addEventListener("click", async () => {
    try {
      await loadTools();
    } catch (error) {
      console.error(error);
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

  elements.editorToggle.addEventListener("click", toggleEditorPanel);
  elements.editorToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleEditorPanel();
    }
  });

  // 设置弹窗事件
  elements.settingsButton.addEventListener("click", openModal);
  elements.modalOverlay.addEventListener("click", closeModal);
  elements.modalClose.addEventListener("click", closeModal);

  // Skill modal events
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

  // Knowledge panel events
  elements.knowledgeToggle.addEventListener("click", toggleKnowledgePanel);
  elements.knowledgeToggle.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleKnowledgePanel();
    }
  });
  elements.refreshDocsButton.addEventListener("click", async () => {
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
  });
  elements.addDocButton.addEventListener("click", openDocModal);
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

  // ESC键关闭弹窗
  document.addEventListener("keydown", (event) => {
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

async function init() {
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
    setStatus(t("status.connected"), "connected");
  } catch (error) {
    console.error(error);
    setStatus(t("status.initFailed"), "error");
    setError(error.message || t("status.initFailed"));
  }
}

init();
