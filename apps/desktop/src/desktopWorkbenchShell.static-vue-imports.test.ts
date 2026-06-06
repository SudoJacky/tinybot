import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("desktop workbench shell static Vue imports", () => {
  test("statically imports the tools and skills pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountToolsSkillsPaneIsland } from "./native-vue/toolsSkillsPaneIsland";');
    expect(source).not.toContain('void import("./native-vue/toolsSkillsPaneIsland")');
  });

  test("statically imports the knowledge pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountKnowledgePaneIsland } from "./native-vue/knowledgePaneIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgePaneIsland")');
  });

  test("statically imports the settings pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountSettingsPaneIsland } from "./native-vue/settingsPaneIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsPaneIsland")');
  });

  test("statically imports the Cowork pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountCoworkPaneIsland } from "./native-vue/coworkPaneIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkPaneIsland")');
  });

  test("statically imports the Agent UI forms surface island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountAgentUiFormsSurfaceIsland } from "./native-vue/agentUiFormsSurfaceIsland";');
    expect(source).not.toContain('void import("./native-vue/agentUiFormsSurfaceIsland")');
  });

  test("statically imports the gateway runtime island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountGatewayRuntimeIsland } from "./native-vue/gatewayRuntimeIsland";');
    expect(source).not.toContain('void import("./native-vue/gatewayRuntimeIsland")');
  });

  test("statically imports the task center island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountTaskCenterIsland } from "./native-vue/taskCenterIsland";');
    expect(source).not.toContain('void import("./native-vue/taskCenterIsland")');
  });

  test("statically imports the panel controls island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountPanelControlsIsland } from "./native-vue/panelControlsIsland";');
    expect(source).not.toContain('void import("./native-vue/panelControlsIsland")');
  });

  test("statically imports the header panel controls island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountHeaderPanelControlIsland } from "./native-vue/headerPanelControlIsland";');
    expect(source).not.toContain('void import("./native-vue/headerPanelControlIsland")');
  });

  test("statically imports the panel icon part island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountPanelIconPartIsland } from "./native-vue/panelIconPartIsland";');
    expect(source).not.toContain('void import("./native-vue/panelIconPartIsland")');
  });

  test("statically imports the sidebar row islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountRecentChatRowIsland } from "./native-vue/recentChatRowIsland";');
    expect(source).not.toContain('void import("./native-vue/recentChatRowIsland")');
    expect(source).toContain('import { mountSidebarSectionHeadingIsland } from "./native-vue/sidebarSectionHeadingIsland";');
    expect(source).not.toContain('void import("./native-vue/sidebarSectionHeadingIsland")');
    expect(source).toContain('import { mountSidebarRowIsland } from "./native-vue/sidebarRowIsland";');
    expect(source).not.toContain('void import("./native-vue/sidebarRowIsland")');
  });

  test("statically imports the chat menu islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountChatMenuActionIsland } from "./native-vue/chatMenuActionIsland";');
    expect(source).not.toContain('void import("./native-vue/chatMenuActionIsland")');
    expect(source).toContain('import { mountChatMenuEmptyIsland } from "./native-vue/chatMenuEmptyIsland";');
    expect(source).not.toContain('void import("./native-vue/chatMenuEmptyIsland")');
  });

  test("statically imports the conversation message islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountConversationAttachmentIsland } from "./native-vue/conversationAttachmentIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationAttachmentIsland")');
    expect(source).toContain('import { mountConversationBodyIsland } from "./native-vue/conversationBodyIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationBodyIsland")');
    expect(source).toContain('import { mountConversationEmptyStateIsland } from "./native-vue/conversationEmptyStateIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationEmptyStateIsland")');
    expect(source).toContain('import { mountConversationMetaIsland } from "./native-vue/conversationMetaIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationMetaIsland")');
    expect(source).toContain('import { mountConversationReasoningIsland } from "./native-vue/conversationReasoningIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationReasoningIsland")');
    expect(source).toContain('import { mountConversationReferenceIsland } from "./native-vue/conversationReferenceIsland";');
    expect(source).not.toContain('void import("./native-vue/conversationReferenceIsland")');
  });

  test("statically imports the tool activity islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountToolActivitiesIsland } from "./native-vue/toolActivitiesIsland";');
    expect(source).not.toContain('void import("./native-vue/toolActivitiesIsland")');
    expect(source).toContain('import { mountToolActivityIsland } from "./native-vue/toolActivityIsland";');
    expect(source).not.toContain('void import("./native-vue/toolActivityIsland")');
    expect(source).toContain('import { mountToolActivitySectionIsland } from "./native-vue/toolActivitySectionIsland";');
    expect(source).not.toContain('void import("./native-vue/toolActivitySectionIsland")');
  });

  test("statically imports the composer control islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountComposerAttachButtonIsland } from "./native-vue/composerAttachButtonIsland";');
    expect(source).not.toContain('void import("./native-vue/composerAttachButtonIsland")');
    expect(source).toContain('import { mountComposerModelControlIsland } from "./native-vue/composerModelControlIsland";');
    expect(source).not.toContain('void import("./native-vue/composerModelControlIsland")');
    expect(source).toContain('import { mountComposerRuntimeIsland } from "./native-vue/composerRuntimeIsland";');
    expect(source).not.toContain('void import("./native-vue/composerRuntimeIsland")');
    expect(source).toContain('import { mountComposerSendButtonIsland } from "./native-vue/composerSendButtonIsland";');
    expect(source).not.toContain('void import("./native-vue/composerSendButtonIsland")');
    expect(source).toContain('import { mountPersistentRagToggleIsland } from "./native-vue/persistentRagToggleIsland";');
    expect(source).not.toContain('void import("./native-vue/persistentRagToggleIsland")');
    expect(source).toContain('import { mountTokenUsageOrbIsland } from "./native-vue/tokenUsageOrbIsland";');
    expect(source).not.toContain('void import("./native-vue/tokenUsageOrbIsland")');
  });

  test("statically imports the Agent UI form islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountAgentUiFormActionsIsland } from "./native-vue/agentUiFormActionsIsland";');
    expect(source).not.toContain('void import("./native-vue/agentUiFormActionsIsland")');
    expect(source).toContain('import { mountAgentUiFormCardIsland } from "./native-vue/agentUiFormCardIsland";');
    expect(source).not.toContain('void import("./native-vue/agentUiFormCardIsland")');
    expect(source).toContain('import { mountAgentUiFormFieldIsland } from "./native-vue/agentUiFormFieldIsland";');
    expect(source).not.toContain('void import("./native-vue/agentUiFormFieldIsland")');
  });

  test("statically imports the tools and skills sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountSkillsListIsland } from "./native-vue/skillsListIsland";');
    expect(source).not.toContain('void import("./native-vue/skillsListIsland")');
    expect(source).toContain('import { mountSkillDetailSummaryIsland } from "./native-vue/skillDetailSummaryIsland";');
    expect(source).not.toContain('void import("./native-vue/skillDetailSummaryIsland")');
    expect(source).toContain('import { mountToolDetailIsland } from "./native-vue/toolDetailIsland";');
    expect(source).not.toContain('void import("./native-vue/toolDetailIsland")');
    expect(source).toContain('import { mountToolsListIsland } from "./native-vue/toolsListIsland";');
    expect(source).not.toContain('void import("./native-vue/toolsListIsland")');
    expect(source).toContain('import { mountToolsSkillsActionsIsland } from "./native-vue/toolsSkillsActionsIsland";');
    expect(source).not.toContain('void import("./native-vue/toolsSkillsActionsIsland")');
  });

  test("statically imports the knowledge sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountKnowledgeActionsIsland } from "./native-vue/knowledgeActionsIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeActionsIsland")');
    expect(source).toContain('import { mountKnowledgeDocumentDetailIsland } from "./native-vue/knowledgeDocumentDetailIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeDocumentDetailIsland")');
    expect(source).toContain('import { mountKnowledgeDocumentsIsland } from "./native-vue/knowledgeDocumentsIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeDocumentsIsland")');
    expect(source).toContain('import { mountKnowledgeGraphIsland } from "./native-vue/knowledgeGraphIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeGraphIsland")');
    expect(source).toContain('import { mountKnowledgeQueryIsland } from "./native-vue/knowledgeQueryIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeQueryIsland")');
    expect(source).toContain('import { mountKnowledgeReadinessIsland } from "./native-vue/knowledgeReadinessIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeReadinessIsland")');
    expect(source).toContain('import { mountKnowledgeReferenceRowIsland } from "./native-vue/knowledgeReferenceRowIsland";');
    expect(source).not.toContain('void import("./native-vue/knowledgeReferenceRowIsland")');
  });

  test("statically imports the Cowork sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountCoworkActionsIsland } from "./native-vue/coworkActionsIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkActionsIsland")');
    expect(source).toContain('import { mountCoworkDataRowIsland } from "./native-vue/coworkDataRowIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkDataRowIsland")');
    expect(source).toContain('import { mountCoworkGraphIsland } from "./native-vue/coworkGraphIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkGraphIsland")');
    expect(source).toContain('import { mountCoworkHeaderIsland } from "./native-vue/coworkHeaderIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkHeaderIsland")');
    expect(source).toContain('import { mountCoworkInspectorIsland } from "./native-vue/coworkInspectorIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkInspectorIsland")');
    expect(source).toContain('import { mountCoworkLimitStatusIsland } from "./native-vue/coworkLimitStatusIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkLimitStatusIsland")');
    expect(source).toContain('import { mountCoworkObservabilityIsland } from "./native-vue/coworkObservabilityIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkObservabilityIsland")');
    expect(source).toContain('import { mountCoworkSessionsIsland } from "./native-vue/coworkSessionsIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkSessionsIsland")');
    expect(source).toContain('import { mountCoworkTaskFeedIsland } from "./native-vue/coworkTaskFeedIsland";');
    expect(source).not.toContain('void import("./native-vue/coworkTaskFeedIsland")');
  });

  test("statically imports the inspector and work lens islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountInspectorRegionIsland } from "./native-vue/inspectorRegionIsland";');
    expect(source).not.toContain('void import("./native-vue/inspectorRegionIsland")');
    expect(source).toContain('import { mountInspectorViewIsland } from "./native-vue/inspectorViewIsland";');
    expect(source).not.toContain('void import("./native-vue/inspectorViewIsland")');
    expect(source).toContain('import { mountRunChainInspectorIsland } from "./native-vue/runChainInspectorIsland";');
    expect(source).not.toContain('void import("./native-vue/runChainInspectorIsland")');
    expect(source).toContain('import { mountRunChainOverviewIsland } from "./native-vue/runChainOverviewIsland";');
    expect(source).not.toContain('void import("./native-vue/runChainOverviewIsland")');
    expect(source).toContain('import { mountWorkLensIsland } from "./native-vue/workLensIsland";');
    expect(source).not.toContain('void import("./native-vue/workLensIsland")');
  });

  test("statically imports the settings sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountSettingsDefaultLlmIsland } from "./native-vue/settingsDefaultLlmIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsDefaultLlmIsland")');
    expect(source).toContain('import { mountSettingsGroupsIsland } from "./native-vue/settingsGroupsIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsGroupsIsland")');
    expect(source).toContain('import { mountSettingsProviderDetailIsland } from "./native-vue/settingsProviderDetailIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsProviderDetailIsland")');
    expect(source).toContain('import { mountSettingsProviderManagementIsland } from "./native-vue/settingsProviderManagementIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsProviderManagementIsland")');
    expect(source).toContain('import { mountSettingsSidebarIsland } from "./native-vue/settingsSidebarIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsSidebarIsland")');
    expect(source).toContain('import { mountSettingsStatusIsland } from "./native-vue/settingsStatusIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsStatusIsland")');
    expect(source).toContain('import { mountSettingsStatusItemIsland } from "./native-vue/settingsStatusItemIsland";');
    expect(source).not.toContain('void import("./native-vue/settingsStatusItemIsland")');
  });

  test("statically imports the file action islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountFileActionsSurfaceIsland } from "./native-vue/fileActionsSurfaceIsland";');
    expect(source).not.toContain('void import("./native-vue/fileActionsSurfaceIsland")');
    expect(source).toContain('import { mountFileImportCardIsland } from "./native-vue/fileImportCardIsland";');
    expect(source).not.toContain('void import("./native-vue/fileImportCardIsland")');
    expect(source).toContain('import { mountFileOperationStatusIsland } from "./native-vue/fileOperationStatusIsland";');
    expect(source).not.toContain('void import("./native-vue/fileOperationStatusIsland")');
    expect(source).toContain('import { mountFileUploadStatusIsland } from "./native-vue/fileUploadStatusIsland";');
    expect(source).not.toContain('void import("./native-vue/fileUploadStatusIsland")');
    expect(source).toContain('import { mountFormatChipListIsland } from "./native-vue/formatChipListIsland";');
    expect(source).not.toContain('void import("./native-vue/formatChipListIsland")');
    expect(source).toContain('import { mountOrUpdateSessionFileListIsland } from "./native-vue/sessionFileListIsland";');
    expect(source).not.toContain('void import("./native-vue/sessionFileListIsland")');
    expect(source).toContain('import { mountSessionUploadCardIsland } from "./native-vue/sessionUploadCardIsland";');
    expect(source).not.toContain('void import("./native-vue/sessionUploadCardIsland")');
  });
});
