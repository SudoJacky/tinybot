const translations = {
  zh: {
    // 品牌和标题
    "brand.title": "Tinybot",
    "brand.subtitle": "Minimal Web UI",
    "ui.newChat": "新建会话",
    "ui.refresh": "刷新",
    "ui.sessions": "会话",
    "ui.systemStatus": "系统状态",
    "ui.provider": "Provider",
    "ui.model": "Model",
    "ui.websocket": "WebSocket",
    "ui.currentSession": "Current Session",
    "ui.notConnected": "未连接",
    "ui.clear": "清空",
    "ui.enterMessage": "输入消息",
    "ui.inputPlaceholder": "输入内容后按 Enter 发送，Shift+Enter 换行",
    "ui.send": "发送",
    "ui.wsStreaming": "WebSocket 实时流式输出",
    "ui.tools": "可用工具",
    "ui.skills": "可用技能",
    "ui.workspace": "Workspace",
    "ui.reload": "重新加载",
    "ui.save": "保存",
    "ui.fileNotSelected": "未选择文件",
    "ui.filePlaceholder": "选择一个工作区 Markdown 文件进行编辑",
    "ui.settings": "设置",
    "ui.language": "语言",
    "ui.lastUpdate": "最后更新",
    "ui.fileNotCreated": "文件尚未创建，保存后将写入工作区",
    "ui.updatedAt": "更新于",
    "ui.noTime": "暂无时间",
    "ui.deleteSession": "删除会话",
    "ui.confirmDelete": "确定删除会话",

    // 状态
    "status.connecting": "连接准备中",
    "status.connected": "已连接",
    "status.disconnected": "连接已断开",
    "status.failed": "连接失败",
    "status.serverError": "服务端错误",
    "status.initFailed": "初始化失败",
    "status.init": "初始化中",
    "status.loaded": "已加载",
    "status.loading": "加载中",
    "status.saving": "保存中",
    "status.saved": "已保存",
    "status.cleared": "已清空",
    "status.editing": "编辑中",
    "status.conflict": "冲突",
    "status.saveFailed": "保存失败",
    "status.loadFailed": "加载失败",
    "status.notConfigured": "未配置",
    "status.running": "运行中",
    "status.stopped": "已停止",
    "status.available": "可用",
    "status.always": "始终",
    "status.unavailable": "不可用",
    "status.creatingSession": "创建会话中...",
    "status.externalUpdate": "外部更新",

    // 消息
    "msg.noSession": "先创建或选择一个会话。",
    "msg.noMessages": "当前会话还没有消息。",
    "msg.noSessions": "还没有会话。",
    "msg.noTools": "没有可用工具。",
    "msg.noSkills": "没有可用技能。",
    "msg.noDescription": "无描述",
    "msg.versionConflict": "文件已被其他操作更新，请重新加载后再保存。",
    "msg.externalFileUpdate": "当前文件已在其他位置更新，你有未保存的改动。",
    "msg.websocketNotConnected": "websocket is not connected",

    // 设置弹窗
    "settings.title": "设置",
    "settings.agent": "Agent 配置",
    "settings.agent.workspace": "Workspace",
    "settings.agent.workspacePlaceholder": "工作区路径",
    "settings.agent.model": "Model",
    "settings.agent.modelPlaceholder": "模型名称",
    "settings.agent.provider": "Provider",
    "settings.agent.providerAuto": "auto (自动检测)",
    "settings.agent.temperature": "Temperature",
    "settings.agent.temperaturePlaceholder": "0.0 - 2.0",
    "settings.agent.maxTokens": "Max Tokens",
    "settings.agent.maxTokensPlaceholder": "最大输出长度",
    "settings.agent.contextWindow": "Context Window",
    "settings.agent.contextWindowPlaceholder": "上下文窗口大小",
    "settings.agent.maxToolIterations": "Max Tool Iterations",
    "settings.agent.maxToolIterationsPlaceholder": "最大工具调用次数",
    "settings.agent.reasoningEffort": "Reasoning Effort",
    "settings.agent.reasoningEffortDefault": "默认",
    "settings.agent.timezone": "Timezone",
    "settings.agent.timezonePlaceholder": "如 Asia/Shanghai",
    "settings.agent.vectorStore": "启用向量存储",

    "settings.provider": "Provider 配置",
    "settings.provider.name": "Provider名称",
    "settings.provider.apiKey": "API Key",
    "settings.provider.apiKeyPlaceholder": "API密钥",
    "settings.provider.apiBase": "API Base",
    "settings.provider.apiBasePlaceholder": "API地址",

    "settings.tools": "Tools 配置",
    "settings.tools.web": "Web工具",
    "settings.tools.webEnable": "启用Web工具",
    "settings.tools.proxy": "Proxy",
    "settings.tools.proxyPlaceholder": "HTTP/SOCKS5代理",
    "settings.tools.searchProvider": "Search Provider",
    "settings.tools.exec": "Exec工具",
    "settings.tools.execEnable": "启用Exec工具",
    "settings.tools.timeout": "Timeout (秒)",
    "settings.tools.timeoutPlaceholder": "执行超时",
    "settings.tools.restrictWorkspace": "限制在工作区",

    "settings.gateway": "Gateway 配置",
    "settings.gateway.host": "Host",
    "settings.gateway.hostPlaceholder": "监听地址",
    "settings.gateway.port": "Port",
    "settings.gateway.portPlaceholder": "端口",
    "settings.gateway.heartbeat": "心跳服务",
    "settings.gateway.heartbeatEnable": "启用心跳",
    "settings.gateway.interval": "Interval (秒)",
    "settings.gateway.intervalPlaceholder": "心跳间隔",

    "settings.channels": "Channels 配置",
    "settings.channels.sendProgress": "发送进度消息",
    "settings.channels.sendToolHints": "发送工具提示",
    "settings.channels.maxRetries": "Max Retries",
    "settings.channels.maxRetriesPlaceholder": "发送重试次数",

    "settings.saved": "配置已保存",
    "settings.saveFailed": "保存失败",
    "settings.noValidFields": "no valid fields to update",

    // 角色标签
    "role.assistant": "assistant",
    "role.user": "user",
    "role.system": "system",
  },
  en: {
    // Brand and titles
    "brand.title": "Tinybot",
    "brand.subtitle": "Minimal Web UI",
    "ui.newChat": "New Chat",
    "ui.refresh": "Refresh",
    "ui.sessions": "Sessions",
    "ui.systemStatus": "System Status",
    "ui.provider": "Provider",
    "ui.model": "Model",
    "ui.websocket": "WebSocket",
    "ui.currentSession": "Current Session",
    "ui.notConnected": "Not Connected",
    "ui.clear": "Clear",
    "ui.enterMessage": "Enter Message",
    "ui.inputPlaceholder": "Press Enter to send, Shift+Enter for new line",
    "ui.send": "Send",
    "ui.wsStreaming": "WebSocket real-time streaming",
    "ui.tools": "Available Tools",
    "ui.skills": "Available Skills",
    "ui.workspace": "Workspace",
    "ui.reload": "Reload",
    "ui.save": "Save",
    "ui.fileNotSelected": "No file selected",
    "ui.filePlaceholder": "Select a workspace Markdown file to edit",
    "ui.settings": "Settings",
    "ui.language": "Language",
    "ui.lastUpdate": "Last update",
    "ui.fileNotCreated": "File not created yet, will be written to workspace on save",
    "ui.updatedAt": "Updated at",
    "ui.noTime": "No time",
    "ui.deleteSession": "Delete session",
    "ui.confirmDelete": "Confirm delete session",

    // Status
    "status.connecting": "Connecting...",
    "status.connected": "Connected",
    "status.disconnected": "Disconnected",
    "status.failed": "Connection failed",
    "status.serverError": "Server error",
    "status.initFailed": "Initialization failed",
    "status.init": "Initializing",
    "status.loaded": "Loaded",
    "status.loading": "Loading",
    "status.saving": "Saving",
    "status.saved": "Saved",
    "status.cleared": "Cleared",
    "status.editing": "Editing",
    "status.conflict": "Conflict",
    "status.saveFailed": "Save failed",
    "status.loadFailed": "Load failed",
    "status.notConfigured": "Not configured",
    "status.running": "Running",
    "status.stopped": "Stopped",
    "status.available": "Available",
    "status.always": "Always",
    "status.unavailable": "Unavailable",
    "status.creatingSession": "Creating session...",
    "status.externalUpdate": "External update",

    // Messages
    "msg.noSession": "Please create or select a session first.",
    "msg.noMessages": "No messages in current session.",
    "msg.noSessions": "No sessions yet.",
    "msg.noTools": "No available tools.",
    "msg.noSkills": "No available skills.",
    "msg.noDescription": "No description",
    "msg.versionConflict": "File was updated elsewhere, please reload before saving.",
    "msg.externalFileUpdate": "Current file was updated elsewhere, you have unsaved changes.",
    "msg.websocketNotConnected": "websocket is not connected",

    // Settings modal
    "settings.title": "Settings",
    "settings.agent": "Agent Config",
    "settings.agent.workspace": "Workspace",
    "settings.agent.workspacePlaceholder": "Workspace path",
    "settings.agent.model": "Model",
    "settings.agent.modelPlaceholder": "Model name",
    "settings.agent.provider": "Provider",
    "settings.agent.providerAuto": "auto (auto detect)",
    "settings.agent.temperature": "Temperature",
    "settings.agent.temperaturePlaceholder": "0.0 - 2.0",
    "settings.agent.maxTokens": "Max Tokens",
    "settings.agent.maxTokensPlaceholder": "Max output length",
    "settings.agent.contextWindow": "Context Window",
    "settings.agent.contextWindowPlaceholder": "Context window size",
    "settings.agent.maxToolIterations": "Max Tool Iterations",
    "settings.agent.maxToolIterationsPlaceholder": "Max tool iterations",
    "settings.agent.reasoningEffort": "Reasoning Effort",
    "settings.agent.reasoningEffortDefault": "Default",
    "settings.agent.timezone": "Timezone",
    "settings.agent.timezonePlaceholder": "e.g. Asia/Shanghai",
    "settings.agent.vectorStore": "Enable vector store",

    "settings.provider": "Provider Config",
    "settings.provider.name": "Provider name",
    "settings.provider.apiKey": "API Key",
    "settings.provider.apiKeyPlaceholder": "API key",
    "settings.provider.apiBase": "API Base",
    "settings.provider.apiBasePlaceholder": "API base URL",

    "settings.tools": "Tools Config",
    "settings.tools.web": "Web tools",
    "settings.tools.webEnable": "Enable web tools",
    "settings.tools.proxy": "Proxy",
    "settings.tools.proxyPlaceholder": "HTTP/SOCKS5 proxy",
    "settings.tools.searchProvider": "Search Provider",
    "settings.tools.exec": "Exec tools",
    "settings.tools.execEnable": "Enable exec tools",
    "settings.tools.timeout": "Timeout (seconds)",
    "settings.tools.timeoutPlaceholder": "Execution timeout",
    "settings.tools.restrictWorkspace": "Restrict to workspace",

    "settings.gateway": "Gateway Config",
    "settings.gateway.host": "Host",
    "settings.gateway.hostPlaceholder": "Listen address",
    "settings.gateway.port": "Port",
    "settings.gateway.portPlaceholder": "Port",
    "settings.gateway.heartbeat": "Heartbeat",
    "settings.gateway.heartbeatEnable": "Enable heartbeat",
    "settings.gateway.interval": "Interval (seconds)",
    "settings.gateway.intervalPlaceholder": "Heartbeat interval",

    "settings.channels": "Channels Config",
    "settings.channels.sendProgress": "Send progress messages",
    "settings.channels.sendToolHints": "Send tool hints",
    "settings.channels.maxRetries": "Max Retries",
    "settings.channels.maxRetriesPlaceholder": "Send retry count",

    "settings.saved": "Config saved",
    "settings.saveFailed": "Save failed",
    "settings.noValidFields": "no valid fields to update",

    // Role labels
    "role.assistant": "assistant",
    "role.user": "user",
    "role.system": "system",
  }
};

let currentLang = "zh";

function detectLanguage() {
  const stored = localStorage.getItem("tinybot-lang");
  if (stored && (stored === "zh" || stored === "en")) {
    return stored;
  }
  const browserLang = navigator.language || navigator.userLanguage;
  if (browserLang && browserLang.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

function t(key) {
  const trans = translations[currentLang];
  if (trans && trans[key]) {
    return trans[key];
  }
  // fallback to key
  return key;
}

function setLanguage(lang) {
  if (lang !== "zh" && lang !== "en") {
    lang = "zh";
  }
  currentLang = lang;
  localStorage.setItem("tinybot-lang", lang);
  applyTranslations();
  // dispatch event for app.js to update dynamic content
  window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang } }));
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const text = t(key);
    el.textContent = text;
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    const text = t(key);
    el.placeholder = text;
  });
}

function getLanguage() {
  return currentLang;
}

function initI18n() {
  currentLang = detectLanguage();
  applyTranslations();
}

// auto init when DOM ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initI18n);
} else {
  initI18n();
}
