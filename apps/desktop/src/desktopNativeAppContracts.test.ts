import { describe, expect, test } from "vitest";
import {
  buildNativeAppPageModernizationContract,
  buildNativeAppSettingsCenterContract,
  buildNativeAppTechnicalIntegrationContract,
  buildNativeAppUserFlowContract,
  buildNativeAppVerificationMatrix,
  buildNativeAppVisualSystemContract,
} from "./desktopNativeAppContracts";

describe("native app cross-surface contracts", () => {
  test("covers Settings Center forms, dangerous confirmations, policies, sections, and validation states", () => {
    const contract = buildNativeAppSettingsCenterContract();

    expect(contract.categories.map((category) => category.id)).toEqual([
      "provider-models",
      "knowledge",
      "tools-approvals",
      "files-workspace",
      "memory-experience",
      "skills",
      "channels",
      "gateway-runtime",
      "logs-diagnostics",
    ]);
    expect(contract.providerModels).toEqual({
      forms: ["provider", "model", "api-key", "base-url"],
      cards: ["current-provider", "available-models", "health"],
      actions: ["discover", "test-connection", "validate", "save"],
      states: ["dirty", "validating", "invalid", "saved", "health-check"],
    });
    expect(contract.knowledge.dangerConfirmations).toEqual(["rebuild-index", "clear-graph", "delete-document"]);
    expect(contract.toolsApprovals.policyDefaults).toEqual(["ask-before-shell", "deny-browser-by-default", "require-mcp-allowlist"]);
    expect(contract.verification).toEqual(["unsaved-changes", "validation-failures", "danger-confirmations", "runtime-modes", "channel-controls"]);
  });

  test("covers shared visual primitives and audit rules", () => {
    const contract = buildNativeAppVisualSystemContract();

    expect(contract.components).toEqual([
      "status-tag",
      "context-chip",
      "confirmation-modal",
      "activity-timeline",
      "evidence-card",
      "tool-call-card",
    ]);
    expect(contract.densityModes).toEqual(["comfortable", "compact", "focus"]);
    expect(contract.audit).toEqual({
      orangeUsage: "limited-to-warning-danger",
      nestedCards: "disallowed",
      overlap: "guarded-by-minmax-and-reserved-composer-space",
      desktopMinimumWidth: 1024,
    });
  });

  test("covers page modernization preservation for Chat, Files, Knowledge, and Settings", () => {
    const contract = buildNativeAppPageModernizationContract();

    expect(contract.pages.map((page) => [page.id, page.preserved, page.added])).toEqual([
      ["chat", ["new-chat", "send", "attach", "stop"], ["structured-messages", "activity-inspector"]],
      ["files", ["upload", "workspace-save", "reveal"], ["scopes", "detail-pane", "editor", "index-status"]],
      ["knowledge", ["upload", "query", "rebuild"], ["graph-primary", "query-drawer", "detail-drawer"]],
      ["settings", ["provider-save", "model-select"], ["detail-layout", "expanded-sections"]],
    ]);
    expect(contract.verifyAfterEachSlice).toBe(true);
  });

  test("covers the required native user flows with route transitions and event updates", () => {
    const contract = buildNativeAppUserFlowContract();

    expect(contract.flows.map((flow) => flow.id)).toEqual([
      "first-start-provider-setup",
      "upload-scope-selection",
      "promote-to-knowledge",
      "knowledge-result-to-chat",
      "provider-model-toolbar-update",
      "approval-continuation",
    ]);
    expect(contract.flows.every((flow) => flow.routeTransitions.length > 0 && flow.events.length > 0)).toBe(true);
    expect(contract.endToEndVerification).toEqual(["route-transition", "event-update", "state-continuity"]);
  });

  test("covers technical editor/preview, Tauri capability, graph lazy-load, opener, and dialog integration", () => {
    const contract = buildNativeAppTechnicalIntegrationContract();

    expect(contract.editorPreview).toEqual(["workspace-editor", "diff-preview", "knowledge-source-preview"]);
    expect(contract.tauriCapabilities).toEqual(["opener", "notification", "file-dialog"]);
    expect(contract.deepLinks).toEqual(["/chat/:chatId", "/knowledge", "/files", "/settings/:section"]);
    expect(contract.nativeBehaviors).toEqual(["graph-lazy-3d-load", "native-opener", "native-dialog"]);
  });

  test("summarizes final local verification coverage across remaining specs", () => {
    const matrix = buildNativeAppVerificationMatrix();

    expect(matrix).toEqual({
      browserOrNativeManualControl: false,
      automatedChecks: ["npm run build", "npm test", "openspec validate --strict"],
      coveredSpecs: [
        "native-app-chat-workbench",
        "native-app-files-workbench",
        "native-app-knowledge-workbench",
        "native-app-shell-inspector",
        "native-app-settings-center",
        "native-app-visual-system",
        "native-app-page-modernization",
        "native-app-user-flows",
        "native-app-technical-stack",
        "native-app-graph-technology",
        "native-app-product-architecture",
      ],
    });
  });
});
