export function buildNativeAppSettingsCenterContract() {
  return {
    categories: [
      category("provider-models", "Provider & Models"),
      category("tools-approvals", "Tools & Approvals"),
      category("files-workspace", "Files & Workspace"),
      category("memory-experience", "Memory & Experience"),
      category("skills", "Skills"),
      category("channels", "Channels"),
      category("gateway-runtime", "Gateway & Runtime"),
      category("logs-diagnostics", "Logs & Diagnostics"),
    ],
    providerModels: {
      forms: ["provider", "model", "api-key", "base-url"],
      cards: ["current-provider", "available-models", "health"],
      actions: ["discover", "test-connection", "validate", "save"],
      states: ["dirty", "validating", "invalid", "saved", "health-check"],
    },
    toolsApprovals: {
      policyDefaults: ["ask-before-shell", "deny-browser-by-default", "require-mcp-allowlist"],
    },
    verification: ["unsaved-changes", "validation-failures", "danger-confirmations", "runtime-modes", "channel-controls"],
  };
}

export function buildNativeAppVisualSystemContract() {
  return {
    components: [
      "status-tag",
      "context-chip",
      "confirmation-modal",
      "activity-timeline",
      "evidence-card",
      "tool-call-card",
    ],
    densityModes: ["comfortable", "compact", "focus"],
    audit: {
      orangeUsage: "limited-to-warning-danger",
      nestedCards: "disallowed",
      overlap: "guarded-by-minmax-and-reserved-composer-space",
      desktopMinimumWidth: 1024,
    },
  };
}

export function buildNativeAppPageModernizationContract() {
  return {
    pages: [
      page("chat", ["new-chat", "send", "attach", "stop"], ["structured-messages", "activity-inspector"]),
      page("files", ["upload", "workspace-save", "reveal"], ["scopes", "detail-pane", "editor", "index-status"]),
      page("settings", ["provider-save", "model-select"], ["detail-layout", "expanded-sections"]),
    ],
    verifyAfterEachSlice: true,
  };
}

export function buildNativeAppUserFlowContract() {
  return {
    flows: [
      flow("first-start-provider-setup", ["/settings/provider-models", "/chat"], ["provider.validated", "toolbar.model.updated"]),
      flow("upload-scope-selection", ["/chat/:chatId", "/files"], ["upload.started", "upload.completed"]),
      flow("provider-model-toolbar-update", ["/settings/provider-models", "/chat"], ["settings.saved", "toolbar.model.updated"]),
      flow("approval-continuation", ["/chat/:chatId", "/approvals"], ["approval.pending", "approval.resolved"]),
    ],
    endToEndVerification: ["route-transition", "event-update", "state-continuity"],
  };
}

export function buildNativeAppTechnicalIntegrationContract() {
  return {
    editorPreview: ["workspace-editor", "diff-preview"],
    tauriCapabilities: ["opener", "notification", "file-dialog"],
    deepLinks: ["/chat/:chatId", "/files", "/settings/:section"],
    nativeBehaviors: ["native-opener", "native-dialog"],
  };
}

export function buildNativeAppVerificationMatrix() {
  return {
    browserOrNativeManualControl: false,
    automatedChecks: ["npm run build", "npm test", "openspec validate --strict"],
    coveredSpecs: [
      "native-app-chat-workbench",
      "native-app-files-workbench",
      "native-app-shell-inspector",
      "native-app-settings-center",
      "native-app-visual-system",
      "native-app-page-modernization",
      "native-app-user-flows",
      "native-app-technical-stack",
      "native-app-product-architecture",
    ],
  };
}

function category(id: string, label: string) {
  return { id, label };
}

function page(id: string, preserved: string[], added: string[]) {
  return { id, preserved, added };
}

function flow(id: string, routeTransitions: string[], events: string[]) {
  return { id, routeTransitions, events };
}
