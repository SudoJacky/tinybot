import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));
const bootstrapSource = readFileSync(resolve(currentDir, "desktopBootstrap.ts"), "utf8");

function callPosition(call: string): number {
  const position = bootstrapSource.indexOf(call);
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

function sourceBlock(start: string, end: string): string {
  const startPosition = callPosition(start);
  const endPosition = bootstrapSource.indexOf(end, startPosition);
  expect(endPosition).toBeGreaterThan(startPosition);
  return bootstrapSource.slice(startPosition, endPosition);
}

describe("desktop bootstrap order", () => {
  test("does not import or boot the legacy root WebUI fallback", () => {
    expect(bootstrapSource).not.toContain("../../../webui/index.html?raw");
    expect(bootstrapSource).not.toContain("const WEBUI_ENTRY");
    expect(bootstrapSource).not.toContain("installWebUiShell(webUiHtml);");
    expect(bootstrapSource).not.toContain("await import(/* @vite-ignore */ WEBUI_ENTRY);");
  });

  test("loads native chat runtime before installing the native workbench shell", () => {
    const chatRuntimePosition = callPosition("const nativeChatRuntime = await loadNativeChatRuntime();");
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const chatOptionPosition = callPosition("chat: nativeChatRuntime.chat,");

    expect(chatRuntimePosition).toBeLessThan(nativeShellPosition);
    expect(chatOptionPosition).toBeGreaterThan(nativeShellPosition);
  });

  test("native startup does not schedule removed page hydration", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const hydrationStart = callPosition("function hydrateNativeStartupPanes(");
    const hydrationEnd = bootstrapSource.indexOf("const nativeRouteHydratedModules", hydrationStart);
    expect(hydrationEnd).toBeGreaterThan(hydrationStart);
    const hydrationSource = bootstrapSource.slice(hydrationStart, hydrationEnd);

    expect(nativeShellPosition).toBeGreaterThanOrEqual(0);
    expect(hydrationSource).not.toContain("loadNativeKnowledgePane()");
    expect(hydrationSource).not.toContain("loadNativeToolsSkillsPane()");
    expect(hydrationSource).not.toContain("loadNativeCoworkPane()");
    expect(hydrationSource).not.toContain("refreshNativeCoworkTasks()");
    expect(hydrationSource).not.toContain("installNativeWorkspaceFileActions()");
  });

  test("native startup refreshes approvals after the shell is available", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const approvalRefreshPosition = callPosition("scheduleNativeApprovalTasksRefresh(startupTrace);");

    expect(approvalRefreshPosition).toBeGreaterThan(nativeShellPosition);
  });

  test("native startup does not sync removed cowork rollout", () => {
    expect(bootstrapSource).not.toContain("ensureNativeCoworkRuntimeRolloutSynced(startupTrace);");
    expect(bootstrapSource).not.toContain("function ensureNativeCoworkRuntimeRolloutSynced(");
  });

  test("native route hydration only supports settings among secondary panes", () => {
    const routeHydrationSource = sourceBlock(
      "function hydrateNativeRouteTarget(",
      "function hydrateNativeSettingsPaneOnce(",
    );

    expect(routeHydrationSource).toContain('pathname.startsWith("/settings")');
    expect(routeHydrationSource).not.toContain('pathname.startsWith("/knowledge")');
    expect(routeHydrationSource).not.toContain('pathname.startsWith("/tools")');
    expect(routeHydrationSource).not.toContain('pathname.startsWith("/skills")');
    expect(routeHydrationSource).not.toContain('pathname.startsWith("/cowork")');
    expect(routeHydrationSource).not.toContain('pathname.startsWith("/files")');
  });

  test("installs native chat runtime actions after the native shell exists", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const actionInstallPosition = callPosition("installNativeChatRuntimeActions();");

    expect(actionInstallPosition).toBeGreaterThan(nativeShellPosition);
  });

  test("routes rebuilt chat surface submit events through native runtime actions", () => {
    const runtimeActionsSource = sourceBlock(
      "function installNativeChatRuntimeActions(): void {",
      "async function handleNativeInlineApprovalAction(",
    );

    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-message-submit"');
    expect(runtimeActionsSource).toContain("nativeChatActions().onComposerSubmit");
    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-session-new"');
    expect(runtimeActionsSource).toContain("nativeChatActions().onNewChat");
    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-session-open"');
    expect(runtimeActionsSource).toContain("runtime.actions.sessionOpen");
    expect(runtimeActionsSource).toContain("nativeWorkbenchRuntime.selectChatSession");
    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-approval-guidance-submit"');
    expect(runtimeActionsSource).toContain('action: "deny"');
    expect(runtimeActionsSource).toContain("guidance");
    expect(bootstrapSource).toContain("submitNativeApprovalAction(approvalId, sessionKey, action, guidance)");
    expect(bootstrapSource).toContain("guidance: guidanceValue(guidance)");
  });

  test("keeps rebuilt subagent direct message submissions out of the main composer path", () => {
    const runtimeActionsSource = sourceBlock(
      "function installNativeChatRuntimeActions(): void {",
      "async function handleNativeInlineApprovalAction(",
    );

    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-subagent-message-submit"');
    expect(runtimeActionsSource).toContain("runtime.actions.subagentDirectMessage.start");
    expect(runtimeActionsSource).toContain('invoke("worker_background_subagent_enqueue_input"');
    expect(runtimeActionsSource).toContain("runtime.actions.subagentDirectMessage.complete");
    expect(runtimeActionsSource).not.toContain("desktop-chat-subagent-message-submit\", (event) => {\n    const detail = asRecord((event as CustomEvent).detail);\n    const content = typeof detail.content === \"string\" ? detail.content : \"\";\n    logDesktopNativeDebug(\"runtime.actions.chatSurfaceSubmit\"");
  });

  test("routes rebuilt branch session requests through the backend adapter", () => {
    const runtimeActionsSource = sourceBlock(
      "function installNativeChatRuntimeActions(): void {",
      "async function handleNativeInlineApprovalAction(",
    );

    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-branch-session-request"');
    expect(runtimeActionsSource).toContain("runtime.actions.branchSession.start");
    expect(runtimeActionsSource).toContain("gatewayApi.sessions.branch");
    expect(runtimeActionsSource).toContain("nativeWorkbenchRuntime.selectChatSession");
    expect(runtimeActionsSource).toContain("runtime.actions.branchSession.complete");
  });

  test("routes rebuilt header and message actions through native runtime handlers", () => {
    const runtimeActionsSource = sourceBlock(
      "function installNativeChatRuntimeActions(): void {",
      "async function handleNativeInlineApprovalAction(",
    );

    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-session-action"');
    expect(runtimeActionsSource).toContain("runtime.actions.sessionActionUnsupported");
    expect(runtimeActionsSource).toContain("nativeWorkbenchRuntime.deleteChatSession");
    expect(runtimeActionsSource).toContain("nativeWorkbenchRuntime.patchChatSession");
    expect(runtimeActionsSource).toContain("metadata: { pinned: action === \"pin\" }");
    expect(runtimeActionsSource).toContain("metadata: { title: renamedTitle }");
    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-message-copy"');
    expect(runtimeActionsSource).toContain('document.addEventListener("desktop-chat-detail-copy"');
    expect(runtimeActionsSource).toContain("runtime.actions.detailCopy");
    expect(bootstrapSource).toContain("writeNativeClipboardText(content,");
  });

  test("routes native composer attach through the session temporary file upload control", () => {
    const attachActionPosition = callPosition("onAttachSessionFile: () => {");
    const uploadClickPosition = callPosition('document.getElementById("desktop-session-file-upload")?.click();');

    expect(uploadClickPosition).toBeGreaterThan(attachActionPosition);
  });

  test("file upload actions are limited to chat session attachments", () => {
    const uploadActionsSource = sourceBlock(
      "function installNativeFileUploadActions(): void {",
      "function refreshNativeFileUploadActions(): void {",
    );

    expect(uploadActionsSource).toContain("uploadSessionTemporaryFile");
    expect(uploadActionsSource).toContain("listSessionTemporaryFiles");
    expect(uploadActionsSource).not.toContain("uploadKnowledgeDocument");
    expect(uploadActionsSource).not.toContain("uploadWorkspaceFile");
    expect(uploadActionsSource).not.toContain("onKnowledgeUploaded");
  });

  test("native command palette only loads chat sessions", () => {
    const paletteSource = sourceBlock(
      "async function loadNativeCommandPaletteData(): Promise<DesktopCommandPaletteInput> {",
      "let nativeFileUploadActions: DesktopFileUploadActions | null = null;",
    );

    expect(paletteSource).toContain("gatewayApi.sessions.list()");
    expect(paletteSource).not.toContain("gatewayApi.workspace.files()");
    expect(paletteSource).not.toContain("gatewayApi.knowledge.documents()");
    expect(paletteSource).not.toContain("gatewayApi.tools.list()");
    expect(paletteSource).not.toContain("gatewayApi.skills.list()");
    expect(paletteSource).not.toContain("gatewayApi.cowork.sessions()");
  });

  test("resetting local settings UI state also resets the saved baseline", () => {
    const resetSource = sourceBlock(
      'if (event.action === "resetLocalUiState") {',
      'if (["openDiagnosticsLogs", "exportDiagnosticsBundle", "clearDiagnosticsLogs"].includes(event.action)) {',
    );

    expect(resetSource).toContain("nativeSettingsState = buildDesktopSettingsFormState(nativeSettingsConfig, nativeSettingsProviderCatalog);");
    expect(resetSource).toContain("nativeSettingsLastSavedState = nativeSettingsState;");
    expect(resetSource.indexOf("nativeSettingsLastSavedState = nativeSettingsState;")).toBeLessThan(
      resetSource.indexOf('updateNativeSettingsPane("idle");'),
    );
  });
});
