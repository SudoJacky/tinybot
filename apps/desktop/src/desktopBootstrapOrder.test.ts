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

describe("desktop root WebUI bootstrap order", () => {
  test("lets the WebUI entry bind its original DOM before installing the desktop root adapter", () => {
    const shellPosition = callPosition("installWebUiShell(webUiHtml);");
    const webUiEntryPosition = callPosition("await import(/* @vite-ignore */ WEBUI_ENTRY);");
    const rootAdapterPosition = callPosition("installDesktopRootWebUiWorkbenchAdapter();");

    expect(webUiEntryPosition).toBeGreaterThan(shellPosition);
    expect(webUiEntryPosition).toBeLessThan(rootAdapterPosition);
  });

  test("loads native chat runtime before installing the native workbench shell", () => {
    const chatRuntimePosition = callPosition("const nativeChatRuntime = await loadNativeChatRuntime();");
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const chatOptionPosition = callPosition("chat: nativeChatRuntime.chat,");

    expect(chatRuntimePosition).toBeLessThan(nativeShellPosition);
    expect(chatOptionPosition).toBeGreaterThan(nativeShellPosition);
  });

  test("native startup defers secondary pane and cowork task hydration", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const hydrationStart = callPosition("function hydrateNativeStartupPanes(");
    const hydrationEnd = bootstrapSource.indexOf("const nativeRouteHydratedModules", hydrationStart);
    expect(hydrationEnd).toBeGreaterThan(hydrationStart);
    const hydrationSource = bootstrapSource.slice(hydrationStart, hydrationEnd);

    expect(nativeShellPosition).toBeGreaterThanOrEqual(0);
    expect(hydrationSource).not.toContain("loadNativeSettingsPane()");
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

  test("native startup syncs cowork rollout without hydrating settings", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const rolloutSyncPosition = callPosition("ensureNativeCoworkRuntimeRolloutSynced(startupTrace);");
    const settingsHydrationPosition = callPosition("hydrateNativeSettingsPaneOnce(startupTrace);");

    expect(rolloutSyncPosition).toBeGreaterThan(nativeShellPosition);
    expect(rolloutSyncPosition).toBeLessThan(settingsHydrationPosition);
  });

  test("native cowork hydration waits for rollout config before loading cowork data", () => {
    const coworkHydrationStart = callPosition("function hydrateNativeCoworkPaneOnce(");
    const coworkHydrationEnd = bootstrapSource.indexOf("function hydrateNativeWorkspaceFilesOnce", coworkHydrationStart);
    expect(coworkHydrationEnd).toBeGreaterThan(coworkHydrationStart);
    const coworkHydrationSource = bootstrapSource.slice(coworkHydrationStart, coworkHydrationEnd);

    const rolloutSyncPosition = coworkHydrationSource.indexOf("await ensureNativeCoworkRuntimeRolloutSynced(startupTrace);");
    const loadCoworkPosition = coworkHydrationSource.indexOf("const pane = await loadNativeCoworkPane();");

    expect(rolloutSyncPosition).toBeGreaterThanOrEqual(0);
    expect(loadCoworkPosition).toBeGreaterThan(rolloutSyncPosition);
  });

  test("installs native chat runtime actions after the native shell exists", () => {
    const nativeShellPosition = callPosition("installDesktopWorkbenchShell({");
    const actionInstallPosition = callPosition("installNativeChatRuntimeActions();");

    expect(actionInstallPosition).toBeGreaterThan(nativeShellPosition);
  });

  test("routes native composer attach through the session temporary file upload control", () => {
    const attachActionPosition = callPosition("onAttachSessionFile: () => {");
    const uploadClickPosition = callPosition('document.getElementById("desktop-session-file-upload")?.click();');

    expect(uploadClickPosition).toBeGreaterThan(attachActionPosition);
  });

  test("refreshes the native knowledge pane after document upload completes", () => {
    const uploadActionsSource = sourceBlock(
      "function installNativeFileUploadActions(): void {",
      "function refreshNativeFileUploadActions(): void {",
    );

    expect(uploadActionsSource).toContain("onKnowledgeUploaded");
    expect(uploadActionsSource).toContain("loadNativeKnowledgePane");
    expect(uploadActionsSource).toContain("setNativeKnowledgePane");
  });
});
