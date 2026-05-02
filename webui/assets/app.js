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
  sessionFiles: new Map(),
  streamBuffers: new Map(),
  editableFiles: [],
  activeFilePath: "",
  activeFileUpdatedAt: null,
  fileDraftDirty: false,
  tools: [],
  skills: [],
  knowledgeDocs: [],
  knowledgeStats: null,
  knowledgeGraph: null,
  knowledgeGraphView: { scale: 1, x: 0, y: 0 },
  knowledgeGraphRuntime: null,
  knowledgeGraphLevel: 0,
  knowledgeGraphFilterDocId: "",
  knowledgeGraphFilterDocName: "",
  knowledgeGraphHighlight: null,
  knowledgeGraphSelection: null,
  configBaseline: null,
  activeKnowledgeTab: "overview",
  knowledgeWorkbenchReady: false,
  knowledgeIndexing: false,
  knowledgeRebuilding: false,
  activeKnowledgeJobId: "",
  knowledgeJobPollTimer: null,
  config: null,
  helpOverlay: null,
  activeTourIndex: 0,
  pendingMessage: null,  // 待发送的消息（创建新会话后发送）
  activeSkill: null,  // 当前编辑的 skill
  skillMode: "view",  // view, edit, create
  activeDoc: null,  // 当前查看的文档
  theme: "light",  // 当前主题
  contextWindowTokens: 65536,  // 默认上下文窗口大小
  lastUsage: null,  // 最后一次的usage数据
  browserFrame: null,
  browserPanelCollapsed: false,
};

const LLM_PROVIDERS = ["openai", "deepseek", "dashscope"];
const REASONING_COLLAPSE_CHARS = 600;
const REASONING_COLLAPSE_LINES = 5;
const AUTO_COLLAPSE_MIN_MESSAGES = 1;
const TOOL_CONTENT_COLLAPSE_CHARS = 900;
const TOOL_CONTENT_COLLAPSE_LINES = 14;

const elements = {
  sessionList: document.querySelector("#session-list"),
  sessionCount: document.querySelector("#session-count"),
  chatTitle: document.querySelector("#chat-title"),
  connectionStatus: document.querySelector("#connection-status"),
  messageList: document.querySelector("#message-list"),
  composerForm: document.querySelector("#composer-form"),
  composerInput: document.querySelector("#composer-input"),
  temporaryFileButton: document.querySelector("#temporary-file-button"),
  temporaryFileUpload: document.querySelector("#temporary-file-upload"),
  sessionFilesStrip: document.querySelector("#session-files-strip"),
  persistentRagToggle: document.querySelector("#persistent-rag-toggle"),
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
  helpTourButton: document.querySelector("#help-tour-button"),
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
  configKnowledgeGenerateSummary: document.querySelector("#config-knowledge-generate-summary"),
  configKnowledgeSemanticExtractionMode: document.querySelector("#config-knowledge-semantic-extraction-mode"),
  configKnowledgeSemanticLlmMaxTokens: document.querySelector("#config-knowledge-semantic-llm-max-tokens"),
  configKnowledgeSemanticLlmTimeout: document.querySelector("#config-knowledge-semantic-llm-timeout"),
  configKnowledgeGraphRagCommunityAlgorithm: document.querySelector("#config-knowledge-graphrag-community-algorithm"),
  configKnowledgeGraphRagCommunityLevel: document.querySelector("#config-knowledge-graphrag-community-level"),
  configKnowledgeGraphRagReportLlmEnabled: document.querySelector("#config-knowledge-graphrag-report-llm-enabled"),
  configKnowledgeGraphRagReportMaxTokens: document.querySelector("#config-knowledge-graphrag-report-max-tokens"),
  configKnowledgeGraphRagEntitySummaryEnabled: document.querySelector("#config-knowledge-graphrag-entity-summary-enabled"),
  // Embedding config elements
  configEmbeddingProvider: document.querySelector("#config-embedding-provider"),
  configEmbeddingModelName: document.querySelector("#config-embedding-model-name"),
  configEmbeddingApiKey: document.querySelector("#config-embedding-api-key"),
  configEmbeddingApiBase: document.querySelector("#config-embedding-api-base"),
  // Provider config elements
  configProviderSelect: document.querySelector("#config-provider-select"),
  configSearch: document.querySelector("#config-search"),
  configQuickNav: document.querySelector("#config-quick-nav"),
  configExpandAll: document.querySelector("#config-expand-all"),
  configCollapseAll: document.querySelector("#config-collapse-all"),
  configEmptySearch: document.querySelector("#config-empty-search"),
  configDirtySummary: document.querySelector("#config-dirty-summary"),
  resetConfigButton: document.querySelector("#reset-config-button"),
  configApiKey: document.querySelector("#config-api-key"),
  configApiBase: document.querySelector("#config-api-base"),
  configWebEnable: document.querySelector("#config-web-enable"),
  configWebProxy: document.querySelector("#config-web-proxy"),
  configSearchProvider: document.querySelector("#config-search-provider"),
  configExecEnable: document.querySelector("#config-exec-enable"),
  configExecTimeout: document.querySelector("#config-exec-timeout"),
  configMcpServers: document.querySelector("#config-mcp-servers"),
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
  refreshGraphButton: document.querySelector("#refresh-graph-button"),
  knowledgeGraph: document.querySelector("#knowledge-graph"),
  knowledgeGraphMeta: document.querySelector("#knowledge-graph-meta"),
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
  modalStatsEntities: document.querySelector("#modal-stats-entities"),
  modalStatsClaims: document.querySelector("#modal-stats-claims"),
  modalStatsRelations: document.querySelector("#modal-stats-relations"),
  modalStatsCommunities: document.querySelector("#modal-stats-communities"),
  modalStatsReports: document.querySelector("#modal-stats-reports"),
  knowledgeIndexingStatus: document.querySelector("#knowledge-indexing-status"),
  knowledgeGraphInspector: null,
  knowledgeGraphScope: null,
  knowledgeGraphLevelSelect: null,
  clearGraphFilterButton: null,
  globalKnowledgeToast: null,
  globalKnowledgeToastTitle: null,
  globalKnowledgeToastDesc: null,
  globalKnowledgeProgressBar: null,
  knowledgeHealthTitle: null,
  knowledgeHealthScore: null,
  knowledgeHealthBar: null,
  knowledgeHealthDesc: null,
  knowledgeOverviewInsights: null,
  queryModeHint: null,
  // Workspace modal elements
  workspaceModal: document.querySelector("#workspace-modal"),
  workspaceModalOverlay: document.querySelector("#workspace-modal-overlay"),
  workspaceModalClose: document.querySelector("#workspace-modal-close"),
  workspaceModalTitle: document.querySelector("#workspace-modal-title"),
  workspaceToggle: document.querySelector("#workspace-toggle"),
  currentFileName: document.querySelector("#current-file-name"),
  toolsCount: document.querySelector("#tools-count"),
  browserPanel: document.querySelector("#browser-panel"),
  browserPanelToggle: document.querySelector("#browser-panel-toggle"),
  browserFrameImage: document.querySelector("#browser-frame-image"),
  browserFrameEmpty: document.querySelector("#browser-frame-empty"),
  browserFrameStatus: document.querySelector("#browser-frame-status"),
  browserFrameTime: document.querySelector("#browser-frame-time"),
  browserFrameCommand: document.querySelector("#browser-frame-command"),
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderMarkdown(target, content) {
  target.textContent = "";
  if (!content || !content.trim()) {
    return;
  }

  if (typeof marked === "undefined") {
    target.textContent = content;
    return;
  }

  try {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
    target.innerHTML = marked.parse(content);

    if (typeof hljs !== "undefined") {
      target.querySelectorAll("pre code").forEach((block) => {
        hljs.highlightElement(block);
      });
    }
  } catch {
    target.textContent = content;
  }
}

function setFileError(text = "") {
  elements.fileError.textContent = text;
}

function renderSidebarActionIcons() {
  const buttons = [
    {
      element: elements.newChatButton,
      title: t("ui.newChat"),
      className: "sidebar-icon-new-chat",
      svg: `
        <svg class="icon-chat-plus" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h7"></path>
          <path d="M19 3v8"></path>
          <path d="M15 7h8"></path>
        </svg>
      `,
    },
    {
      element: elements.refreshButton,
      title: t("ui.refresh"),
      className: "sidebar-icon-refresh",
      svg: `
        <svg class="icon-refresh" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12a9 9 0 0 1-15.2 6.5"></path>
          <path d="M3 12A9 9 0 0 1 18.2 5.5"></path>
          <path d="M18 2v4h4"></path>
          <path d="M6 22v-4H2"></path>
        </svg>
      `,
    },
  ];
  for (const button of buttons) {
    if (!button.element) continue;
    button.element.classList.add("button-icon", "sidebar-action-icon", button.className);
    button.element.removeAttribute("data-i18n");
    button.element.setAttribute("title", button.title);
    button.element.setAttribute("aria-label", button.title);
    button.element.innerHTML = button.svg;
  }
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
        <span class="usage-total">${totalText} (${percent}%)</span>
        <span class="usage-detail">${labelText}</span>
        ${cachedText ? `<span class="usage-cached">${cachedText}</span>` : ""}
      </div>
    </div>
  `;
}

function setBrowserPanelCollapsed(collapsed) {
  state.browserPanelCollapsed = collapsed;
  if (!elements.browserPanel) {
    return;
  }
  elements.browserPanel.classList.toggle("collapsed", collapsed);
  if (elements.browserPanelToggle) {
    elements.browserPanelToggle.setAttribute("aria-label", collapsed ? "Expand browser view" : "Collapse browser view");
    elements.browserPanelToggle.title = collapsed ? "Expand browser view" : "Collapse browser view";
  }
}

function updateBrowserFrame(payload) {
  if (!elements.browserPanel) {
    return;
  }

  const receivedAt = payload.captured_at || new Date().toISOString();
  state.browserFrame = {
    imageUrl: payload.image_url || "",
    sourceCommand: payload.source_command || "",
    capturedAt: receivedAt,
  };

  const hasImage = Boolean(state.browserFrame.imageUrl);

  if (elements.browserFrameImage) {
    if (hasImage) {
      elements.browserFrameImage.src = state.browserFrame.imageUrl;
    }
    elements.browserFrameImage.hidden = !hasImage;
  }
  if (elements.browserFrameEmpty) {
    elements.browserFrameEmpty.hidden = hasImage;
  }
  if (elements.browserFrameStatus) {
    elements.browserFrameStatus.textContent = hasImage ? "Live frame" : "Waiting for browser activity";
  }
  if (elements.browserFrameTime) {
    elements.browserFrameTime.textContent = formatTime(receivedAt);
  }
  if (elements.browserFrameCommand) {
    elements.browserFrameCommand.textContent = state.browserFrame.sourceCommand || "";
    elements.browserFrameCommand.title = state.browserFrame.sourceCommand || "";
  }
  elements.browserPanel.classList.toggle("has-frame", hasImage);
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

function messageContentText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") return item.text || item.content || "";
        return "";
      })
      .filter(Boolean)
      .join(" ");
  }
  return content == null ? "" : String(content);
}

function compactSessionTitleFromMessages(messages) {
  for (const message of messages || []) {
    if (message.role !== "user") {
      continue;
    }
    const text = messageContentText(message.content)
      .replace(/[`#*_>~-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      continue;
    }
    return text.length > 36 ? `${text.slice(0, 36).trim()}...` : text;
  }
  return "";
}

function sessionTitleForKey(sessionKey) {
  const item = state.sessionItems.find((entry) => entry.key === sessionKey);
  const messages = state.messages.get(sessionKey) || [];
  return compactSessionTitleFromMessages(messages) || item?.title || t("ui.newSessionTitle");
}

function updateActiveChatTitle() {
  elements.chatTitle.textContent = state.activeSessionKey
    ? sessionTitleForKey(state.activeSessionKey)
    : t("ui.notConnected");
  elements.chatTitle.title = state.activeChatId || "";
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

function shouldCollapseReasoning(text) {
  const normalized = text || "";
  return normalized.length > REASONING_COLLAPSE_CHARS || normalized.split(/\r?\n/).length > REASONING_COLLAPSE_LINES;
}

function shouldCollapseToolContent(text) {
  const normalized = text || "";
  return normalized.length > TOOL_CONTENT_COLLAPSE_CHARS || normalized.split(/\r?\n/).length > TOOL_CONTENT_COLLAPSE_LINES;
}

function formatToolArguments(args) {
  if (args == null || args === "") {
    return "";
  }
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return trimmed;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function summarizeToolArguments(argsText) {
  if (!argsText) {
    return t("message.toolNoArgs");
  }
  const compact = argsText.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 120)}...` : compact;
}

function parseToolArguments(args) {
  if (!args) {
    return {};
  }
  if (typeof args === "object") {
    return args;
  }
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function clampPercent(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(100, Math.max(0, value));
}

function taskStatusLabel(status) {
  const labels = {
    planning: "Planning",
    executing: "Executing",
    completed: "Completed",
    failed: "Failed",
    paused: "Paused",
    pending: "Pending",
    in_progress: "Running",
    skipped: "Skipped",
  };
  return labels[status] || status || "Task";
}

function taskStatusClass(status) {
  return String(status || "unknown").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
}

function taskProgressPayload(message) {
  return message?._task_progress && typeof message._task_progress === "object"
    ? message._task_progress
    : null;
}

function createReasoningNode(reasoningText, previousState = {}) {
  const collapse = shouldCollapseReasoning(reasoningText);
  const details = document.createElement("details");
  details.className = "message-reasoning message-reasoning-details";
  const keepManualState = previousState.manual === true;
  details.open = collapse ? (keepManualState && previousState.open === true) : true;
  if (keepManualState) {
    details.dataset.reasoningManual = "true";
  }

  const summary = document.createElement("summary");
  summary.className = "message-reasoning-summary";
  summary.addEventListener("click", () => {
    details.dataset.reasoningManual = "true";
  });

  const title = document.createElement("span");
  title.className = "message-reasoning-title";
  title.textContent = t("message.thinking");

  const meta = document.createElement("span");
  meta.className = "message-reasoning-meta";
  const updateMeta = () => {
    meta.textContent = details.open ? t("message.thinkingVisible") : t("message.thinkingCollapsed");
  };
  updateMeta();
  details.addEventListener("toggle", updateMeta);

  summary.append(title, meta);

  const body = document.createElement("div");
  body.className = "message-reasoning-body";
  body.textContent = reasoningText;

  details.append(summary, body);
  return details;
}

function getToolName(message) {
  return message?._tool_name || message?.name || "";
}

function getToolCallName(toolCall) {
  return toolCall?.function?.name || toolCall?.name || "";
}

function getToolCallId(toolCall) {
  return toolCall?.id || toolCall?.tool_call_id || "";
}

function getToolMessageCallId(message) {
  return message?.tool_call_id || message?._tool_call_id || "";
}

function hasToolCalls(message) {
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0;
}

function isProgressToolDetail(message) {
  return message?.role === "progress" && message?._tool_detail;
}

function isProgressToolResult(message) {
  return message?.role === "progress" && message?._tool_result;
}

function isToolProcessMessage(message) {
  return message?.role === "tool" || message?.role === "progress" || hasToolCalls(message);
}

function isFinalAssistantContent(message) {
  return (
    message?.role === "assistant" &&
    !hasToolCalls(message) &&
    !message._stream_resuming &&
    !state.streamBuffers.has(message.message_id || "") &&
    Boolean((message.content || "").trim())
  );
}

function shouldAutoCollapseTurn(messages, startIndex, finalIndex) {
  const collapsibleCount = finalIndex - startIndex;
  if (collapsibleCount < AUTO_COLLAPSE_MIN_MESSAGES) {
    return false;
  }

  for (let index = startIndex; index < finalIndex; index += 1) {
    if (isToolProcessMessage(messages[index])) {
      return true;
    }
  }
  return false;
}

function findFinalAssistantIndex(messages, startIndex) {
  let finalIndex = -1;
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "user") {
      break;
    }
    if (isFinalAssistantContent(message)) {
      finalIndex = index;
    }
  }
  return finalIndex;
}

function prepareMessageRelationships(messages) {
  for (const message of messages) {
    if (message && "_relatedToolMessages" in message) {
      delete message._relatedToolMessages;
    }
    if (message && "_pairedToolResponse" in message) {
      delete message._pairedToolResponse;
    }
    if (message && "_pairedToolResponseConsumed" in message) {
      delete message._pairedToolResponseConsumed;
    }
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!hasToolCalls(message)) {
      continue;
    }

    message._relatedToolMessages = [];
    const toolNames = new Set(message.tool_calls.map((tc) => tc.function?.name || tc.name || "").filter(Boolean));
    let nextIndex = index + 1;
    while (nextIndex < messages.length) {
      const nextMessage = messages[nextIndex];
      if (nextMessage.role !== "tool" && nextMessage.role !== "progress") {
        break;
      }
      const nextToolName = getToolName(nextMessage);
      if (toolNames.size > 0 && nextToolName && !toolNames.has(nextToolName)) {
        break;
      }
      message._relatedToolMessages.push(nextMessage);
      nextIndex += 1;
    }
  }

  const pendingDetailsByName = new Map();
  for (const message of messages) {
    if (message?.role !== "progress") {
      pendingDetailsByName.clear();
      continue;
    }

    if (isProgressToolDetail(message)) {
      const name = getToolName(message) || "";
      const queue = pendingDetailsByName.get(name) || [];
      queue.push(message);
      pendingDetailsByName.set(name, queue);
      continue;
    }

    if (!isProgressToolResult(message)) {
      continue;
    }

    const name = getToolName(message) || "";
    const queue = pendingDetailsByName.get(name) || [];
    const detailMessage = queue.shift();
    if (!detailMessage) {
      continue;
    }

    detailMessage._pairedToolResponse = message;
    message._pairedToolResponseConsumed = true;
    if (queue.length === 0) {
      pendingDetailsByName.delete(name);
    }
  }
}

function relatedToolMessagesEndIndex(messages, startIndex) {
  const message = messages[startIndex];
  if (!hasToolCalls(message)) {
    return startIndex;
  }

  const toolNames = new Set(message.tool_calls.map((tc) => tc.function?.name || tc.name || "").filter(Boolean));
  let nextIndex = startIndex + 1;
  while (nextIndex < messages.length) {
    const nextMessage = messages[nextIndex];
    if (nextMessage.role !== "tool" && nextMessage.role !== "progress") {
      break;
    }
    const nextToolName = getToolName(nextMessage);
    if (toolNames.size > 0 && nextToolName && !toolNames.has(nextToolName)) {
      break;
    }
    nextIndex += 1;
  }
  return nextIndex - 1;
}

function relatedToolMessageGroups(toolCalls, relatedMessages) {
  const groups = toolCalls.map(() => []);
  const usedMessageIndexes = new Set();
  const callIdToIndex = new Map();

  toolCalls.forEach((toolCall, index) => {
    const id = getToolCallId(toolCall);
    if (id) {
      callIdToIndex.set(id, index);
    }
  });

  relatedMessages.forEach((message, index) => {
    const messageCallId = getToolMessageCallId(message);
    const callIndex = messageCallId ? callIdToIndex.get(messageCallId) : undefined;
    if (callIndex !== undefined) {
      groups[callIndex].push(message);
      usedMessageIndexes.add(index);
    }
  });

  let fallbackCursor = 0;
  relatedMessages.forEach((message, messageIndex) => {
    if (usedMessageIndexes.has(messageIndex)) {
      return;
    }

    const messageName = getToolName(message);
    for (let offset = 0; offset < toolCalls.length; offset += 1) {
      const callIndex = (fallbackCursor + offset) % toolCalls.length;
      const callName = getToolCallName(toolCalls[callIndex]);
      if (!messageName || !callName || messageName === callName) {
        groups[callIndex].push(message);
        usedMessageIndexes.add(messageIndex);
        fallbackCursor = (callIndex + 1) % toolCalls.length;
        return;
      }
    }
  });

  return groups;
}

function createMessageDisplayItems(messages) {
  const items = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (isSessionFileProgressMessage(message)) {
      continue;
    }
    if (message?._pairedToolResponseConsumed) {
      continue;
    }
    const finalIndex = message?.role === "user" ? -1 : findFinalAssistantIndex(messages, index);

    if (finalIndex > index && shouldAutoCollapseTurn(messages, index, finalIndex)) {
      const turnMessages = messages.slice(index, finalIndex);
      const taskMessages = turnMessages.filter((item) => item._task_event);
      const collapsedMessages = turnMessages.filter((item) => !item._task_event);
      if (collapsedMessages.length) {
        items.push({
          type: "collapse",
          messages: collapsedMessages,
        });
      }
      for (const taskMessage of taskMessages) {
        items.push({
          type: "message",
          message: taskMessage,
        });
      }
      items.push({
        type: "message",
        message: messages[finalIndex],
      });
      index = finalIndex;
      continue;
    }

    items.push({
      type: "message",
      message,
    });

    if (hasToolCalls(message)) {
      index = relatedToolMessagesEndIndex(messages, index);
    }
  }

  return items;
}

function isSessionFileProgressMessage(message) {
  if (!message || message.role !== "progress") {
    return false;
  }
  const content = String(message.content || "");
  return content.startsWith(t("sessionFiles.uploaded")) || content.startsWith("临时文件已加入当前会话");
}

function createCollapsedMessagesNode(collapsedMessages) {
  const wrapper = document.createElement("article");
  wrapper.className = "message-collapse-group";

  const button = document.createElement("button");
  button.className = "message-collapse-summary";
  button.type = "button";
  button.setAttribute("aria-expanded", "false");

  const icon = document.createElement("span");
  icon.className = "message-collapse-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ">";

  const displayCount = collapsedMessages.filter((message) => !message?._pairedToolResponseConsumed).length;
  const labelText = t("message.collapsedCount").replace("{count}", String(displayCount));
  const label = document.createElement("span");
  label.className = "message-collapse-label";
  label.textContent = `${labelText} · ${t("message.collapsedHint")}`;

  button.append(icon, label);

  const body = document.createElement("div");
  body.className = "message-collapse-body";
  body.hidden = true;
  for (let index = 0; index < collapsedMessages.length; index += 1) {
    const message = collapsedMessages[index];
    if (message?._pairedToolResponseConsumed) {
      continue;
    }
    body.append(createMessageNode(message));
    if (hasToolCalls(message)) {
      index = relatedToolMessagesEndIndex(collapsedMessages, index);
    }
  }

  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    wrapper.classList.toggle("expanded", !expanded);
    body.hidden = expanded;
    label.textContent = `${labelText} · ${expanded ? t("message.collapsedHint") : t("message.collapseAgain")}`;
  });

  wrapper.append(button, body);
  return wrapper;
}

function createToolActivitySection({ label, text, className = "" }) {
  const section = document.createElement("div");
  section.className = `tool-activity-section ${className}`.trim();

  const labelEl = document.createElement("div");
  labelEl.className = "tool-activity-label";
  labelEl.textContent = label;

  const pre = document.createElement("pre");
  pre.className = "tool-activity-pre";
  pre.textContent = text;

  if (!shouldCollapseToolContent(text)) {
    section.append(labelEl, pre);
    return section;
  }

  const details = document.createElement("details");
  details.className = "tool-activity-content-details";

  const summary = document.createElement("summary");
  summary.className = "tool-activity-content-summary";

  const summaryLabel = document.createElement("span");
  summaryLabel.className = "tool-activity-label";
  summaryLabel.textContent = label;

  const summaryPreview = document.createElement("span");
  summaryPreview.className = "tool-activity-content-preview";
  summaryPreview.textContent = summarizeToolArguments(text);

  summary.append(summaryLabel, summaryPreview);
  details.append(summary, pre);
  section.append(details);
  return section;
}

function createToolActivityNode({ name, argsText = "", responseText = "", kind = "call" }) {
  const callEl = document.createElement("details");
  callEl.className = "tool-activity";
  if (argsText && responseText) {
    callEl.classList.add("tool-activity-paired");
  }

  const summary = document.createElement("summary");
  summary.className = "tool-activity-summary";

  const icon = document.createElement("span");
  icon.className = "tool-activity-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ">";

  const main = document.createElement("span");
  main.className = "tool-activity-main";

  const title = document.createElement("span");
  title.className = "tool-activity-title";
  title.textContent = name || "unknown";

  const preview = document.createElement("span");
  preview.className = "tool-activity-preview";
  preview.textContent = summarizeToolArguments(argsText || responseText);

  main.append(title, preview);

  const badge = document.createElement("span");
  badge.className = "tool-activity-badge";
  badge.textContent = kind === "result" ? t("message.toolResult") : t("message.toolCall");

  summary.append(icon, main, badge);
  callEl.append(summary);

  const body = document.createElement("div");
  body.className = "tool-activity-body";

  if (argsText) {
    const argsSection = createToolActivitySection({
      label: t("message.toolArgs"),
      text: argsText,
      className: "tool-activity-section-call",
    });
    body.append(argsSection);
  }

  if (responseText) {
    const responseSection = createToolActivitySection({
      label: t("message.toolResponse"),
      text: responseText,
      className: "tool-activity-section-response",
    });
    body.append(responseSection);
  }

  if (!argsText && !responseText) {
    const empty = document.createElement("div");
    empty.className = "tool-activity-empty";
    empty.textContent = t("message.toolNoArgs");
    body.append(empty);
  }

  callEl.append(body);
  return callEl;
}

function createTaskToolCallNode(toolCall, argsText, responseText) {
  const args = parseToolArguments(toolCall.function?.arguments ?? toolCall.arguments ?? "");
  const action = args.action || "task";
  const titleParts = ["task", action].filter(Boolean);
  const node = createToolActivityNode({
    name: titleParts.join(":"),
    argsText,
    responseText,
    kind: responseText ? "result" : "call",
  });
  node.classList.add("task-tool-activity");
  return node;
}

function createToolCallNode(toolCall, relatedMessages = []) {
  const name = getToolCallName(toolCall) || "unknown";
  const args = toolCall.function?.arguments ?? toolCall.arguments ?? "";
  const argsText = formatToolArguments(args);
  const responseText = relatedMessages.map((message) => message.content || "").filter(Boolean).join("\n\n");
  if (name === "task") {
    return createTaskToolCallNode(toolCall, argsText, responseText);
  }
  return createToolActivityNode({ name, argsText, responseText, kind: responseText ? "result" : "call" });
}

function createToolMessageNode(message) {
  const isResult = message._tool_result || message.role === "tool";
  return createToolActivityNode({
    name: getToolName(message) || "tool",
    argsText: isResult ? "" : message.content || "",
    responseText: isResult ? message.content || "" : message._pairedToolResponse?.content || "",
    kind: isResult || message._pairedToolResponse ? "result" : "call",
  });
}

function renderMessages(forceScroll = true) {
  const key = state.activeSessionKey;
  const messages = state.messages.get(key) || [];
  const previousBottomOffset =
    elements.messageList.scrollHeight - elements.messageList.scrollTop - elements.messageList.clientHeight;
  const wasNearBottom = previousBottomOffset < 120;
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

  prepareMessageRelationships(messages);
  const displayItems = createMessageDisplayItems(messages);
  for (const item of displayItems) {
    const node = item.type === "collapse"
      ? createCollapsedMessagesNode(item.messages)
      : createMessageNode(item.message);
    elements.messageList.append(node);
  }

  if (forceScroll || wasNearBottom) {
    scrollMessagesToBottom(true);
  } else {
    elements.messageList.scrollTop = Math.max(
      0,
      elements.messageList.scrollHeight - elements.messageList.clientHeight - previousBottomOffset,
    );
  }
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

function createTaskMetric(label, value) {
  const item = document.createElement("span");
  item.className = "task-progress-metric";

  const labelEl = document.createElement("span");
  labelEl.className = "task-progress-metric-label";
  labelEl.textContent = label;

  const valueEl = document.createElement("span");
  valueEl.className = "task-progress-metric-value";
  valueEl.textContent = String(value ?? 0);

  item.append(labelEl, valueEl);
  return item;
}

function createTaskProgressNode(message) {
  const data = taskProgressPayload(message) || {};
  const progress = data.progress || {};
  const planId = data.plan_id || progress.plan_id || message._task_plan_id || "";
  const title = data.plan_title || progress.title || "Task";
  const status = data.plan_status || progress.status || "executing";
  const total = Number(progress.total || 0);
  const completed = Number(progress.completed || 0);
  const percent = total > 0 ? clampPercent((completed / total) * 100) : 0;
  const subtasks = Array.isArray(data.subtasks) ? data.subtasks : [];

  const details = document.createElement("details");
  details.className = `task-progress-card task-progress-${taskStatusClass(status)}`;
  details.open = status !== "completed";

  const summary = document.createElement("summary");
  summary.className = "task-progress-summary";

  const marker = document.createElement("span");
  marker.className = `task-progress-status-dot task-status-${taskStatusClass(status)}`;
  marker.setAttribute("aria-hidden", "true");

  const main = document.createElement("span");
  main.className = "task-progress-main";

  const titleRow = document.createElement("span");
  titleRow.className = "task-progress-title-row";

  const titleEl = document.createElement("span");
  titleEl.className = "task-progress-title";
  titleEl.textContent = title;

  const badge = document.createElement("span");
  badge.className = `task-progress-badge task-badge-${taskStatusClass(status)}`;
  badge.textContent = taskStatusLabel(status);

  titleRow.append(titleEl, badge);

  const meta = document.createElement("span");
  meta.className = "task-progress-meta";
  const planText = planId ? `Plan ${planId}` : "Task plan";
  meta.textContent = `${planText} · ${completed}/${total || subtasks.length || 0}`;

  const bar = document.createElement("span");
  bar.className = "task-progress-bar";
  const fill = document.createElement("span");
  fill.className = "task-progress-bar-fill";
  fill.style.width = `${percent}%`;
  bar.append(fill);

  main.append(titleRow, meta, bar);
  summary.append(marker, main);
  details.append(summary);

  const body = document.createElement("div");
  body.className = "task-progress-body";

  const metrics = document.createElement("div");
  metrics.className = "task-progress-metrics";
  metrics.append(
    createTaskMetric("Done", progress.completed),
    createTaskMetric("Running", progress.in_progress),
    createTaskMetric("Pending", progress.pending),
    createTaskMetric("Failed", progress.failed),
  );
  body.append(metrics);

  if (subtasks.length) {
    const list = document.createElement("div");
    list.className = "task-progress-subtasks";
    subtasks.forEach((subtask) => {
      const row = document.createElement("div");
      row.className = `task-progress-subtask task-subtask-${taskStatusClass(subtask.status)}`;

      const subtaskDot = document.createElement("span");
      subtaskDot.className = `task-progress-subtask-dot task-status-${taskStatusClass(subtask.status)}`;
      subtaskDot.setAttribute("aria-hidden", "true");

      const text = document.createElement("span");
      text.className = "task-progress-subtask-text";

      const subtaskTitle = document.createElement("span");
      subtaskTitle.className = "task-progress-subtask-title";
      subtaskTitle.textContent = subtask.title || subtask.id || "Subtask";

      const subtaskMeta = document.createElement("span");
      subtaskMeta.className = "task-progress-subtask-meta";
      const metaParts = [subtask.id, taskStatusLabel(subtask.status)];
      if (Array.isArray(subtask.dependencies) && subtask.dependencies.length) {
        metaParts.push(`after ${subtask.dependencies.join(", ")}`);
      }
      if (subtask.parallel_safe === false) {
        metaParts.push("sequential");
      }
      subtaskMeta.textContent = metaParts.filter(Boolean).join(" · ");

      text.append(subtaskTitle, subtaskMeta);
      row.append(subtaskDot, text);
      list.append(row);
    });
    body.append(list);
  }

  details.append(body);
  return details;
}

function updateMessageContent(contentEl, message) {
  const previousReasoning = contentEl.querySelector(".message-reasoning-details");
  const previousReasoningState = previousReasoning
    ? { open: previousReasoning.open, manual: previousReasoning.dataset.reasoningManual === "true" }
    : {};
  contentEl.textContent = "";

  if (message.reasoning_content && message.reasoning_content.trim()) {
    contentEl.append(createReasoningNode(message.reasoning_content, previousReasoningState));
  }

  if (message._browser_snapshot) {
    const snapshotEl = document.createElement("figure");
    snapshotEl.className = "browser-snapshot";

    if (message.image_url) {
      const img = document.createElement("img");
      img.className = "browser-snapshot-image";
      img.src = message.image_url;
      img.alt = "Browser snapshot";
      snapshotEl.append(img);
    }

    if (message.source_command) {
      const caption = document.createElement("figcaption");
      caption.className = "browser-snapshot-caption";
      caption.textContent = message.source_command;
      snapshotEl.append(caption);
    }

    contentEl.append(snapshotEl);
    return;
  }

  if (message._task_event) {
    contentEl.append(createTaskProgressNode(message));
    return;
  }

  // Handle tool_calls for assistant messages
  if (message.role === "assistant" && message.tool_calls && message.tool_calls.length > 0) {
    const toolCallsEl = document.createElement("div");
    toolCallsEl.className = "tool-activities";
    const relatedMessages = message._relatedToolMessages || [];
    const relatedGroups = relatedToolMessageGroups(message.tool_calls, relatedMessages);
    message.tool_calls.forEach((tc, index) => {
      toolCallsEl.append(createToolCallNode(tc, relatedGroups[index] || []));
    });
    contentEl.append(toolCallsEl);
  }

  if (message.role === "tool" || message.role === "progress") {
    const toolCallsEl = document.createElement("div");
    toolCallsEl.className = "tool-activities";
    toolCallsEl.append(createToolMessageNode(message));
    contentEl.append(toolCallsEl);
    return;
  }

  if (message.content && message.content.trim()) {
    const textEl = document.createElement("div");
    textEl.className = "message-text";

    // 对assistant消息使用Markdown渲染
    if (message.role === "assistant" && typeof marked !== "undefined") {
      renderMarkdown(textEl, message.content);
      try {
        // 应用代码语法高亮和添加复制按钮
        if (typeof hljs !== "undefined") {
          textEl.querySelectorAll("pre code").forEach((block) => {
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
    key.textContent = sessionTitleForKey(item.key);
    key.title = item.chat_id;

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

function sessionFileIcon(fileType = "") {
  const value = fileType.toLowerCase();
  if (value === "md" || value === "markdown") return "MD";
  if (value === "pdf") return "PDF";
  return "TXT";
}

function renderSessionFiles() {
  const strip = elements.sessionFilesStrip;
  if (!strip) {
    return;
  }
  const items = state.sessionFiles.get(state.activeSessionKey) || [];
  strip.textContent = "";
  strip.hidden = items.length === 0;
  if (!items.length) {
    return;
  }

  const title = document.createElement("span");
  title.className = "session-files-label";
  title.textContent = t("sessionFiles.contextLabel");
  strip.append(title);

  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "session-file-chip";

    const icon = document.createElement("span");
    icon.className = "session-file-icon";
    icon.textContent = sessionFileIcon(item.file_type);

    const name = document.createElement("span");
    name.className = "session-file-name";
    name.textContent = item.name || t("sessionFiles.unnamed");
    name.title = item.name || "";

    const meta = document.createElement("span");
    meta.className = "session-file-meta";
    meta.textContent = `${item.chunk_count || 0} ${t("knowledge.chunks")}`;

    chip.append(icon, name, meta);
    strip.append(chip);
  }
}

async function loadSessionFiles(sessionKey) {
  if (!sessionKey) {
    return;
  }
  const response = await fetch(`${state.sessionsPath}/${encodeURIComponent(sessionKey)}/temporary-files`, {
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!response.ok) {
    state.sessionFiles.set(sessionKey, []);
    renderSessionFiles();
    return;
  }
  const payload = await response.json();
  state.sessionFiles.set(sessionKey, payload.items || []);
  renderSessionFiles();
}

function activateChat(chatId) {
  state.activeChatId = chatId;
  state.activeSessionKey = sessionKeyForChat(chatId);
  updateActiveChatTitle();
  renderSessions();
  renderMessages();
  renderSessionFiles();
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
  updateActiveChatTitle();
  renderSessions();
  renderMessages();
  await loadSessionFiles(sessionKey);
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
  state.sessionFiles.set(sessionKey, []);
  updateActiveChatTitle();
  renderSessions();
  renderMessages();
  renderSessionFiles();
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
  state.sessionFiles.delete(sessionKey);
  state.sessionItems = state.sessionItems.filter((item) => item.key !== sessionKey);

  // If deleted session was active, switch to another
  if (state.activeSessionKey === sessionKey) {
    if (state.sessionItems.length > 0) {
      await attachSession(state.sessionItems[0].chat_id);
    } else {
      state.activeChatId = "";
      state.activeSessionKey = "";
      updateActiveChatTitle();
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

  // 检查是否有工具未启用，显示配置提示
  const tools = state.config?.tools || {};
  const webEnabled = tools.web?.enable === true;
  const execEnabled = tools.exec?.enable === true;
  // 如果Web或Exec未启用，显示提示
  const showHint = !webEnabled || !execEnabled;
  const configHint = document.getElementById("tools-config-hint");
  if (configHint) {
    configHint.style.display = showHint ? "flex" : "none";
  }

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
        if (elements.modalStatsEntities) elements.modalStatsEntities.textContent = "-";
        if (elements.modalStatsClaims) elements.modalStatsClaims.textContent = "-";
        if (elements.modalStatsRelations) elements.modalStatsRelations.textContent = "-";
        if (elements.modalStatsCommunities) elements.modalStatsCommunities.textContent = "-";
        if (elements.modalStatsReports) elements.modalStatsReports.textContent = "-";
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
    if (elements.modalStatsEntities) elements.modalStatsEntities.textContent = payload.entity_count || 0;
    if (elements.modalStatsClaims) elements.modalStatsClaims.textContent = payload.claim_count || 0;
    if (elements.modalStatsRelations) elements.modalStatsRelations.textContent = payload.relation_count || 0;
    if (elements.modalStatsCommunities) elements.modalStatsCommunities.textContent = payload.community_count || 0;
    if (elements.modalStatsReports) elements.modalStatsReports.textContent = payload.community_report_count || 0;
    renderKnowledgeOverview();
  } catch (error) {
    console.error(error);
    elements.statsDocs.textContent = "-";
    elements.statsChunks.textContent = "-";
    if (elements.modalStatsDocs) elements.modalStatsDocs.textContent = "-";
    if (elements.modalStatsChunks) elements.modalStatsChunks.textContent = "-";
    if (elements.modalStatsEntities) elements.modalStatsEntities.textContent = "-";
    if (elements.modalStatsClaims) elements.modalStatsClaims.textContent = "-";
    if (elements.modalStatsRelations) elements.modalStatsRelations.textContent = "-";
    if (elements.modalStatsCommunities) elements.modalStatsCommunities.textContent = "-";
    if (elements.modalStatsReports) elements.modalStatsReports.textContent = "-";
  }
}

function renderKnowledgeOverview() {
  if (!state.knowledgeWorkbenchReady) {
    return;
  }
  if (state.knowledgeRebuilding) {
    renderKnowledgeRebuildPlaceholder();
    return;
  }
  const stats = state.knowledgeStats || {};
  const docs = Number(stats.total_documents || 0);
  const chunks = Number(stats.total_chunks || 0);
  const entities = Number(stats.entity_count || 0);
  const relations = Number(stats.relation_count || 0);
  const communities = Number(stats.community_count || 0);
  const reports = Number(stats.community_report_count || 0);
  const communityLevels = stats.community_count_by_level || stats.communityCountByLevel || {};
  const communityLevelText = Object.entries(communityLevels)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([level, count]) => t("knowledge.graphLevelCount").replace("{level}", level).replace("{count}", count))
    .join(", ");
  const indexedDense = Number(stats.indexed_dense || 0);
  const indexedSparse = Number(stats.indexed_sparse || 0);

  const checks = [
    docs > 0,
    chunks > 0,
    indexedDense > 0 || indexedSparse > 0,
    entities > 0,
    relations > 0,
    communities > 0,
    reports > 0,
  ];
  const score = Math.round((checks.filter(Boolean).length / checks.length) * 100);
  if (elements.knowledgeHealthScore) elements.knowledgeHealthScore.textContent = `${score}%`;
  if (elements.knowledgeHealthBar) elements.knowledgeHealthBar.style.width = `${score}%`;
  if (elements.knowledgeHealthTitle) {
    elements.knowledgeHealthTitle.textContent = score >= 85
      ? t("knowledge.healthReady")
      : score >= 55
        ? t("knowledge.healthSearchable")
        : docs > 0
          ? t("knowledge.healthNeedsSemantic")
          : t("knowledge.healthEmpty");
  }
  if (elements.knowledgeHealthDesc) {
    elements.knowledgeHealthDesc.textContent = docs
      ? t("knowledge.healthDesc")
        .replace("{docs}", docs)
        .replace("{chunks}", chunks)
        .replace("{entities}", entities)
        .replace("{relations}", relations)
        .replace("{communities}", communities)
      : t("knowledge.healthDescEmpty");
  }

  if (!elements.knowledgeOverviewInsights) {
    return;
  }
  elements.knowledgeOverviewInsights.textContent = "";
  const insights = [
    {
      title: t("knowledge.insightRetrievalIndex"),
      text: indexedDense || indexedSparse
        ? t("knowledge.insightRetrievalReady").replace("{dense}", indexedDense).replace("{sparse}", indexedSparse)
        : t("knowledge.insightRetrievalEmpty"),
    },
    {
      title: t("knowledge.insightSemanticModel"),
      text: entities
        ? t("knowledge.insightSemanticReady").replace("{entities}", entities).replace("{relations}", relations)
        : t("knowledge.insightSemanticEmpty"),
    },
    {
      title: t("knowledge.insightGraphRagLayer"),
      text: communities
        ? t("knowledge.insightGraphRagReady")
          .replace("{communities}", communities)
          .replace("{levels}", communityLevelText ? ` (${communityLevelText})` : "")
          .replace("{reports}", reports)
        : t("knowledge.insightGraphRagEmpty"),
    },
  ];
  for (const insight of insights) {
    const item = document.createElement("div");
    item.className = "knowledge-insight-item";
    item.innerHTML = `<strong>${escapeHtml(insight.title)}</strong><span>${escapeHtml(insight.text)}</span>`;
    elements.knowledgeOverviewInsights.append(item);
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

function formatKnowledgeJobMessage(job, fallback = "") {
  if (!job) {
    return fallback || t("knowledge.indexingDesc");
  }
  const processed = Number(job.processed || 0);
  const total = Math.max(1, Number(job.total || 1));
  const percent = Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
  const base = job.message || fallback || t("knowledge.indexingDesc");
  if (job.status === "failed") {
    return job.error ? `${base}: ${job.error}` : base;
  }
  if (job.status === "completed") {
    return t("knowledge.indexingDone");
  }
  return `${base} (${percent}%)`;
}

function setKnowledgeIndexingState(active, message = "", job = null) {
  state.knowledgeIndexing = active;
  if (elements.knowledgeIndexingStatus) {
    elements.knowledgeIndexingStatus.hidden = true;
  }
  setGlobalKnowledgeToast(active, message, job);

  const disabledButtons = [
    elements.rebuildIndexButton,
    elements.uploadDocButton,
    elements.docSaveButton,
  ];
  for (const button of disabledButtons) {
    if (button) {
      button.disabled = active;
      button.setAttribute("aria-busy", active ? "true" : "false");
    }
  }
}

function ensureGlobalKnowledgeToast() {
  if (elements.globalKnowledgeToast) {
    return;
  }
  const toast = document.createElement("div");
  toast.id = "global-knowledge-toast";
  toast.className = "global-knowledge-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.hidden = true;
  toast.innerHTML = `
    <div class="global-knowledge-spinner" aria-hidden="true"></div>
    <div class="global-knowledge-copy">
      <div id="global-knowledge-toast-title" class="global-knowledge-title">Building knowledge graph</div>
      <div id="global-knowledge-toast-desc" class="global-knowledge-desc"></div>
      <div class="global-knowledge-progress" aria-hidden="true">
        <div id="global-knowledge-progress-bar" class="global-knowledge-progress-bar"></div>
      </div>
    </div>
  `;
  document.body.append(toast);
  elements.globalKnowledgeToast = toast;
  elements.globalKnowledgeToastTitle = toast.querySelector("#global-knowledge-toast-title");
  elements.globalKnowledgeToastDesc = toast.querySelector("#global-knowledge-toast-desc");
  elements.globalKnowledgeProgressBar = toast.querySelector("#global-knowledge-progress-bar");
}

function setGlobalKnowledgeToast(active, message = "", job = null) {
  ensureGlobalKnowledgeToast();
  const toast = elements.globalKnowledgeToast;
  if (!toast) {
    return;
  }
  if (active) {
    if (elements.globalKnowledgeToastTitle) {
      elements.globalKnowledgeToastTitle.textContent = t("knowledge.indexingTitle");
    }
    if (elements.globalKnowledgeToastDesc) {
      elements.globalKnowledgeToastDesc.textContent = formatKnowledgeJobMessage(job, message);
    }
    if (elements.globalKnowledgeProgressBar) {
      const processed = Number(job?.processed || 0);
      const total = Math.max(1, Number(job?.total || 1));
      const percent = job ? Math.min(100, Math.max(0, Math.round((processed / total) * 100))) : 8;
      elements.globalKnowledgeProgressBar.style.width = `${percent}%`;
    }
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("active"));
    return;
  }
  toast.classList.remove("active");
  window.setTimeout(() => {
    if (!state.knowledgeIndexing) {
      toast.hidden = true;
    }
  }, 240);
}

function stopKnowledgeJobPolling() {
  if (state.knowledgeJobPollTimer) {
    window.clearTimeout(state.knowledgeJobPollTimer);
    state.knowledgeJobPollTimer = null;
  }
  state.activeKnowledgeJobId = "";
}

function scheduleKnowledgeJobPoll(jobId, message = "") {
  stopKnowledgeJobPolling();
  if (!jobId) {
    return;
  }
  state.activeKnowledgeJobId = jobId;

  const poll = async () => {
    try {
      const response = await fetch(`${state.knowledgeApiPath}/jobs/${encodeURIComponent(jobId)}`, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${state.token}` },
      });
      if (!response.ok) {
        throw new Error(`load knowledge job failed: ${response.status}`);
      }
      const job = await response.json();
      setKnowledgeIndexingState(job.status !== "completed" && job.status !== "failed", message, job);
      if (job.status === "completed") {
        stopKnowledgeJobPolling();
        state.knowledgeRebuilding = false;
        elements.docSuccess.textContent = t("knowledge.indexingDone");
        await loadKnowledgeStats();
        await loadKnowledgeDocs();
        await loadKnowledgeGraph();
        return;
      }
      if (job.status === "failed") {
        stopKnowledgeJobPolling();
        state.knowledgeRebuilding = false;
        elements.docError.textContent = formatKnowledgeJobMessage(job, t("knowledge.indexingFailed"));
        await loadKnowledgeStats();
        await loadKnowledgeGraph();
        return;
      }
      state.knowledgeJobPollTimer = window.setTimeout(poll, 1200);
    } catch (error) {
      console.error(error);
      state.knowledgeJobPollTimer = window.setTimeout(poll, 2500);
    }
  };

  poll();
}

function setupKnowledgeWorkbench() {
  if (state.knowledgeWorkbenchReady || !elements.knowledgeModal) {
    return;
  }

  const body = elements.knowledgeModal.querySelector(".modal-body");
  const stats = body?.querySelector(".knowledge-stats");
  const graphPanel = body?.querySelector(".knowledge-graph-panel");
  const docsPanel = body?.querySelector(".knowledge-docs-panel");
  const queryPanel = body?.querySelector(".knowledge-query-panel");
  if (!body || !stats || !graphPanel || !docsPanel || !queryPanel) {
    return;
  }

  const tabs = document.createElement("div");
  tabs.className = "knowledge-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", t("knowledge.views"));
  const tabItems = [
    ["overview", t("knowledge.overview")],
    ["graph", t("knowledge.graph")],
    ["documents", t("knowledge.documents")],
    ["query", t("knowledge.query")],
  ];
  for (const [key, label] of tabItems) {
    const button = document.createElement("button");
    button.className = `knowledge-tab${key === state.activeKnowledgeTab ? " active" : ""}`;
    button.type = "button";
    button.dataset.knowledgeTab = key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", key === state.activeKnowledgeTab ? "true" : "false");
    button.textContent = label;
    button.addEventListener("click", () => setKnowledgeTab(key));
    tabs.append(button);
  }

  const panels = document.createElement("div");
  panels.className = "knowledge-tab-panels";

  const overviewPanel = createKnowledgeTabPanel("overview");
  const overviewGrid = document.createElement("div");
  overviewGrid.className = "knowledge-overview-grid";
  overviewGrid.innerHTML = `
    <div class="knowledge-health-card">
      <div class="knowledge-health-main">
        <div>
          <div class="knowledge-card-kicker">${escapeHtml(t("knowledge.readiness"))}</div>
          <div id="knowledge-health-title" class="knowledge-health-title">${escapeHtml(t("knowledge.healthEmpty"))}</div>
        </div>
        <div id="knowledge-health-score" class="knowledge-health-score">0%</div>
      </div>
      <div class="knowledge-health-track"><div id="knowledge-health-bar" class="knowledge-health-bar" style="width: 0%"></div></div>
      <p id="knowledge-health-desc" class="knowledge-health-desc">${escapeHtml(t("knowledge.healthDescEmpty"))}</p>
    </div>
    <div class="knowledge-insight-list" id="knowledge-overview-insights"></div>
  `;
  overviewPanel.append(stats, overviewGrid);

  const graphPanelWrap = createKnowledgeTabPanel("graph");
  const graphHeader = graphPanel.querySelector(".graph-header");
  if (graphHeader) {
    const title = graphHeader.firstElementChild;
    if (title) {
      const scope = document.createElement("span");
      scope.id = "knowledge-graph-scope";
      scope.className = "graph-scope";
      scope.textContent = t("knowledge.allKnowledge");
      title.append(scope);
      elements.knowledgeGraphScope = scope;
    }
    const actions = graphHeader.querySelector(".graph-actions");
    if (actions) {
      const levelSelect = document.createElement("select");
      levelSelect.id = "knowledge-graph-level";
      levelSelect.className = "graph-level-select";
      levelSelect.setAttribute("aria-label", t("settings.knowledge.graphRagCommunityLevel"));
      for (const level of [0, 1]) {
        const option = document.createElement("option");
        option.value = String(level);
        option.textContent = t("knowledge.graphLevel").replace("{level}", level);
        levelSelect.append(option);
      }
      levelSelect.value = String(state.knowledgeGraphLevel);
      levelSelect.addEventListener("change", () => {
        state.knowledgeGraphLevel = Number.parseInt(levelSelect.value, 10) || 0;
        state.knowledgeGraphSelection = null;
        loadKnowledgeGraph();
      });
      actions.insertBefore(levelSelect, actions.firstChild);
      elements.knowledgeGraphLevelSelect = levelSelect;

      const clear = document.createElement("button");
      clear.id = "clear-graph-filter-button";
      clear.className = "button button-ghost button-small";
      clear.type = "button";
      clear.hidden = true;
      clear.textContent = t("knowledge.clearFilter");
      clear.addEventListener("click", () => setKnowledgeGraphDocumentFilter("", ""));
      actions.insertBefore(clear, actions.firstChild);
      elements.clearGraphFilterButton = clear;
    }
  }

  const graphWorkspace = document.createElement("div");
  graphWorkspace.className = "knowledge-graph-workspace";
  const graphHost = elements.knowledgeGraph;
  const inspector = document.createElement("aside");
  inspector.id = "knowledge-graph-inspector";
  inspector.className = "knowledge-graph-inspector";
  graphWorkspace.append(graphHost, inspector);
  elements.knowledgeGraphInspector = inspector;
  graphPanel.append(graphWorkspace);
  graphPanelWrap.append(graphPanel);

  const docsPanelWrap = createKnowledgeTabPanel("documents");
  docsPanelWrap.append(docsPanel);

  const queryPanelWrap = createKnowledgeTabPanel("query");
  const queryHeader = queryPanel.querySelector(".query-header");
  if (queryHeader) {
    const hint = document.createElement("span");
    hint.id = "query-mode-hint";
    hint.className = "query-mode-hint";
    queryHeader.append(hint);
    elements.queryModeHint = hint;
  }
  queryPanelWrap.append(queryPanel);

  panels.append(overviewPanel, graphPanelWrap, docsPanelWrap, queryPanelWrap);
  body.append(tabs, panels);
  elements.knowledgeHealthTitle = document.querySelector("#knowledge-health-title");
  elements.knowledgeHealthScore = document.querySelector("#knowledge-health-score");
  elements.knowledgeHealthBar = document.querySelector("#knowledge-health-bar");
  elements.knowledgeHealthDesc = document.querySelector("#knowledge-health-desc");
  elements.knowledgeOverviewInsights = document.querySelector("#knowledge-overview-insights");
  state.knowledgeWorkbenchReady = true;
  setKnowledgeTab(state.activeKnowledgeTab);
  renderKnowledgeOverview();
  renderKnowledgeGraphInspector();
  updateQueryModeHint();
}

function createKnowledgeTabPanel(key) {
  const panel = document.createElement("section");
  panel.className = `knowledge-tab-panel${key === state.activeKnowledgeTab ? " active" : ""}`;
  panel.dataset.knowledgePanel = key;
  panel.setAttribute("role", "tabpanel");
  return panel;
}

function setKnowledgeTab(key) {
  state.activeKnowledgeTab = key;
  document.querySelectorAll(".knowledge-tab").forEach((tab) => {
    const active = tab.dataset.knowledgeTab === key;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".knowledge-tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.knowledgePanel === key);
  });
  if (key === "graph") {
    loadKnowledgeGraph();
  }
  if (key === "overview") {
    renderKnowledgeOverview();
  }
}

async function loadKnowledgeGraph() {
  if (!elements.knowledgeGraph) {
    return;
  }

  try {
    elements.knowledgeGraph.textContent = "";
    const loading = document.createElement("div");
    loading.className = "empty-state";
    loading.textContent = t("status.loading");
    elements.knowledgeGraph.append(loading);

    state.knowledgeGraph = await loadKnowledgeGraphPayload();
    if (!state.knowledgeGraph) {
      return;
    }
    renderKnowledgeGraph(state.knowledgeGraph);
  } catch (error) {
    console.error(error);
    renderKnowledgeGraph(null, t("status.loadFailed"));
  }
}

async function loadKnowledgeGraphPayload() {
  const docParam = state.knowledgeGraphFilterDocId
    ? `&doc_id=${encodeURIComponent(state.knowledgeGraphFilterDocId)}`
    : "";
  const levelParam = `&level=${encodeURIComponent(String(state.knowledgeGraphLevel || 0))}`;
  const graphragResponse = await fetch(`${state.knowledgeApiPath}/graphrag?min_confidence=0&include_reports=true&include_covariates=true${levelParam}${docParam}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${state.token}` },
  });

  if (graphragResponse.ok) {
    const graphragPayload = await parseKnowledgeJsonResponse(graphragResponse, "GraphRAG index");
    const graph = normalizeGraphRagIndex(graphragPayload);
    if (graph.nodes.length || graph.edges.length) {
      return graph;
    }
  } else if (graphragResponse.status === 503) {
    renderKnowledgeGraph(null, t("status.unavailable"));
    return null;
  } else if (![404, 405].includes(graphragResponse.status)) {
    console.warn(`load GraphRAG index failed: ${graphragResponse.status}; falling back to graph API`);
  }

  const graphResponse = await fetch(`${state.knowledgeApiPath}/graph?limit=80&edge_limit=160${docParam}`, {
    cache: "no-store",
    headers: { Authorization: `Bearer ${state.token}` },
  });
  if (!graphResponse.ok) {
    if (graphResponse.status === 503) {
      renderKnowledgeGraph(null, t("status.unavailable"));
      return null;
    }
    throw new Error(`load knowledge graph failed: ${graphResponse.status}`);
  }
  return parseKnowledgeJsonResponse(graphResponse, "knowledge graph");
}

async function parseKnowledgeJsonResponse(response, label) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${label} API returned non-JSON response`);
  }
  return response.json();
}

function normalizeGraphRagIndex(index) {
  if (!index || index.object !== "graphrag_index") {
    return index || { nodes: [], edges: [], stats: {} };
  }

  const documents = new Map((index.documents || []).map((doc) => [doc.id, doc]));
  const textUnits = new Map((index.text_units || []).map((unit) => [unit.id, unit]));
  const claims = new Map((index.covariates || []).map((claim) => [claim.id, claim]));
  const reportByCommunity = new Map((index.community_reports || []).map((report) => [report.community, report]));
  const communities = (index.communities || []).map((community) => ({
    ...community,
    report: reportByCommunity.get(community.community) || null,
  }));
  const communityByEntity = new Map();
  for (const community of communities) {
    for (const entityId of community.entity_ids || []) {
      if (!communityByEntity.has(entityId)) {
        communityByEntity.set(entityId, community);
      }
    }
  }
  const entityByName = new Map();

  const nodes = (index.entities || []).map((entity) => {
    const community = communityByEntity.get(entity.id);
    const report = community?.report || null;
    const node = {
      id: entity.id,
      label: entity.title || entity.id,
      canonical_name: entity.title || entity.id,
      type: entity.type || "concept",
      aliases: entity.aliases || [],
      doc_ids: entity.doc_ids || [],
      doc_names: (entity.doc_ids || []).map((docId) => documents.get(docId)?.title || docId),
      mention_count: entity.frequency || 0,
      degree: entity.degree || 0,
      confidence: entity.confidence || 0,
      description: entity.description || "",
      community_id: community?.community ?? null,
      community_title: community?.title || "",
      community_level: community?.level ?? null,
      community_parent: community?.parent ?? null,
      community_report_id: report?.id || "",
      community_report_summary: report?.summary || "",
      score: (entity.degree || 0) + (entity.frequency || 0),
    };
    entityByName.set(node.label, node);
    return node;
  });

  const edges = (index.relationships || [])
    .map((relationship) => {
      const source = entityByName.get(relationship.source);
      const target = entityByName.get(relationship.target);
      const evidence = buildGraphRagEvidence(relationship, textUnits, documents, claims);
      return {
        id: relationship.id || `${source?.id || relationship.source}:${relationship.predicate}:${target?.id || relationship.target}`,
        source: source?.id || relationship.source,
        target: target?.id || relationship.target,
        predicate: relationship.predicate || "related_to",
        count: relationship.relation_ids?.length || Math.max(1, Math.round(relationship.weight || 1)),
        confidence: relationship.confidence || 0,
        confidence_avg: relationship.confidence || 0,
        weight: relationship.weight || 0,
        strength: relationship.strength || relationship.weight || 0,
        combined_degree: relationship.combined_degree || 0,
        text_unit_ids: relationship.text_unit_ids || [],
        community_id: source?.community_id === target?.community_id ? source?.community_id : null,
        community_title: source?.community_id === target?.community_id ? source?.community_title : "",
        evidence,
        doc_names: Array.from(new Set(evidence.map((item) => item.doc_name).filter(Boolean))),
        description: relationship.description || "",
      };
    })
    .filter((edge) => edge.source && edge.target);

  return {
    object: "knowledge_graph",
    source: "graphrag_index",
    nodes,
    edges,
    communities,
    community_reports: index.community_reports || [],
    stats: {
      ...(index.stats || {}),
      node_count: nodes.length,
      edge_count: edges.length,
      level: index.stats?.level ?? state.knowledgeGraphLevel ?? 0,
    },
  };
}

function buildGraphRagEvidence(relationship, textUnits, documents, claims) {
  const evidence = [];
  for (const textUnitId of relationship.text_unit_ids || []) {
    const textUnit = textUnits.get(textUnitId);
    const document = textUnit ? documents.get(textUnit.document_id) : null;
    const claimTexts = (textUnit?.covariate_ids || [])
      .map((claimId) => claims.get(claimId)?.source_text || claims.get(claimId)?.description || "")
      .filter(Boolean);
    evidence.push({
      relation_id: relationship.id,
      claim_id: textUnit?.covariate_ids?.[0] || "",
      chunk_id: textUnitId,
      doc_id: textUnit?.document_id || "",
      doc_name: document?.title || textUnit?.document_id || "",
      file_path: "",
      line_start: textUnit?.line_start || 0,
      line_end: textUnit?.line_end || 0,
      page: textUnit?.page || null,
      section_path: textUnit?.section_path || "",
      text: claimTexts[0] || relationship.description || textUnit?.text || "",
      confidence: relationship.confidence || 0,
    });
    if (evidence.length >= 4) {
      break;
    }
  }
  if (!evidence.length && relationship.description) {
    evidence.push({
      relation_id: relationship.id,
      claim_id: "",
      chunk_id: "",
      doc_id: "",
      doc_name: "",
      file_path: "",
      line_start: 0,
      line_end: 0,
      page: null,
      section_path: "",
      text: relationship.description,
      confidence: relationship.confidence || 0,
    });
  }
  return evidence;
}

function renderKnowledgeGraph(graph, fallbackText = t("knowledge.noGraph")) {
  if (!elements.knowledgeGraph) {
    return;
  }

  if (state.knowledgeGraphRuntime?.destroy) {
    state.knowledgeGraphRuntime.destroy();
    state.knowledgeGraphRuntime = null;
  }
  elements.knowledgeGraph.textContent = "";
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (elements.knowledgeGraphMeta) {
    const communityCount = graph?.stats?.community_count || 0;
    const reportCount = graph?.stats?.community_report_count || 0;
    const graphLevel = graph?.stats?.level ?? state.knowledgeGraphLevel ?? 0;
    const graphMeta = [
      t("knowledge.graphMetaLevel").replace("{level}", graphLevel),
      t("knowledge.graphMetaNodes").replace("{count}", nodes.length),
      t("knowledge.graphMetaEdges").replace("{count}", edges.length),
    ];
    if (communityCount) graphMeta.push(t("knowledge.graphMetaCommunities").replace("{count}", communityCount));
    if (reportCount) graphMeta.push(t("knowledge.graphMetaReports").replace("{count}", reportCount));
    elements.knowledgeGraphMeta.textContent = graphMeta.join(" / ");
  }
  if (elements.knowledgeGraphLevelSelect) {
    elements.knowledgeGraphLevelSelect.value = String(state.knowledgeGraphLevel || 0);
  }
  if (elements.knowledgeGraphScope) {
    const levelText = t("knowledge.graphLevel").replace("{level}", state.knowledgeGraphLevel || 0);
    elements.knowledgeGraphScope.textContent = state.knowledgeGraphFilterDocName
      ? t("knowledge.filteredScope").replace("{name}", state.knowledgeGraphFilterDocName).replace("{level}", levelText)
      : `${t("knowledge.allKnowledge")} / ${levelText}`;
  }
  if (elements.clearGraphFilterButton) {
    elements.clearGraphFilterButton.hidden = !state.knowledgeGraphFilterDocId;
  }
  state.knowledgeGraphSelection = null;
  renderKnowledgeGraphInspector();

  if (!nodes.length || !edges.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = fallbackText;
    elements.knowledgeGraph.append(empty);
    return;
  }

  const canvas = document.createElement("div");
  canvas.className = "graph-canvas";

  const controls = document.createElement("div");
  controls.className = "graph-controls";
  const zoomOut = createKnowledgeGraphControlButton("-", "Zoom out");
  const zoomReset = createKnowledgeGraphControlButton("1:1", "Reset view");
  const zoomIn = createKnowledgeGraphControlButton("+", "Zoom in");
  const layoutToggle = createKnowledgeGraphControlButton(t("knowledge.freeze"), t("knowledge.freezeLayout"));
  controls.append(zoomOut, zoomReset, zoomIn, layoutToggle);

  const hint = document.createElement("div");
  hint.className = "graph-hint";
  hint.textContent = t("knowledge.graphHint");

  const canvasSurface = document.createElement("canvas");
  canvasSurface.className = "knowledge-graph-canvas";
  canvasSurface.setAttribute("aria-label", t("knowledge.interactiveGraph"));
  canvasSurface.setAttribute("role", "img");
  canvasSurface.tabIndex = 0;
  canvas.append(canvasSurface, controls, hint);
  const evidenceList = renderKnowledgeGraphEvidence(nodes, edges);
  const communityPanel = renderKnowledgeGraphCommunities(graph?.communities || [], nodes);
  elements.knowledgeGraph.append(canvas, communityPanel, evidenceList);
  state.knowledgeGraphRuntime = renderKnowledgeGraphCanvas(canvasSurface, nodes, edges, {
    zoomIn,
    zoomOut,
    zoomReset,
    layoutToggle,
    onSelect: renderKnowledgeGraphSelection,
  });
}

function createKnowledgeGraphControlButton(label, title) {
  const button = document.createElement("button");
  button.className = "graph-control-button";
  button.type = "button";
  button.textContent = label;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

function renderKnowledgeGraphSelection(selection) {
  state.knowledgeGraphSelection = selection?.node || selection?.edge
    ? { node: selection.node || null, edge: selection.edge || null }
    : null;
  renderKnowledgeGraphInspector();
}

function renderKnowledgeGraphInspector() {
  const inspector = elements.knowledgeGraphInspector;
  if (!inspector) {
    return;
  }
  inspector.textContent = "";
  const selection = state.knowledgeGraphSelection;
  if (!selection?.node && !selection?.edge) {
    const graph = state.knowledgeGraph || {};
    const nodes = graph.nodes || [];
    const edges = graph.edges || [];
    const topNodes = [...nodes]
      .sort((a, b) => ((b.degree || 0) + (b.mention_count || 0)) - ((a.degree || 0) + (a.mention_count || 0)))
      .slice(0, 5);
    const empty = document.createElement("div");
    empty.className = "inspector-empty";
    const overviewTitle = document.createElement("div");
    overviewTitle.className = "inspector-title";
    overviewTitle.textContent = t("knowledge.graphOverview");
    const overviewDesc = document.createElement("p");
    overviewDesc.textContent = t("knowledge.graphOverviewDesc")
      .replace("{entities}", nodes.length)
      .replace("{relationships}", edges.length);
    empty.append(overviewTitle, overviewDesc);
    inspector.append(empty);
    if (topNodes.length) {
      inspector.append(createInspectorSection(t("knowledge.coreEntities"), topNodes.map((node) => `${node.label} (${node.degree || 0})`)));
    }
    const communities = graph.communities || [];
    if (communities.length) {
      inspector.append(createInspectorSection(t("knowledge.communities"), communities.slice(0, 5).map((item) => item.title || t("knowledge.communityName").replace("{id}", item.community))));
    }
    return;
  }

  if (selection.node) {
    const node = selection.node;
    inspector.append(createInspectorTitle(node.label || node.id, node.type || "entity"));
    inspector.append(createInspectorText(node.description || node.community_report_summary || t("knowledge.noDescriptionAvailable")));
    inspector.append(createInspectorMetrics([
      [t("knowledge.degree"), node.degree || 0],
      [t("knowledge.frequency"), node.mention_count || 0],
      [t("knowledge.community"), node.community_level == null ? "-" : `L${node.community_level}`],
    ]));
    if (node.community_title) {
      inspector.append(createInspectorSection(t("knowledge.community"), [node.community_title]));
    }
    if (node.doc_names?.length) {
      inspector.append(createInspectorSection(t("knowledge.sourceDocuments"), node.doc_names.slice(0, 6)));
    }
    return;
  }

  if (selection.edge) {
    const edge = selection.edge;
    inspector.append(createInspectorTitle(edge.predicate || t("knowledge.relationship"), t("knowledge.relationship")));
    inspector.append(createInspectorText(edge.description || t("knowledge.noRelationshipDescription")));
    inspector.append(createInspectorMetrics([
      [t("knowledge.weight"), formatInspectorNumber(edge.weight || edge.count)],
      [t("knowledge.strength"), formatInspectorNumber(edge.strength || edge.weight || edge.count)],
      [t("knowledge.evidence"), edge.evidence?.length || 0],
    ]));
    if (edge.doc_names?.length) {
      inspector.append(createInspectorSection(t("knowledge.sourceDocuments"), edge.doc_names.slice(0, 6)));
    }
    if (edge.evidence?.length) {
      const evidence = edge.evidence.slice(0, 4).map((item) => {
        const where = [item.doc_name, item.line_start ? `L${item.line_start}-${item.line_end || item.line_start}` : ""].filter(Boolean).join(" / ");
        return `${where ? `${where}: ` : ""}${item.text || ""}`;
      });
      inspector.append(createInspectorSection(t("knowledge.evidence"), evidence));
    }
  }
}

function createInspectorTitle(title, kicker) {
  const block = document.createElement("div");
  block.className = "inspector-heading";
  const small = document.createElement("div");
  small.className = "inspector-kicker";
  small.textContent = kicker;
  const main = document.createElement("div");
  main.className = "inspector-title";
  main.textContent = title;
  block.append(small, main);
  return block;
}

function createInspectorText(text) {
  const item = document.createElement("p");
  item.className = "inspector-text";
  item.textContent = text;
  return item;
}

function createInspectorMetrics(items) {
  const grid = document.createElement("div");
  grid.className = "inspector-metrics";
  for (const [label, value] of items) {
    const metric = document.createElement("div");
    metric.className = "inspector-metric";
    metric.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
    grid.append(metric);
  }
  return grid;
}

function createInspectorSection(title, rows) {
  const section = document.createElement("div");
  section.className = "inspector-section";
  const heading = document.createElement("div");
  heading.className = "inspector-section-title";
  heading.textContent = title;
  section.append(heading);
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "inspector-row";
    item.textContent = row;
    section.append(item);
  }
  return section;
}

function formatInspectorNumber(value) {
  if (value == null || value === "") {
    return "-";
  }
  const num = Number(value);
  return Number.isFinite(num) ? num.toFixed(num >= 10 ? 0 : 3) : String(value);
}

function normalizeKnowledgeMatchText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function renderKnowledgeGraphCanvas(canvas, nodes, edges, controls = {}) {
  const ctx = canvas.getContext("2d");
  const nodeMap = new Map();
  const graphNodes = nodes.map((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    const radius = 90 + Math.sqrt(Math.max(1, nodes.length)) * 24;
    const item = {
      ...node,
      x: Math.cos(angle) * radius + (Math.random() - 0.5) * 40,
      y: Math.sin(angle) * radius + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
      radius: Math.min(16, 5 + Math.sqrt((node.degree || 0) + (node.mention_count || 0)) * 2.4),
      color: knowledgeGraphNodeColor(node),
      communityColor: knowledgeGraphCommunityColor(node.community_id),
    };
    nodeMap.set(node.id, item);
    return item;
  });
  const links = edges
    .map((edge) => ({
      ...edge,
      id: edge.id || `${edge.source}:${edge.predicate}:${edge.target}`,
      sourceNode: nodeMap.get(edge.source),
      targetNode: nodeMap.get(edge.target),
    }))
    .filter((edge) => edge.sourceNode && edge.targetNode);

  const neighbors = new Map();
  for (const node of graphNodes) {
    neighbors.set(node.id, new Set());
  }
  for (const edge of links) {
    neighbors.get(edge.source)?.add(edge.target);
    neighbors.get(edge.target)?.add(edge.source);
  }

  function highlightMatches(kind, value) {
    const terms = Array.isArray(value) ? value : [value];
    const normalized = terms.map((item) => normalizeKnowledgeMatchText(item)).filter(Boolean);
    if (!normalized.length) {
      return () => false;
    }
    if (kind === "node") {
      return (node) => normalized.some((term) => normalizeKnowledgeMatchText([
        node.label,
        node.canonical_name,
        node.description,
        ...(node.aliases || []),
      ].join(" ")).includes(term));
    }
    if (kind === "edge") {
      return (edge) => normalized.some((term) => normalizeKnowledgeMatchText([
        edge.predicate,
        edge.description,
        ...(edge.evidence || []).map((item) => item.text).join(" "),
      ].join(" ")).includes(term));
    }
    if (kind === "community") {
      return (node) => normalized.some((term) => normalizeKnowledgeMatchText([
        node.community_title,
        node.community_report_summary,
      ].join(" ")).includes(term));
    }
    return () => false;
  }

  const view = {
    scale: state.knowledgeGraphView?.scale || 1,
    x: state.knowledgeGraphView?.x || 0,
    y: state.knowledgeGraphView?.y || 0,
  };
  const runtime = {
    frame: 0,
    destroyed: false,
    frozen: false,
    alpha: 1,
    selectedNodeId: "",
    selectedEdgeId: "",
    hoverNodeId: "",
    hoverEdgeId: "",
    drag: null,
    width: 1,
    height: 1,
    dpr: 1,
  };

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    runtime.width = Math.max(320, rect.width || 720);
    runtime.height = Math.max(260, rect.height || 420);
    runtime.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(runtime.width * runtime.dpr);
    canvas.height = Math.floor(runtime.height * runtime.dpr);
    ctx.setTransform(runtime.dpr, 0, 0, runtime.dpr, 0, 0);
  }

  function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - runtime.width / 2 - view.x) / view.scale,
      y: (clientY - rect.top - runtime.height / 2 - view.y) / view.scale,
    };
  }

  function worldToScreen(node) {
    return {
      x: runtime.width / 2 + view.x + node.x * view.scale,
      y: runtime.height / 2 + view.y + node.y * view.scale,
    };
  }

  function findNodeAt(clientX, clientY) {
    const point = screenToWorld(clientX, clientY);
    for (let i = graphNodes.length - 1; i >= 0; i -= 1) {
      const node = graphNodes[i];
      const dx = point.x - node.x;
      const dy = point.y - node.y;
      const hitRadius = Math.max(12 / view.scale, node.radius + 5 / view.scale);
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        return node;
      }
    }
    return null;
  }

  function findEdgeAt(clientX, clientY) {
    const point = screenToWorld(clientX, clientY);
    let best = null;
    let bestDistance = 12 / view.scale;
    for (const edge of links) {
      const distance = distanceToSegment(point, edge.sourceNode, edge.targetNode);
      if (distance < bestDistance) {
        best = edge;
        bestDistance = distance;
      }
    }
    return best;
  }

  function updateEvidenceHighlight() {
    document.querySelectorAll(".graph-evidence-item").forEach((row) => {
      row.classList.toggle("is-selected", !!runtime.selectedEdgeId && row.dataset.edgeId === runtime.selectedEdgeId);
      row.classList.toggle("is-connected", !!runtime.selectedNodeId && (row.dataset.source === runtime.selectedNodeId || row.dataset.target === runtime.selectedNodeId));
    });
  }

  function setSelection({ nodeId = "", edgeId = "" }) {
    runtime.selectedNodeId = nodeId;
    runtime.selectedEdgeId = edgeId;
    updateEvidenceHighlight();
    const selectedNode = nodeId ? nodeMap.get(nodeId) : null;
    const selectedEdge = edgeId ? links.find((item) => item.id === edgeId) : null;
    controls.onSelect?.({
      node: selectedNode || null,
      edge: selectedEdge || null,
      graph: { nodes: graphNodes, edges: links },
    });
  }

  function setZoom(nextScale, anchorX = runtime.width / 2, anchorY = runtime.height / 2) {
    const oldScale = view.scale;
    view.scale = Math.min(5, Math.max(0.25, nextScale));
    const worldX = (anchorX - runtime.width / 2 - view.x) / oldScale;
    const worldY = (anchorY - runtime.height / 2 - view.y) / oldScale;
    view.x = anchorX - runtime.width / 2 - worldX * view.scale;
    view.y = anchorY - runtime.height / 2 - worldY * view.scale;
    state.knowledgeGraphView = { ...view };
  }

  function resetView() {
    view.scale = 1;
    view.x = 0;
    view.y = 0;
    runtime.alpha = Math.max(runtime.alpha, 0.4);
    state.knowledgeGraphView = { ...view };
  }

  function tickPhysics() {
    if (runtime.frozen) {
      return;
    }
    const alpha = runtime.alpha;
    for (let i = 0; i < graphNodes.length; i += 1) {
      for (let j = i + 1; j < graphNodes.length; j += 1) {
        const a = graphNodes[i];
        const b = graphNodes[j];
        const dx = a.x - b.x || 0.01;
        const dy = a.y - b.y || 0.01;
        const distanceSq = Math.max(80, dx * dx + dy * dy);
        const force = (4600 * alpha) / distanceSq;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const edge of links) {
      const a = edge.sourceNode;
      const b = edge.targetNode;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const preferred = 80 + Math.min(90, 18 * Math.sqrt(edge.count || 1));
      const force = (distance - preferred) * 0.012 * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of graphNodes) {
      node.vx += -node.x * 0.004 * alpha;
      node.vy += -node.y * 0.004 * alpha;
      node.vx *= 0.82;
      node.vy *= 0.82;
      if (runtime.drag?.node !== node) {
        node.x += node.vx;
        node.y += node.vy;
      }
    }
    runtime.alpha = Math.max(0.018, runtime.alpha * 0.986);
  }

  function drawGrid() {
    const spacing = 36 * view.scale;
    if (spacing < 9) {
      return;
    }
    const offsetX = ((runtime.width / 2 + view.x) % spacing + spacing) % spacing;
    const offsetY = ((runtime.height / 2 + view.y) % spacing + spacing) % spacing;
    ctx.fillStyle = "rgba(148, 163, 184, 0.16)";
    for (let x = offsetX; x < runtime.width; x += spacing) {
      for (let y = offsetY; y < runtime.height; y += spacing) {
        ctx.beginPath();
        ctx.arc(x, y, 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function isNodeActive(node) {
    const highlight = state.knowledgeGraphHighlight;
    if (highlight) {
      const entityTerms = highlight.entities?.length ? highlight.entities : highlight.query;
      const communityTerms = highlight.communities?.length ? highlight.communities : "";
      if (highlightMatches("node", entityTerms || "")(node)) return true;
      if (highlightMatches("community", communityTerms)(node)) return true;
    }
    const focusNodeId = runtime.hoverNodeId || runtime.selectedNodeId;
    const focusEdgeId = runtime.hoverEdgeId || runtime.selectedEdgeId;
    const selectedNode = focusNodeId ? nodeMap.get(focusNodeId) : null;
    if (node.id === focusNodeId) return true;
    if (focusNodeId && neighbors.get(focusNodeId)?.has(node.id)) return true;
    if (selectedNode && selectedNode.community_id != null && selectedNode.community_id === node.community_id) return true;
    if (focusEdgeId) {
      const edge = links.find((item) => item.id === focusEdgeId);
      return edge && (edge.source === node.id || edge.target === node.id);
    }
    return false;
  }

  function isEdgeActive(edge) {
    const highlight = state.knowledgeGraphHighlight;
    if (highlight) {
      const relationTerms = highlight.relations?.length ? highlight.relations : highlight.query;
      if (highlightMatches("edge", relationTerms || "")(edge)) {
        return true;
      }
    }
    const focusNodeId = runtime.hoverNodeId || runtime.selectedNodeId;
    const focusEdgeId = runtime.hoverEdgeId || runtime.selectedEdgeId;
    const selectedNode = focusNodeId ? nodeMap.get(focusNodeId) : null;
    return edge.id === focusEdgeId
      || (!!focusNodeId && (edge.source === focusNodeId || edge.target === focusNodeId))
      || (!!selectedNode && selectedNode.community_id != null && edge.community_id === selectedNode.community_id);
  }

  function draw() {
    ctx.clearRect(0, 0, runtime.width, runtime.height);
    const gradient = ctx.createRadialGradient(runtime.width * 0.52, runtime.height * 0.46, 40, runtime.width * 0.5, runtime.height * 0.5, Math.max(runtime.width, runtime.height) * 0.72);
    gradient.addColorStop(0, "#151a26");
    gradient.addColorStop(1, "#090b10");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, runtime.width, runtime.height);
    drawGrid();

    ctx.save();
    ctx.translate(runtime.width / 2 + view.x, runtime.height / 2 + view.y);
    ctx.scale(view.scale, view.scale);

    for (const edge of links) {
      const active = isEdgeActive(edge);
      ctx.beginPath();
      ctx.moveTo(edge.sourceNode.x, edge.sourceNode.y);
      ctx.lineTo(edge.targetNode.x, edge.targetNode.y);
      ctx.strokeStyle = active ? knowledgeGraphCommunityStroke(edge.community_id) : "rgba(116, 129, 154, 0.28)";
      ctx.lineWidth = (active ? 1.8 : 0.8) / view.scale + Math.min(1.4, Math.sqrt(edge.count || 1) * 0.18);
      ctx.stroke();
    }

    for (const node of graphNodes) {
      const active = isNodeActive(node);
      const selected = node.id === runtime.selectedNodeId || node.id === runtime.hoverNodeId;
      const radius = node.radius * (selected ? 1.18 : 1);
      if (active) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 7 / view.scale, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(96, 165, 250, 0.16)";
        ctx.fill();
      }

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = node.community_id != null ? node.communityColor : node.color;
      ctx.fill();
      ctx.lineWidth = selected ? 2.2 / view.scale : 1.2 / view.scale;
      ctx.strokeStyle = selected ? "rgba(219, 234, 254, 0.98)" : "rgba(226, 232, 240, 0.56)";
      ctx.stroke();
    }

    const shouldShowAllLabels = view.scale > 0.78 || graphNodes.length <= 28;
    for (const node of graphNodes) {
      const active = isNodeActive(node);
      if (!active && !shouldShowAllLabels && (node.degree || 0) < 2) {
        continue;
      }
      ctx.font = `${active ? 600 : 500} ${Math.max(10, 11 / view.scale)}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const label = compactGraphLabel(node.label || node.id);
      const labelY = node.y + node.radius + 5 / view.scale;
      ctx.lineWidth = 4 / view.scale;
      ctx.strokeStyle = "rgba(9, 11, 16, 0.92)";
      ctx.strokeText(label, node.x, labelY);
      ctx.fillStyle = active ? "#f8fafc" : "rgba(226, 232, 240, 0.82)";
      ctx.fillText(label, node.x, labelY);
    }
    ctx.restore();

  if (runtime.hoverNodeId) {
    const node = nodeMap.get(runtime.hoverNodeId);
    const subtitle = node?.community_title || node?.type || "concept";
    drawGraphTooltip(node?.label || "", subtitle, node ? worldToScreen(node) : null);
  }
  }

  function drawGraphTooltip(title, subtitle, point) {
    if (!point || !title) return;
    const text = `${title} · ${subtitle}`;
    ctx.font = "12px Inter, system-ui, sans-serif";
    const width = Math.min(280, ctx.measureText(text).width + 18);
    const x = Math.min(runtime.width - width - 12, Math.max(12, point.x + 12));
    const y = Math.min(runtime.height - 34, Math.max(12, point.y - 28));
    ctx.fillStyle = "rgba(15, 23, 42, 0.94)";
    ctx.strokeStyle = "rgba(148, 163, 184, 0.28)";
    ctx.beginPath();
    ctx.roundRect(x, y, width, 26);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText(text, x + 9, y + 8);
  }

  function frame() {
    if (runtime.destroyed) return;
    tickPhysics();
    draw();
    runtime.frame = requestAnimationFrame(frame);
  }

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const direction = event.deltaY < 0 ? 1.12 : 0.88;
    setZoom(view.scale * direction, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });

  canvas.addEventListener("dblclick", (event) => {
    event.preventDefault();
    resetView();
  });

  canvas.addEventListener("pointerdown", (event) => {
    canvas.setPointerCapture(event.pointerId);
    canvas.classList.add("is-dragging");
    const node = findNodeAt(event.clientX, event.clientY);
    if (node) {
      const point = screenToWorld(event.clientX, event.clientY);
      runtime.drag = { type: "node", node, offsetX: point.x - node.x, offsetY: point.y - node.y };
      runtime.alpha = 0.8;
      setSelection({ nodeId: node.id });
      return;
    }
    const edge = findEdgeAt(event.clientX, event.clientY);
    if (edge) {
      setSelection({ edgeId: edge.id });
    } else {
      setSelection({});
    }
    runtime.drag = {
      type: "pan",
      startX: event.clientX,
      startY: event.clientY,
      originX: view.x,
      originY: view.y,
    };
  });

  canvas.addEventListener("pointermove", (event) => {
    if (runtime.drag?.type === "node") {
      const point = screenToWorld(event.clientX, event.clientY);
      runtime.drag.node.x = point.x - runtime.drag.offsetX;
      runtime.drag.node.y = point.y - runtime.drag.offsetY;
      runtime.drag.node.vx = 0;
      runtime.drag.node.vy = 0;
      runtime.alpha = 0.55;
      return;
    }
    if (runtime.drag?.type === "pan") {
      view.x = runtime.drag.originX + event.clientX - runtime.drag.startX;
      view.y = runtime.drag.originY + event.clientY - runtime.drag.startY;
      state.knowledgeGraphView = { ...view };
      return;
    }

    const node = findNodeAt(event.clientX, event.clientY);
    const edge = node ? null : findEdgeAt(event.clientX, event.clientY);
    runtime.hoverNodeId = node?.id || "";
    runtime.hoverEdgeId = edge?.id || "";
    canvas.style.cursor = node ? "grab" : edge ? "pointer" : "grab";
  });

  canvas.addEventListener("pointerup", (event) => {
    runtime.drag = null;
    canvas.classList.remove("is-dragging");
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  });

  canvas.addEventListener("pointerleave", () => {
    runtime.hoverNodeId = "";
    runtime.hoverEdgeId = "";
  });

  controls.zoomIn?.addEventListener("click", () => setZoom(view.scale * 1.2));
  controls.zoomOut?.addEventListener("click", () => setZoom(view.scale / 1.2));
  controls.zoomReset?.addEventListener("click", resetView);
  controls.layoutToggle?.addEventListener("click", () => {
    runtime.frozen = !runtime.frozen;
    controls.layoutToggle.textContent = runtime.frozen ? t("knowledge.release") : t("knowledge.freeze");
    controls.layoutToggle.title = runtime.frozen ? t("knowledge.releaseLayout") : t("knowledge.freezeLayout");
    runtime.alpha = runtime.frozen ? runtime.alpha : 0.8;
  });

  const resizeObserver = new ResizeObserver(resizeCanvas);
  resizeObserver.observe(canvas);
  resizeCanvas();
  frame();

  return {
    destroy() {
      runtime.destroyed = true;
      cancelAnimationFrame(runtime.frame);
      resizeObserver.disconnect();
    },
  };
}

function knowledgeGraphNodeColor(node) {
  const type = (node.type || "concept").toLowerCase();
  if (["technology", "system", "product", "module", "api"].includes(type)) {
    return "#60a5fa";
  }
  if (["person", "organization", "team"].includes(type)) {
    return "#34d399";
  }
  if (["file", "location", "document"].includes(type)) {
    return "#f59e0b";
  }
  return "#a78bfa";
}

const KNOWLEDGE_COMMUNITY_COLORS = [
  "#60a5fa",
  "#34d399",
  "#f59e0b",
  "#f472b6",
  "#a78bfa",
  "#2dd4bf",
  "#fb7185",
  "#c084fc",
  "#22c55e",
  "#eab308",
];

function knowledgeGraphCommunityColor(communityId) {
  if (communityId == null || Number.isNaN(Number(communityId))) {
    return "";
  }
  return KNOWLEDGE_COMMUNITY_COLORS[Math.abs(Number(communityId)) % KNOWLEDGE_COMMUNITY_COLORS.length];
}

function knowledgeGraphCommunityStroke(communityId) {
  const color = knowledgeGraphCommunityColor(communityId);
  return color ? `${color}cc` : "rgba(125, 173, 255, 0.9)";
}

function distanceToSegment(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq));
  const x = start.x + t * dx;
  const y = start.y + t * dy;
  return Math.hypot(point.x - x, point.y - y);
}

function renderKnowledgeGraphEvidence(nodes, edges) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const list = document.createElement("div");
  list.className = "graph-evidence-list";
  for (const edge of edges.slice(0, 6)) {
    const row = document.createElement("div");
    row.className = "graph-evidence-item";
    row.dataset.edgeId = edge.id || `${edge.source}:${edge.predicate}:${edge.target}`;
    row.dataset.source = edge.source;
    row.dataset.target = edge.target;

    const title = document.createElement("div");
    title.className = "graph-evidence-title";
    title.textContent = `${nodeMap.get(edge.source)?.label || edge.source} -[${edge.predicate}]-> ${nodeMap.get(edge.target)?.label || edge.target}`;

    const evidence = edge.evidence?.[0];
    const meta = document.createElement("div");
    meta.className = "graph-evidence-meta";
    const metricText = edge.weight ? `weight ${formatInspectorNumber(edge.weight)}` : "";
    meta.textContent = evidence
      ? [evidence.doc_name, evidence.line_start ? `L${evidence.line_start}-${evidence.line_end || evidence.line_start}` : ""].filter(Boolean).join(" · ")
      : "";
    meta.textContent = [meta.textContent, metricText].filter(Boolean).join(" · ");

    const text = document.createElement("div");
    text.className = "graph-evidence-text";
    text.textContent = evidence?.text || "";

    row.append(title, meta, text);
    list.append(row);
  }
  return list;
}

function renderKnowledgeGraphCommunities(communities, nodes) {
  const panel = document.createElement("div");
  panel.className = "graph-community-panel";
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const visibleCommunities = (communities || [])
    .map((community) => {
      const entityCount = (community.entity_ids || []).filter((entityId) => nodeById.has(entityId)).length;
      return { ...community, entityCount };
    })
    .filter((community) => community.entityCount > 0)
    .sort((a, b) => b.entityCount - a.entityCount)
    .slice(0, 6);

  if (!visibleCommunities.length) {
    return panel;
  }

  const title = document.createElement("div");
  title.className = "graph-community-panel-title";
  title.textContent = t("knowledge.communityReports");
  panel.append(title);

  for (const community of visibleCommunities) {
    const report = community.report || {};
    const item = document.createElement("div");
    item.className = "graph-community-item";
    item.dataset.communityId = String(community.community);

    const header = document.createElement("div");
    header.className = "graph-community-header";
    const swatch = document.createElement("span");
    swatch.className = "graph-community-swatch";
    swatch.style.background = knowledgeGraphCommunityColor(community.community);
    const name = document.createElement("span");
    name.className = "graph-community-name";
    name.textContent = community.title || report.title || t("knowledge.communityName").replace("{id}", community.community);
    const count = document.createElement("span");
    count.className = "graph-community-count";
    const childCount = (community.children || []).length;
    const countParts = [
      t("knowledge.graphLevelShort").replace("{level}", community.level || 0),
      t("knowledge.graphMetaEntities").replace("{count}", community.entityCount),
    ];
    if (report.rank != null) {
      countParts.push(t("knowledge.rank").replace("{rank}", formatInspectorNumber(report.rank)));
    }
    if (childCount) {
      countParts.push(t("knowledge.childCount").replace("{count}", childCount));
    } else if (community.parent != null && community.parent >= 0) {
      countParts.push(t("knowledge.parentCommunity").replace("{id}", community.parent));
    }
    count.textContent = countParts.join(" / ");
    header.append(swatch, name, count);

    const summary = document.createElement("div");
    summary.className = "graph-community-summary";
    summary.textContent = report.summary || "";

    item.append(header, summary);
    panel.append(item);
  }
  return panel;
}

function compactGraphLabel(label) {
  const text = String(label || "");
  return text.length > 18 ? `${text.slice(0, 16)}…` : text;
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

    const graphBtn = document.createElement("button");
    graphBtn.className = "doc-graph-btn";
    graphBtn.type = "button";
    graphBtn.textContent = t("knowledge.graphButton");
    graphBtn.title = t("knowledge.viewDocGraph");
    graphBtn.addEventListener("click", () => setKnowledgeGraphDocumentFilter(doc.id, doc.name));

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "doc-delete-btn";
    deleteBtn.textContent = "×";
    deleteBtn.title = t("ui.delete");
    deleteBtn.addEventListener("click", () => deleteDoc(doc.id, doc.name));

    metaSection.append(chunks, graphBtn, deleteBtn);
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

async function setKnowledgeGraphDocumentFilter(docId, docName) {
  state.knowledgeGraphFilterDocId = docId || "";
  state.knowledgeGraphFilterDocName = docName || "";
  state.knowledgeGraphHighlight = null;
  state.knowledgeGraphSelection = null;
  if (state.activeKnowledgeTab === "graph") {
    await loadKnowledgeGraph();
  } else {
    setKnowledgeTab("graph");
  }
}

function openKnowledgeModal() {
  setupKnowledgeWorkbench();
  // Update modal stats from sidebar stats
  elements.modalStatsDocs.textContent = elements.statsDocs.textContent;
  elements.modalStatsChunks.textContent = elements.statsChunks.textContent;

  // 检查知识库是否启用，显示配置提示
  const knowledgeEnabled = state.config?.knowledge?.enabled === true;
  const configHint = document.getElementById("knowledge-config-hint");
  if (configHint) {
    configHint.style.display = knowledgeEnabled ? "none" : "flex";
  }

  elements.knowledgeModal.classList.add("active");
  loadKnowledgeGraph();
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
    renderMarkdown(elements.docViewContent, doc.content || "");

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
    setKnowledgeIndexingState(true, t("knowledge.indexingAddDoc"));
    elements.docSuccess.textContent = t("knowledge.indexingAddDoc");
    const response = await fetch(`${state.knowledgeApiPath}/documents?async_index=true`, {
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

    const result = await response.json();
    elements.docSuccess.textContent = result.job_id ? t("knowledge.uploadAccepted") : t("knowledge.docAdded");
    elements.docNameInput.value = "";
    elements.docCategoryInput.value = "";
    elements.docTagsInput.value = "";
    elements.docContentEditor.value = "";

    await loadKnowledgeStats();
    await loadKnowledgeDocs();
    if (result.job_id) {
      scheduleKnowledgeJobPoll(result.job_id, t("knowledge.indexingAddDoc"));
    } else {
      await loadKnowledgeGraph();
      setKnowledgeIndexingState(false);
    }
  } catch (error) {
    console.error(error);
    elements.docError.textContent = error.message || t("status.failed");
    setKnowledgeIndexingState(false);
  } finally {
    if (!state.activeKnowledgeJobId) {
      setKnowledgeIndexingState(false);
    }
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
    setKnowledgeIndexingState(true, t("knowledge.indexingUploadDoc"));
    elements.docSuccess.textContent = t("knowledge.indexingUploadDoc");
    const response = await fetch(`${state.knowledgeApiPath}/documents/upload?async_index=true`, {
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
    elements.docSuccess.textContent = result.job_id
      ? t("knowledge.uploadAccepted")
      : (t("knowledge.uploadSuccess") || `File "${result.name}" uploaded (${result.size_bytes} bytes)`);

    // Refresh docs list
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
    if (result.job_id) {
      scheduleKnowledgeJobPoll(result.job_id, t("knowledge.indexingUploadDoc"));
    } else {
      await loadKnowledgeGraph();
      setKnowledgeIndexingState(false);
    }
  } catch (error) {
    console.error(error);
    elements.docError.textContent = error.message || t("status.failed");
    setKnowledgeIndexingState(false);
  } finally {
    if (!state.activeKnowledgeJobId) {
      setKnowledgeIndexingState(false);
    }
  }
}

async function uploadTemporaryFile() {
  const fileInput = elements.temporaryFileUpload;
  const file = fileInput?.files?.[0];
  if (!file) {
    return;
  }
  fileInput.value = "";

  if (!state.activeSessionKey) {
    setError(t("msg.noSession"));
    return;
  }

  const formData = new FormData();
  formData.append("file", file);

  try {
    setError("");
    setStatus(t("sessionFiles.uploading"), "idle");
    if (elements.temporaryFileButton) {
      elements.temporaryFileButton.disabled = true;
    }
    const response = await fetch(
      `${state.sessionsPath}/${encodeURIComponent(state.activeSessionKey)}/temporary-files`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.token}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || t("sessionFiles.uploadFailed"));
    }

    const result = await response.json();
    const currentItems = state.sessionFiles.get(state.activeSessionKey) || [];
    state.sessionFiles.set(state.activeSessionKey, [...currentItems, result]);
    renderSessionFiles();
    setStatus(t("status.connected"), "connected");
  } catch (error) {
    console.error(error);
    setError(error.message || t("sessionFiles.uploadFailed"));
  } finally {
    if (elements.temporaryFileButton) {
      elements.temporaryFileButton.disabled = false;
    }
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
    await loadKnowledgeGraph();
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
    setKnowledgeRebuildUi(true);
    setKnowledgeIndexingState(true, t("knowledge.indexingRebuild"));
    const response = await fetch(`${state.knowledgeApiPath}/rebuild-index?type=all&async_index=true`, {
      method: "POST",
      headers: authHeaders(),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error?.message || errorData.error || t("knowledge.rebuildFailed"));
    }

    const result = await response.json();
    if (result.job_id) {
      elements.docSuccess.textContent = t("knowledge.rebuildAccepted");
      scheduleKnowledgeJobPoll(result.job_id, t("knowledge.indexingRebuild"));
      return;
    }

    await loadKnowledgeStats();
    await loadKnowledgeDocs();
    await loadKnowledgeGraph();
  } catch (error) {
    console.error(error);
    setError(error.message || t("status.failed"));
    state.knowledgeRebuilding = false;
    await loadKnowledgeStats();
    await loadKnowledgeGraph();
    setKnowledgeIndexingState(false);
  } finally {
    if (!state.activeKnowledgeJobId) {
      setKnowledgeIndexingState(false);
    }
  }
}

function setKnowledgeStatsPending() {
  const fields = [
    elements.statsDocs,
    elements.statsChunks,
    elements.modalStatsDocs,
    elements.modalStatsChunks,
    elements.modalStatsEntities,
    elements.modalStatsClaims,
    elements.modalStatsRelations,
    elements.modalStatsCommunities,
    elements.modalStatsReports,
  ];
  for (const field of fields) {
    if (field) field.textContent = "-";
  }
}

function renderKnowledgeRebuildPlaceholder() {
  if (elements.knowledgeHealthScore) elements.knowledgeHealthScore.textContent = "0%";
  if (elements.knowledgeHealthBar) elements.knowledgeHealthBar.style.width = "0%";
  if (elements.knowledgeHealthTitle) elements.knowledgeHealthTitle.textContent = t("knowledge.rebuildingTitle");
  if (elements.knowledgeHealthDesc) elements.knowledgeHealthDesc.textContent = t("knowledge.rebuildingDesc");
  if (!elements.knowledgeOverviewInsights) {
    return;
  }
  elements.knowledgeOverviewInsights.textContent = "";
  const insights = [
    [t("knowledge.insightRetrievalIndex"), t("knowledge.rebuildingRetrieval")],
    [t("knowledge.insightSemanticModel"), t("knowledge.rebuildingSemantic")],
    [t("knowledge.insightGraphRagLayer"), t("knowledge.rebuildingGraph")],
  ];
  for (const [title, text] of insights) {
    const item = document.createElement("div");
    item.className = "knowledge-insight-item";
    item.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span>`;
    elements.knowledgeOverviewInsights.append(item);
  }
}

function renderKnowledgeGraphRebuildPlaceholder() {
  if (!elements.knowledgeGraph) {
    return;
  }
  if (state.knowledgeGraphRuntime?.destroy) {
    state.knowledgeGraphRuntime.destroy();
    state.knowledgeGraphRuntime = null;
  }
  elements.knowledgeGraph.textContent = "";
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = t("knowledge.rebuildingGraph");
  elements.knowledgeGraph.append(empty);
  if (elements.knowledgeGraphMeta) {
    elements.knowledgeGraphMeta.textContent = t("knowledge.indexingRebuild");
  }
}

function setKnowledgeRebuildUi(active) {
  state.knowledgeRebuilding = active;
  if (!active) {
    return;
  }
  state.knowledgeStats = null;
  state.knowledgeGraph = null;
  state.knowledgeGraphSelection = null;
  setKnowledgeStatsPending();
  renderKnowledgeOverview();
  renderKnowledgeGraphRebuildPlaceholder();
}

async function queryKnowledge() {
  if (state.knowledgeIndexing) {
    return;
  }
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

    const actions = document.createElement("div");
    actions.className = "query-result-actions";
    const locate = document.createElement("button");
    locate.className = "button button-ghost button-small";
    locate.type = "button";
    locate.textContent = t("knowledge.highlightInGraph");
    locate.addEventListener("click", () => highlightKnowledgeQueryResult(item, result.query));
    actions.append(locate);

    resultItem.append(header, meta, content, debug, actions);
    elements.queryResults.append(resultItem);
  }
}

function highlightKnowledgeQueryResult(item, query) {
  state.knowledgeGraphHighlight = {
    query,
    entities: item.matched_entities || [],
    relations: item.matched_relations || [],
    communities: item.matched_communities || [],
  };
  if (item.doc_id) {
    state.knowledgeGraphFilterDocId = item.doc_id;
    state.knowledgeGraphFilterDocName = item.doc_name || item.doc_id;
  }
  if (state.activeKnowledgeTab === "graph") {
    loadKnowledgeGraph();
  } else {
    setKnowledgeTab("graph");
  }
}

function formatKnowledgeScore(item) {
  if (item.rerank_score != null) {
    return `rerank ${Number(item.rerank_score).toFixed(4)}`;
  }
  if (item.rrf_score != null) {
    return `rrf ${Number(item.rrf_score).toFixed(4)}`;
  }
  if (item.semantic_fusion_score != null) {
    return `graph ${Number(item.semantic_fusion_score).toFixed(4)}`;
  }
  if (item.semantic_score != null) {
    return `semantic ${Number(item.semantic_score).toFixed(3)}`;
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
  if (item.semantic_rank != null) {
    const semantic = item.semantic_score != null
      ? `semantic #${item.semantic_rank} score ${Number(item.semantic_score).toFixed(3)}`
      : `semantic #${item.semantic_rank}`;
    parts.push(semantic);
  }
  if (item.matched_communities?.length) {
    parts.push(`communities: ${item.matched_communities.slice(0, 3).join("; ")}`);
  }
  if (item.matched_entities?.length) {
    parts.push(`entities: ${item.matched_entities.slice(0, 5).join(", ")}`);
  }
  if (item.matched_relations?.length) {
    parts.push(`relations: ${item.matched_relations.slice(0, 3).join("; ")}`);
  }
  if (item.matched_claims?.length) {
    const label = ["global", "drift"].includes(item.method) ? "findings" : "claims";
    parts.push(`${label}: ${item.matched_claims.slice(0, 3).join(" | ")}`);
  }
  return parts.join(" · ");
}

function updateQueryModeHint() {
  if (!elements.queryModeHint || !elements.queryMode) {
    return;
  }
  const hints = {
    hybrid: t("knowledge.queryHintHybrid"),
    dense: t("knowledge.queryHintDense"),
    sparse: t("knowledge.queryHintSparse"),
    semantic: t("knowledge.queryHintSemantic"),
    local: t("knowledge.queryHintLocal"),
    global: t("knowledge.queryHintGlobal"),
    drift: t("knowledge.queryHintDrift"),
  };
  elements.queryModeHint.textContent = hints[elements.queryMode.value] || "";
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
  applyConfigSearch();
  updateConfigDirtyState();
  window.setTimeout(() => elements.configSearch?.focus(), 80);
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
  const tempValue = defaults.temperature !== undefined ? defaults.temperature : 0.1;
  elements.configTemperature.value = tempValue;
  // 更新 Temperature Slider 显示值
  const tempValueDisplay = document.getElementById("temperature-value");
  if (tempValueDisplay) {
    tempValueDisplay.textContent = tempValue;
  }
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
  elements.configKnowledgeGenerateSummary.checked = knowledge.generateSummary || knowledge.generate_summary === true;
  elements.configKnowledgeSemanticExtractionMode.value = knowledge.semanticExtractionMode || knowledge.semantic_extraction_mode || "rule";
  elements.configKnowledgeSemanticLlmMaxTokens.value = knowledge.semanticLlmMaxTokens || knowledge.semantic_llm_max_tokens || 1200;
  elements.configKnowledgeSemanticLlmTimeout.value = knowledge.semanticLlmTimeout || knowledge.semantic_llm_timeout || 30.0;
  if (elements.configKnowledgeGraphRagCommunityAlgorithm) {
    elements.configKnowledgeGraphRagCommunityAlgorithm.value = knowledge.graphragCommunityAlgorithm || knowledge.graphrag_community_algorithm || "greedy";
  }
  if (elements.configKnowledgeGraphRagCommunityLevel) {
    const level = knowledge.graphragCommunityLevel ?? knowledge.graphrag_community_level ?? 0;
    elements.configKnowledgeGraphRagCommunityLevel.value = level;
    state.knowledgeGraphLevel = Number.parseInt(String(level), 10) || 0;
  }
  if (elements.configKnowledgeGraphRagReportLlmEnabled) {
    elements.configKnowledgeGraphRagReportLlmEnabled.checked = knowledge.graphragReportLlmEnabled || knowledge.graphrag_report_llm_enabled === true;
  }
  if (elements.configKnowledgeGraphRagReportMaxTokens) {
    elements.configKnowledgeGraphRagReportMaxTokens.value = knowledge.graphragReportMaxTokens || knowledge.graphrag_report_max_tokens || 1200;
  }
  if (elements.configKnowledgeGraphRagEntitySummaryEnabled) {
    elements.configKnowledgeGraphRagEntitySummaryEnabled.checked = knowledge.graphragEntitySummaryEnabled ?? knowledge.graphrag_entity_summary_enabled ?? true;
  }

  // Embedding config (nested in agents.defaults)
  const embedding = defaults.embedding || {};
  elements.configEmbeddingProvider.value = embedding.provider || "local";
  elements.configEmbeddingModelName.value = embedding.modelName || embedding.model_name || "all-MiniLM-L6-v2";
  elements.configEmbeddingApiKey.value = embedding.apiKey || embedding.api_key || "";
  elements.configEmbeddingApiBase.value = embedding.apiBase || embedding.api_base || "";

  // Providers - 根据当前provider选择加载对应的配置
  const providers = config.providers || {};
  const rawProviderName = defaults.provider || "auto";
  const currentProviderName = rawProviderName === "auto" || LLM_PROVIDERS.includes(rawProviderName)
    ? rawProviderName
    : "auto";
  elements.configProvider.value = currentProviderName;

  // Auto mode keeps model-based routing; show DeepSeek credentials by default.
  const displayProvider = currentProviderName === "auto" ? "deepseek" : currentProviderName;
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

  const mcpServers = tools.mcpServers || tools.mcp_servers || {};
  if (elements.configMcpServers) {
    elements.configMcpServers.value = Object.keys(mcpServers).length
      ? JSON.stringify(mcpServers, null, 2)
      : "";
  }

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
  markConfigClean();
  applyConfigSearch();
}

function loadProviderConfig(providers, providerName) {
  const provider = providers[providerName] || {};
  // API返回的是camelCase格式 (apiKey, apiBase)
  elements.configApiKey.value = provider.apiKey || provider.api_key || "";
  elements.configApiBase.value = provider.apiBase || provider.api_base || "";
}

function getConfigGroups() {
  return Array.from(elements.modal.querySelectorAll(".config-group"));
}

function getConfigFields() {
  return Array.from(elements.modal.querySelectorAll("input, select, textarea"))
    .filter((field) => field.id && field.id.startsWith("config-") && field.id !== "config-search");
}

function getConfigFieldValue(field) {
  if (field.type === "checkbox") {
    return field.checked ? "1" : "0";
  }
  return field.value;
}

function captureConfigSnapshot() {
  const snapshot = {};
  getConfigFields().forEach((field) => {
    snapshot[field.id] = getConfigFieldValue(field);
  });
  return snapshot;
}

function getConfigGroupTitle(group) {
  const title = group.querySelector(".config-group-title");
  const label = title?.querySelector("[data-i18n]") || title;
  return label?.textContent?.trim() || "";
}

function markConfigClean() {
  state.configBaseline = captureConfigSnapshot();
  updateConfigDirtyState();
}

function getChangedConfigFields() {
  const baseline = state.configBaseline || {};
  return getConfigFields().filter((field) => baseline[field.id] !== getConfigFieldValue(field));
}

function updateConfigDirtyState() {
  const changedFields = getChangedConfigFields();
  const changedIds = new Set(changedFields.map((field) => field.id));
  const dirtyGroups = new Set();

  getConfigFields().forEach((field) => {
    const isDirty = changedIds.has(field.id);
    field.closest(".config-field")?.classList.toggle("dirty", isDirty);
    if (isDirty) {
      const groupTitle = field.closest(".config-group")?.querySelector(".config-group-title");
      if (groupTitle) {
        dirtyGroups.add(getConfigGroupTitle(field.closest(".config-group")));
      }
    }
  });

  getConfigGroups().forEach((group) => {
    const title = group.querySelector(".config-group-title");
    title?.classList.toggle("dirty", dirtyGroups.has(getConfigGroupTitle(group)));
  });

  if (elements.saveConfigButton) {
    elements.saveConfigButton.disabled = changedFields.length === 0;
  }
  if (elements.resetConfigButton) {
    elements.resetConfigButton.disabled = changedFields.length === 0;
  }
  if (elements.configDirtySummary) {
    if (!changedFields.length) {
      elements.configDirtySummary.textContent = t("settings.noChanges");
    } else {
      const groupText = Array.from(dirtyGroups).filter(Boolean).slice(0, 3).join(", ");
      elements.configDirtySummary.textContent = `${t("settings.unsavedChanges")} ${changedFields.length}${groupText ? ` · ${groupText}` : ""}`;
    }
  }
}

function applyConfigSearch() {
  const query = (elements.configSearch?.value || "").trim().toLowerCase();
  let visibleGroups = 0;

  getConfigGroups().forEach((group) => {
    const title = group.querySelector(".config-group-title");
    const groupText = getConfigGroupTitle(group).toLowerCase();
    const fields = Array.from(group.querySelectorAll(".config-field"));
    let visibleFields = 0;

    fields.forEach((field) => {
      const fieldText = [
        field.textContent,
        field.querySelector("input, select, textarea")?.value,
        field.querySelector("input, select, textarea")?.placeholder,
        field.querySelector(".config-help")?.getAttribute("data-help"),
      ].filter(Boolean).join(" ").toLowerCase();
      const isVisible = !query || groupText.includes(query) || fieldText.includes(query);
      field.hidden = !isVisible;
      if (isVisible) {
        visibleFields += 1;
      }
    });

    const groupVisible = !query || visibleFields > 0 || groupText.includes(query);
    group.hidden = !groupVisible;
    if (groupVisible) {
      visibleGroups += 1;
      if (query && title) {
        setConfigGroupExpanded(title, true);
      }
    }
  });

  if (elements.configEmptySearch) {
    elements.configEmptySearch.hidden = visibleGroups > 0;
  }
}

function jumpToConfigGroup(groupName) {
  if (elements.configSearch?.value) {
    elements.configSearch.value = "";
    applyConfigSearch();
  }
  const title = elements.modal.querySelector(`.config-group-title[data-group="${groupName}"]`);
  if (!title) {
    return;
  }
  setConfigGroupExpanded(title, true);
  elements.configQuickNav?.querySelectorAll(".config-nav-chip").forEach((button) => {
    button.classList.toggle("active", button.dataset.configJump === groupName);
  });
  title.closest(".config-group")?.scrollIntoView({ block: "start", behavior: "smooth" });
  title.focus({ preventScroll: true });
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

function setConfigGroupExpanded(groupTitle, expanded) {
  const groupContent = groupTitle.nextElementSibling;
  if (!groupContent) {
    return;
  }
  groupContent.classList.toggle("collapsed", !expanded);
  groupTitle.classList.toggle("collapsed", !expanded);
  groupTitle.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function syncConfigGroupStates() {
  document.querySelectorAll(".config-group-title.clickable").forEach((title) => {
    const groupContent = title.nextElementSibling;
    if (!groupContent) {
      return;
    }
    setConfigGroupExpanded(title, !groupContent.classList.contains("collapsed"));
  });
}

// ========== 实时验证系统 ==========

function setupValidation() {
  // Model 验证 - 非空
  if (elements.configModel) {
    elements.configModel.addEventListener("input", () => {
      validateField(elements.configModel, (val) => val.trim().length > 0, "modelEmpty");
    });
  }

  // Timezone 验证 - 格式
  if (elements.configTimezone) {
    elements.configTimezone.addEventListener("input", () => {
      validateField(elements.configTimezone, validateTimezone, "timezoneError");
    });
  }

  // Gateway Port 验证 - 范围
  if (elements.configGatewayPort) {
    elements.configGatewayPort.addEventListener("input", () => {
      validateField(elements.configGatewayPort, validatePortRange, "portRange");
    });
  }

  if (elements.configMcpServers) {
    elements.configMcpServers.addEventListener("input", () => {
      const val = elements.configMcpServers.value.trim();
      if (val === "") {
        setFieldState(elements.configMcpServers, "neutral");
        return;
      }
      validateField(elements.configMcpServers, validateJsonObject, "jsonObjectError");
    });
  }

  // API Base URL 验证
  if (elements.configApiBase) {
    elements.configApiBase.addEventListener("input", () => {
      const val = elements.configApiBase.value.trim();
      if (val === "") {
        setFieldState(elements.configApiBase, "neutral");
      } else {
        validateField(elements.configApiBase, validateUrl, "urlError");
      }
    });
  }

  // Embedding API Base URL 验证
  const embeddingApiBase = document.getElementById("config-embedding-api-base");
  if (embeddingApiBase) {
    embeddingApiBase.addEventListener("input", () => {
      const val = embeddingApiBase.value.trim();
      if (val === "") {
        setFieldState(embeddingApiBase, "neutral");
      } else {
        validateField(embeddingApiBase, validateUrl, "urlError");
      }
    });
  }

  // Rerank API Base URL 验证
  const rerankApiBase = document.getElementById("config-knowledge-rerank-api-base");
  if (rerankApiBase) {
    rerankApiBase.addEventListener("input", () => {
      const val = rerankApiBase.value.trim();
      if (val === "") {
        setFieldState(rerankApiBase, "neutral");
      } else {
        validateField(rerankApiBase, validateUrl, "urlError");
      }
    });
  }
}

function validateField(input, validator, errorKey) {
  const value = input.value.trim();
  if (value === "" && errorKey !== "modelEmpty") {
    setFieldState(input, "neutral");
    return true;
  }
  const isValid = validator(value);
  if (isValid) {
    setFieldState(input, "success");
  } else {
    setFieldState(input, "error", errorKey);
  }
  return isValid;
}

function setFieldState(input, state, errorKey = null) {
  // 清除之前的状态
  input.classList.remove("error", "success");
  // 移除验证提示
  const parent = input.closest(".config-field") || input.closest(".config-sensitive-group");
  if (parent) {
    const existingMsg = parent.querySelector(".config-validation-msg");
    if (existingMsg) {
      existingMsg.remove();
    }
  }

  if (state === "neutral") {
    return;
  }

  input.classList.add(state);

  // 添加验证提示
  if (parent && (errorKey || state === "success")) {
    const msgDiv = document.createElement("div");
    msgDiv.className = `config-validation-msg ${state}`;
    if (state === "success") {
      msgDiv.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg><span>${t("settings.validation.valid")}</span>`;
    } else if (errorKey) {
      msgDiv.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg><span>${t(`settings.validation.${errorKey}`)}</span>`;
    }
    parent.appendChild(msgDiv);
  }
}

function validateTimezone(value) {
  // 简单验证：格式应该是 Area/City 或 Area/SubArea/City
  if (!value) return false;
  const parts = value.split("/");
  if (parts.length < 2) return false;
  // 检查常见时区前缀
  const validPrefixes = ["Africa", "America", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific", "UTC", "GMT"];
  return validPrefixes.some(p => parts[0] === p) || parts[0] === "Etc";
}

function validateUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function validatePortRange(value) {
  const port = parseInt(value, 10);
  return port >= 1 && port <= 65535;
}

function validateJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

async function saveConfig() {
  elements.configError.textContent = "";
  elements.configSuccess.textContent = "";
  elements.saveConfigButton.disabled = true;
  elements.saveConfigButton.classList.add("loading");

  // Helper: only include non-empty values
  const getValue = (el, type = "string") => {
    let val = type === "number" ? (el.value ? parseFloat(el.value) || parseInt(el.value) : null) : el.value.trim();
    if (type === "string" && val === "") val = null;
    if (type === "number" && (val === null || val === "" || isNaN(val))) val = null;
    return val;
  };

  const parseJsonObject = (el, fallback = {}) => {
    if (!el || el.value.trim() === "") {
      return fallback;
    }
    const parsed = JSON.parse(el.value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(t("settings.validation.jsonObjectError"));
    }
    return parsed;
  };

  let mcpServers = {};
  try {
    mcpServers = parseJsonObject(elements.configMcpServers, {});
  } catch (error) {
    elements.configError.textContent = error.message || t("settings.validation.jsonObjectError");
    if (elements.configMcpServers) {
      setFieldState(elements.configMcpServers, "error", "jsonObjectError");
    }
    updateConfigDirtyState();
    elements.saveConfigButton.classList.remove("loading");
    return;
  }

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
          api_key: (() => { const v = getValue(elements.configEmbeddingApiKey); return v === null ? "" : v; })(),  // api_key schema requires string
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
      generate_summary: elements.configKnowledgeGenerateSummary.checked,
      semantic_extraction_mode: getValue(elements.configKnowledgeSemanticExtractionMode),
      semantic_llm_max_tokens: getValue(elements.configKnowledgeSemanticLlmMaxTokens, "number"),
      semantic_llm_timeout: getValue(elements.configKnowledgeSemanticLlmTimeout, "number"),
      graphrag_community_algorithm: getValue(elements.configKnowledgeGraphRagCommunityAlgorithm),
      graphrag_community_level: getValue(elements.configKnowledgeGraphRagCommunityLevel, "number"),
      graphrag_report_llm_enabled: elements.configKnowledgeGraphRagReportLlmEnabled?.checked === true,
      graphrag_report_max_tokens: getValue(elements.configKnowledgeGraphRagReportMaxTokens, "number"),
      graphrag_entity_summary_enabled: elements.configKnowledgeGraphRagEntitySummaryEnabled?.checked !== false,
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
      mcp_servers: mcpServers,
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
  const providerName = LLM_PROVIDERS.includes(elements.configProviderSelect.value)
    ? elements.configProviderSelect.value
    : "deepseek";
  const apiKeyValue = getValue(elements.configApiKey);
  payload.providers[providerName] = {
    api_key: apiKeyValue === null ? "" : apiKeyValue,  // api_key schema requires string, not None
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
    markConfigClean();
    await loadSystemStatus();
  } catch (error) {
    elements.configError.textContent = error.message || t("settings.saveFailed");
    updateConfigDirtyState();
  } finally {
    elements.saveConfigButton.classList.remove("loading");
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
  const item = state.sessionItems.find((entry) => entry.key === sessionKey);
  if (item && !item.title && message.role === "user") {
    item.title = compactSessionTitleFromMessages(bucket);
  }
  if (sessionKey === state.activeSessionKey) {
    updateActiveChatTitle();
    renderSessions();
    renderMessages(false);
  }
}

function upsertTaskProgressMessage(sessionKey, message) {
  const bucket = ensureMessageBucket(sessionKey);
  const data = taskProgressPayload(message) || {};
  const progress = data.progress || {};
  const planId = data.plan_id || progress.plan_id || message._task_plan_id || "";
  let existing = null;
  if (planId) {
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      if (bucket[index]._task_event && bucket[index]._task_plan_id === planId) {
        existing = bucket[index];
        break;
      }
    }
  }

  if (existing) {
    Object.assign(existing, message, {
      timestamp: new Date().toISOString(),
      message_id: existing.message_id || message.message_id,
    });
  } else {
    bucket.push(message);
  }

  if (sessionKey === state.activeSessionKey) {
    updateActiveChatTitle();
    renderSessions();
    renderMessages(false);
  }
}

function upsertStreamMessage(chatId, messageId, deltaText, isReasoning = false) {
  const sessionKey = sessionKeyForChat(chatId);
  const bucket = ensureMessageBucket(sessionKey);
  let streamState = state.streamBuffers.get(messageId);
  const isNewMessage = !streamState;
  const hadContentBefore = Boolean((streamState?.entry?.content || "").trim());

  if (isNewMessage) {
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
  }

  if (isReasoning) {
    streamState.entry.reasoning_content += deltaText;
  } else {
    streamState.entry.content += deltaText;
  }

  if (sessionKey === state.activeSessionKey) {
    if (isNewMessage || (!hadContentBefore && !isReasoning && deltaText.trim())) {
      // Render the list when a new visible answer starts so the streaming node is placed.
      renderMessages(false);
    } else {
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
            use_persistent_rag: elements.persistentRagToggle?.checked !== false,
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
          const taskProgress = payload._task_progress || null;
          const planId = taskProgress?.plan_id || taskProgress?.progress?.plan_id || "";
          if (payload._task_event) {
            upsertTaskProgressMessage(sessionKeyForChat(payload.chat_id), {
              role: "progress",
              content: payload.text || "",
              timestamp: new Date().toISOString(),
              message_id: payload.message_id || (planId ? `task-${planId}` : crypto.randomUUID()),
              _task_event: true,
              _task_progress: taskProgress,
              _task_plan_id: planId,
              _tool_name: "task",
            });
            return;
          }
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

      if (payload.event === "browser_frame" || payload.event === "browser_snapshot") {
        updateBrowserFrame(payload);
        return;
      }

      if (payload.event === "stream_end") {
        if (payload.message_id) {
          const streamState = state.streamBuffers.get(payload.message_id);
          if (streamState?.entry) {
            streamState.entry._stream_resuming = payload.resuming === true;
          }
          state.streamBuffers.delete(payload.message_id);
          if (payload.resuming !== true && streamState?.sessionKey === state.activeSessionKey) {
            renderMessages(false);
          }
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
    use_persistent_rag: elements.persistentRagToggle?.checked !== false,
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

  elements.temporaryFileButton?.addEventListener("click", () => {
    if (!state.activeSessionKey) {
      setError(t("msg.noSession"));
      return;
    }
    elements.temporaryFileUpload?.click();
  });

  elements.temporaryFileUpload?.addEventListener("change", async () => {
    await uploadTemporaryFile();
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

  // 工具配置提示 - 前往设置按钮
  const gotoToolsConfigBtn = document.getElementById("goto-tools-config");
  if (gotoToolsConfigBtn) {
    gotoToolsConfigBtn.addEventListener("click", () => {
      closeToolsModal();
      openModal();
      // 展开Tools配置组
      const toolsGroupTitle = document.querySelector('[data-group="tools"]');
      if (toolsGroupTitle) {
        setConfigGroupExpanded(toolsGroupTitle, true);
      }
    });
  }

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
  if (elements.browserPanelToggle) {
    elements.browserPanelToggle.addEventListener("click", () => {
      setBrowserPanelCollapsed(!state.browserPanelCollapsed);
    });
  }

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

  // 知识库配置提示 - 前往设置按钮
  const gotoKnowledgeConfigBtn = document.getElementById("goto-knowledge-config");
  if (gotoKnowledgeConfigBtn) {
    gotoKnowledgeConfigBtn.addEventListener("click", () => {
      closeKnowledgeModal();
      openModal();
      // 展开Knowledge配置组
      const knowledgeGroupTitle = document.querySelector('[data-group="knowledge"]');
      if (knowledgeGroupTitle) {
        setConfigGroupExpanded(knowledgeGroupTitle, true);
      }
    });
  }

  // Knowledge panel events
  elements.refreshDocsButton.addEventListener("click", async () => {
    await loadKnowledgeStats();
    await loadKnowledgeDocs();
    await loadKnowledgeGraph();
  });
  if (elements.refreshGraphButton) {
    elements.refreshGraphButton.addEventListener("click", loadKnowledgeGraph);
  }
  elements.rebuildIndexButton.addEventListener("click", rebuildKnowledgeIndex);
  elements.addDocButton.addEventListener("click", openDocModal);
  elements.uploadDocButton.addEventListener("click", () => {
    elements.docFileUpload.click();
  });
  elements.docFileUpload.addEventListener("change", uploadDoc);
  elements.queryButton.addEventListener("click", queryKnowledge);
  elements.queryMode.addEventListener("change", updateQueryModeHint);
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
      if (state.helpOverlay) {
        closeHelpOverlay();
        return;
      }
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
      if (event.shiftKey && (event.key === "/" || event.key === "?")) {
        event.preventDefault();
        showPageHelp();
        return;
      }

      if (event.key === "/" || event.key === "?") {
        event.preventDefault();
        showShortcutHelp();
        return;
      }
    }
  });

  // 配置组折叠
  syncConfigGroupStates();
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

  if (elements.configSearch) {
    elements.configSearch.addEventListener("input", applyConfigSearch);
  }
  if (elements.configExpandAll) {
    elements.configExpandAll.addEventListener("click", () => {
      elements.modal.querySelectorAll(".config-group-title.clickable").forEach((title) => {
        setConfigGroupExpanded(title, true);
      });
    });
  }
  if (elements.configCollapseAll) {
    elements.configCollapseAll.addEventListener("click", () => {
      elements.modal.querySelectorAll(".config-group-title.clickable").forEach((title) => {
        setConfigGroupExpanded(title, false);
      });
    });
  }
  if (elements.configQuickNav) {
    elements.configQuickNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-config-jump]");
      if (!button) {
        return;
      }
      jumpToConfigGroup(button.dataset.configJump);
    });
  }
  if (elements.resetConfigButton) {
    elements.resetConfigButton.addEventListener("click", () => {
      if (!state.config) {
        return;
      }
      populateConfigForm(state.config);
      elements.configError.textContent = "";
      elements.configSuccess.textContent = "";
    });
  }
  getConfigFields().forEach((field) => {
    field.addEventListener("input", updateConfigDirtyState);
    field.addEventListener("change", updateConfigDirtyState);
  });

  // Provider select change - 更新Provider配置区域
  elements.configProviderSelect.addEventListener("change", () => {
    const providers = state.config?.providers || {};
    loadProviderConfig(providers, elements.configProviderSelect.value);
    updateConfigDirtyState();
  });

  // Agent Provider select change - 同步更新Provider配置区域的选择
  elements.configProvider.addEventListener("change", () => {
    const selectedProvider = elements.configProvider.value;
    // Auto mode keeps model-based routing; show DeepSeek credentials by default.
    const displayProvider = selectedProvider === "auto" ? "deepseek" : selectedProvider;
    elements.configProviderSelect.value = displayProvider;
    const providers = state.config?.providers || {};
    loadProviderConfig(providers, displayProvider);
    updateConfigDirtyState();
  });

  elements.saveConfigButton.addEventListener("click", async () => {
    await saveConfig();
  });

  // 语言切换按钮
  renderSidebarActionIcons();
  updateLanguageButton();
  elements.languageToggle.addEventListener("click", () => {
    const newLang = getLanguage() === "zh" ? "en" : "zh";
    setLanguage(newLang);
    updateLanguageButton();
    renderDynamicContent();
  });

  // 主题切换按钮
  elements.themeToggle.addEventListener("click", toggleTheme);
  if (elements.helpTourButton) {
    elements.helpTourButton.addEventListener("click", () => startFeatureTour(0));
  }

  // 监听语言变化事件（来自 i18n.js）
  window.addEventListener("languagechange", () => {
    renderSidebarActionIcons();
    updateLanguageButton();
    renderDynamicContent();
    updateConfigDirtyState();
    applyConfigSearch();
    // 重新渲染usage显示
    if (state.lastUsage) {
      updateUsageDisplay(state.lastUsage);
    }
  });

  // Temperature Slider 值显示
  if (elements.configTemperature) {
    elements.configTemperature.addEventListener("input", (e) => {
      const valueEl = document.getElementById("temperature-value");
      if (valueEl) {
        valueEl.textContent = e.target.value;
      }
    });
  }

  // 敏感字段显示/隐藏按钮
  document.querySelectorAll(".config-sensitive-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const input = document.getElementById(targetId);
      const eyeIcon = btn.querySelector(".eye-icon");
      const eyeOffIcon = btn.querySelector(".eye-off-icon");
      if (input && eyeIcon && eyeOffIcon) {
        if (input.type === "password") {
          input.type = "text";
          eyeIcon.style.display = "none";
          eyeOffIcon.style.display = "block";
        } else {
          input.type = "password";
          eyeIcon.style.display = "block";
          eyeOffIcon.style.display = "none";
        }
      }
    });
  });

  // 实时验证逻辑
  setupValidation();
}

function updateLanguageButton() {
  const lang = getLanguage();
  elements.languageToggle.textContent = lang === "zh" ? "EN" : "中文";
  elements.languageToggle.setAttribute("aria-label", t("ui.switchLanguage"));
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
    updateActiveChatTitle();
  } else {
    updateActiveChatTitle();
  }
}

// 快捷键帮助
const helpTargets = [
  { selector: ".sidebar", title: "tour.sidebar.title", desc: "tour.sidebar.desc" },
  { selector: "#new-chat-button", title: "tour.newChat.title", desc: "tour.newChat.desc" },
  { selector: "#session-list", title: "tour.sessions.title", desc: "tour.sessions.desc" },
  { selector: "#system-status", title: "tour.status.title", desc: "tour.status.desc" },
  { selector: ".chat-panel", title: "tour.chat.title", desc: "tour.chat.desc" },
  { selector: "#message-list", title: "tour.messages.title", desc: "tour.messages.desc" },
  { selector: "#composer-form", title: "tour.composer.title", desc: "tour.composer.desc" },
  { selector: "#tools-toggle", title: "tour.tools.title", desc: "tour.tools.desc" },
  { selector: "#knowledge-toggle", title: "tour.knowledge.title", desc: "tour.knowledge.desc" },
  { selector: "#skills-toggle", title: "tour.skills.title", desc: "tour.skills.desc" },
  { selector: "#workspace-toggle", title: "tour.workspace.title", desc: "tour.workspace.desc" },
  { selector: ".settings-bar", title: "tour.settings.title", desc: "tour.settings.desc" },
];

function getVisibleHelpTargets() {
  return helpTargets
    .map((item) => ({ ...item, element: document.querySelector(item.selector) }))
    .filter((item) => {
      if (!item.element) {
        return false;
      }
      const rect = item.element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
}

function clamp(value, min, max) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function closeHelpOverlay() {
  if (state.helpOverlay) {
    if (state.helpOverlayCleanup) {
      state.helpOverlayCleanup();
      state.helpOverlayCleanup = null;
    }
    state.helpOverlay.remove();
    state.helpOverlay = null;
  }
}

function createHelpOverlay(mode) {
  closeHelpOverlay();
  const overlay = document.createElement("div");
  overlay.className = `help-overlay help-overlay-${mode}`;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  document.body.appendChild(overlay);
  state.helpOverlay = overlay;
  return overlay;
}

function registerHelpOverlayRefresh(render) {
  const refresh = () => {
    if (!state.helpOverlay) {
      return;
    }
    window.requestAnimationFrame(render);
  };
  window.addEventListener("resize", refresh);
  window.addEventListener("scroll", refresh, true);
  state.helpOverlayCleanup = () => {
    window.removeEventListener("resize", refresh);
    window.removeEventListener("scroll", refresh, true);
  };
}

function renderPageHelp() {
  const overlay = state.helpOverlay;
  if (!overlay) {
    return;
  }
  const targets = getVisibleHelpTargets();
  overlay.innerHTML = `
    <div class="help-backdrop"></div>
    <div class="help-bar">
      <div>
        <h2>${escapeHtml(t("tour.pageHelp.title"))}</h2>
        <p>${escapeHtml(t("tour.pageHelp.subtitle"))}</p>
      </div>
      <div class="help-actions">
        <button class="button button-primary button-small" type="button" data-help-action="start-tour">${escapeHtml(t("tour.start"))}</button>
        <button class="button button-ghost button-small" type="button" data-help-action="close">${escapeHtml(t("ui.close"))}</button>
      </div>
    </div>
    <div class="help-items"></div>
  `;

  const items = overlay.querySelector(".help-items");
  targets.forEach((target, index) => {
    const rect = target.element.getBoundingClientRect();
    const box = document.createElement("div");
    box.className = "help-target-box";
    box.style.left = `${Math.max(8, rect.left - 4)}px`;
    box.style.top = `${Math.max(8, rect.top - 4)}px`;
    box.style.width = `${rect.width + 8}px`;
    box.style.height = `${rect.height + 8}px`;
    items.appendChild(box);

    const note = document.createElement("article");
    note.className = "help-note";
    note.innerHTML = `
      <span class="help-note-index">${index + 1}</span>
      <h3>${escapeHtml(t(target.title))}</h3>
      <p>${escapeHtml(t(target.desc))}</p>
    `;

    const noteWidth = 240;
    const left = clamp(rect.left, 12, window.innerWidth - noteWidth - 12);
    const top = rect.top + rect.height + 10 <= window.innerHeight - 90
      ? rect.top + rect.height + 10
      : Math.max(12, rect.top - 102);
    note.style.left = `${left}px`;
    note.style.top = `${top}px`;
    items.appendChild(note);
  });

  overlay.querySelector('[data-help-action="close"]').addEventListener("click", closeHelpOverlay);
  overlay.querySelector('[data-help-action="start-tour"]').addEventListener("click", () => startFeatureTour(0));
}

function showPageHelp() {
  createHelpOverlay("map");
  renderPageHelp();
  registerHelpOverlayRefresh(renderPageHelp);
}

function placeTourCard(card, rect) {
  const gap = 16;
  const width = Math.min(360, window.innerWidth - 24);
  card.style.width = `${width}px`;

  let left = rect.right + gap;
  if (left + width > window.innerWidth - 12) {
    left = rect.left - width - gap;
  }
  if (left < 12) {
    left = clamp(rect.left, 12, window.innerWidth - width - 12);
  }

  let top = rect.top;
  if (top + 230 > window.innerHeight - 12) {
    top = window.innerHeight - 242;
  }
  top = Math.max(12, top);

  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
}

function renderFeatureTour() {
  const overlay = state.helpOverlay;
  if (!overlay) {
    return;
  }

  const targets = getVisibleHelpTargets();
  if (!targets.length) {
    closeHelpOverlay();
    return;
  }

  state.activeTourIndex = clamp(state.activeTourIndex, 0, targets.length - 1);
  const target = targets[state.activeTourIndex];
  const rect = target.element.getBoundingClientRect();

  overlay.innerHTML = `
    <div class="help-backdrop"></div>
    <div class="tour-spotlight"></div>
    <article class="tour-card">
      <div class="tour-step">${escapeHtml(t("tour.step"))} ${state.activeTourIndex + 1} / ${targets.length}</div>
      <h2>${escapeHtml(t(target.title))}</h2>
      <p>${escapeHtml(t(target.desc))}</p>
      <div class="tour-actions">
        <button class="button button-ghost button-small" type="button" data-tour-action="close">${escapeHtml(t("tour.skip"))}</button>
        <button class="button button-small" type="button" data-tour-action="back" ${state.activeTourIndex === 0 ? "disabled" : ""}>${escapeHtml(t("tour.back"))}</button>
        <button class="button button-primary button-small" type="button" data-tour-action="next">${escapeHtml(state.activeTourIndex === targets.length - 1 ? t("tour.done") : t("tour.next"))}</button>
      </div>
    </article>
  `;

  const spotlight = overlay.querySelector(".tour-spotlight");
  spotlight.style.left = `${Math.max(8, rect.left - 6)}px`;
  spotlight.style.top = `${Math.max(8, rect.top - 6)}px`;
  spotlight.style.width = `${rect.width + 12}px`;
  spotlight.style.height = `${rect.height + 12}px`;

  placeTourCard(overlay.querySelector(".tour-card"), rect);

  overlay.querySelector('[data-tour-action="close"]').addEventListener("click", closeHelpOverlay);
  overlay.querySelector('[data-tour-action="back"]').addEventListener("click", () => {
    state.activeTourIndex -= 1;
    renderFeatureTour();
  });
  overlay.querySelector('[data-tour-action="next"]').addEventListener("click", () => {
    if (state.activeTourIndex >= targets.length - 1) {
      closeHelpOverlay();
      return;
    }
    state.activeTourIndex += 1;
    const next = targets[state.activeTourIndex];
    next.element.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    window.setTimeout(renderFeatureTour, 180);
  });
}

function startFeatureTour(index = 0) {
  const targets = getVisibleHelpTargets();
  if (!targets.length) {
    return;
  }
  state.activeTourIndex = clamp(index, 0, targets.length - 1);
  targets[state.activeTourIndex].element.scrollIntoView({ block: "center", inline: "center" });
  createHelpOverlay("tour");
  renderFeatureTour();
  registerHelpOverlayRefresh(renderFeatureTour);
}

function showShortcutHelp() {
  const shortcuts = [
    { key: "Ctrl+N", desc: t("shortcuts.newChat") },
    { key: "Ctrl+L", desc: t("shortcuts.clearSession") },
    { key: "Ctrl+S", desc: t("shortcuts.saveEdit") },
    { key: "Ctrl+/", desc: t("shortcuts.showHelp") },
    { key: "Ctrl+Shift+/", desc: t("shortcuts.showPageHelp") },
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
    await loadKnowledgeGraph();
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
        <div class="init-loading-text">${t("ui.initializing")}</div>
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
