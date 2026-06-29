import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("desktop workbench shell static Vue imports", () => {
  test("statically imports the tools and skills pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountToolsSkillsPaneIsland } from "../components/tools-skills/toolsSkillsPaneIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolsSkillsPaneIsland")');
  });

  test("statically imports the knowledge pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountKnowledgePaneIsland } from "../components/knowledge/knowledgePaneIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgePaneIsland")');
  });

  test("statically imports the settings pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountSettingsPaneIsland } from "../components/settings/settingsPaneIsland";');
    expect(source).not.toContain('void import("../components/settings/settingsPaneIsland")');
  });

  test("statically imports the Cowork pane island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountCoworkPaneIsland } from "../components/cowork/coworkPaneIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkPaneIsland")');
  });

  test("statically imports the Agent UI forms surface island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountAgentUiFormsSurfaceIsland } from "../components/agent-ui/agentUiFormsSurfaceIsland";');
    expect(source).not.toContain('void import("../components/agent-ui/agentUiFormsSurfaceIsland")');
  });

  test("statically imports the gateway runtime island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountGatewayRuntimeIsland } from "../components/gateway/gatewayRuntimeIsland";');
    expect(source).not.toContain('void import("../components/gateway/gatewayRuntimeIsland")');
  });

  test("statically imports the task center island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountTaskCenterIsland } from "../components/tasks/taskCenterIsland";');
    expect(source).not.toContain('void import("../components/tasks/taskCenterIsland")');
  });

  test("does not lazy load the retired panel controls island", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).not.toContain('import { mountPanelControlsIsland } from "../components/shell/panelControlsIsland";');
    expect(source).not.toContain('void import("../components/shell/panelControlsIsland")');
  });

  test("does not import the retired header panel controls island into the workbench shell", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).not.toContain('import { mountHeaderPanelControlIsland } from "../components/shell/headerPanelControlIsland";');
    expect(source).not.toContain('void import("../components/shell/headerPanelControlIsland")');
  });

  test("does not import the retired panel icon part island into the workbench shell", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).not.toContain('import { mountPanelIconPartIsland } from "../components/shell/panelIconPartIsland";');
    expect(source).not.toContain('void import("../components/shell/panelIconPartIsland")');
  });

  test("statically imports the sidebar row islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountRecentChatRowIsland } from "../components/chat/recentChatRowIsland";');
    expect(source).not.toContain('void import("../components/chat/recentChatRowIsland")');
    expect(source).toContain('import { mountSidebarSectionHeadingIsland } from "../components/shell/sidebarSectionHeadingIsland";');
    expect(source).not.toContain('void import("../components/shell/sidebarSectionHeadingIsland")');
    expect(source).toContain('import { mountSidebarRowIsland } from "../components/shell/sidebarRowIsland";');
    expect(source).not.toContain('void import("../components/shell/sidebarRowIsland")');
  });

  test("statically imports the chat menu islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountChatMenuActionIsland } from "../components/chat/chatMenuActionIsland";');
    expect(source).not.toContain('void import("../components/chat/chatMenuActionIsland")');
    expect(source).toContain('import { mountChatMenuEmptyIsland } from "../components/chat/chatMenuEmptyIsland";');
    expect(source).not.toContain('void import("../components/chat/chatMenuEmptyIsland")');
  });

  test("statically imports the conversation message islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountConversationAttachmentIsland } from "../components/chat/conversationAttachmentIsland";');
    expect(source).not.toContain('void import("../components/chat/conversationAttachmentIsland")');
    expect(source).toContain('import { mountConversationBodyIsland } from "../components/chat/conversationBodyIsland";');
    expect(source).not.toContain('void import("../components/chat/conversationBodyIsland")');
    expect(source).not.toContain('void import("../components/chat/conversationEmptyStateIsland")');
    expect(source).toContain('import { mountConversationMetaIsland } from "../components/chat/conversationMetaIsland";');
    expect(source).not.toContain('void import("../components/chat/conversationMetaIsland")');
    expect(source).toContain('import { mountConversationReasoningIsland } from "../components/chat/conversationReasoningIsland";');
    expect(source).not.toContain('void import("../components/chat/conversationReasoningIsland")');
    expect(source).toContain('import { mountConversationReferenceIsland } from "../components/chat/conversationReferenceIsland";');
    expect(source).not.toContain('void import("../components/chat/conversationReferenceIsland")');
  });

  test("statically imports the tool activity islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountToolActivitiesIsland } from "../components/tools-skills/toolActivitiesIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolActivitiesIsland")');
    expect(source).toContain('import { mountToolActivityIsland } from "../components/tools-skills/toolActivityIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolActivityIsland")');
    expect(source).toContain('} from "../components/tools-skills/toolActivityStatus";');
  });

  test("statically imports the composer control islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountComposerAttachButtonIsland } from "../components/chat/composerAttachButtonIsland";');
    expect(source).not.toContain('void import("../components/chat/composerAttachButtonIsland")');
    expect(source).toContain('import { mountComposerModelControlIsland } from "../components/chat/composerModelControlIsland";');
    expect(source).not.toContain('void import("../components/chat/composerModelControlIsland")');
    expect(source).toContain('import { mountComposerRuntimeIsland } from "../components/chat/composerRuntimeIsland";');
    expect(source).not.toContain('void import("../components/chat/composerRuntimeIsland")');
    expect(source).toContain('import { mountComposerSendButtonIsland } from "../components/chat/composerSendButtonIsland";');
    expect(source).not.toContain('void import("../components/chat/composerSendButtonIsland")');
    expect(source).toContain('import { mountPersistentRagToggleIsland } from "../components/knowledge/persistentRagToggleIsland";');
    expect(source).not.toContain('void import("../components/knowledge/persistentRagToggleIsland")');
    expect(source).toContain('import { mountTokenUsageOrbIsland } from "../components/shell/tokenUsageOrbIsland";');
    expect(source).not.toContain('void import("../components/shell/tokenUsageOrbIsland")');
  });

  test("statically imports the Agent UI form islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountAgentUiFormActionsIsland } from "../components/agent-ui/agentUiFormActionsIsland";');
    expect(source).not.toContain('void import("../components/agent-ui/agentUiFormActionsIsland")');
    expect(source).toContain('import { mountAgentUiFormCardIsland } from "../components/agent-ui/agentUiFormCardIsland";');
    expect(source).not.toContain('void import("../components/agent-ui/agentUiFormCardIsland")');
    expect(source).toContain('import { mountAgentUiFormFieldIsland } from "../components/agent-ui/agentUiFormFieldIsland";');
    expect(source).not.toContain('void import("../components/agent-ui/agentUiFormFieldIsland")');
  });

  test("statically imports the tools and skills sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountSkillsListIsland } from "../components/tools-skills/skillsListIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/skillsListIsland")');
    expect(source).toContain('import { mountSkillDetailSummaryIsland } from "../components/tools-skills/skillDetailSummaryIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/skillDetailSummaryIsland")');
    expect(source).toContain('import { mountToolDetailIsland } from "../components/tools-skills/toolDetailIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolDetailIsland")');
    expect(source).toContain('import { mountToolsListIsland } from "../components/tools-skills/toolsListIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolsListIsland")');
    expect(source).toContain('import { mountToolsSkillsActionsIsland, type ToolsSkillsActionId } from "../components/tools-skills/toolsSkillsActionsIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/toolsSkillsActionsIsland")');
  });

  test("statically imports the knowledge sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).not.toContain(
      'import { mountKnowledgeActionsIsland } from "../components/knowledge/knowledgeActionsIsland";',
    );
    expect(source).not.toContain('void import("../components/knowledge/knowledgeActionsIsland")');
    expect(source).toContain('import { mountKnowledgeDocumentDetailIsland } from "../components/knowledge/knowledgeDocumentDetailIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgeDocumentDetailIsland")');
    expect(source).toContain('import { mountKnowledgeDocumentsIsland } from "../components/knowledge/knowledgeDocumentsIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgeDocumentsIsland")');
    expect(source).toContain('import { mountKnowledgeGraphIsland } from "../components/knowledge/knowledgeGraphIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgeGraphIsland")');
    expect(source).not.toContain('import { mountKnowledgeQueryIsland } from "../components/knowledge/knowledgeQueryIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgeQueryIsland")');
    expect(source).toContain('import { mountKnowledgeReadinessIsland } from "../components/knowledge/knowledgeReadinessIsland";');
    expect(source).not.toContain('void import("../components/knowledge/knowledgeReadinessIsland")');
    expect(source).not.toContain(
      'import { mountKnowledgeReferenceRowIsland } from "../components/knowledge/knowledgeReferenceRowIsland";',
    );
    expect(source).not.toContain('void import("../components/knowledge/knowledgeReferenceRowIsland")');
  });

  test("statically imports the Cowork sub-islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountCoworkActionsIsland } from "../components/cowork/coworkActionsIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkActionsIsland")');
    expect(source).toContain('import { mountCoworkDataRowIsland } from "../components/cowork/coworkDataRowIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkDataRowIsland")');
    expect(source).toContain('import { mountCoworkGraphIsland } from "../components/cowork/coworkGraphIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkGraphIsland")');
    expect(source).toContain('import { mountCoworkHeaderIsland } from "../components/cowork/coworkHeaderIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkHeaderIsland")');
    expect(source).toContain('import { mountCoworkInspectorIsland } from "../components/cowork/coworkInspectorIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkInspectorIsland")');
    expect(source).toContain('import { mountCoworkLimitStatusIsland } from "../components/cowork/coworkLimitStatusIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkLimitStatusIsland")');
    expect(source).toContain('import { mountCoworkObservabilityIsland } from "../components/cowork/coworkObservabilityIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkObservabilityIsland")');
    expect(source).toContain('import { mountCoworkSessionsIsland } from "../components/cowork/coworkSessionsIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkSessionsIsland")');
    expect(source).toContain('import { mountCoworkTaskFeedIsland } from "../components/cowork/coworkTaskFeedIsland";');
    expect(source).not.toContain('void import("../components/cowork/coworkTaskFeedIsland")');
  });

  test("statically imports the inspector and work lens islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountInspectorRegionIsland } from "../components/shell/inspectorRegionIsland";');
    expect(source).not.toContain('void import("../components/shell/inspectorRegionIsland")');
    expect(source).toContain('import { mountInspectorViewIsland } from "../components/shell/inspectorViewIsland";');
    expect(source).not.toContain('void import("../components/shell/inspectorViewIsland")');
    expect(source).toContain('import { mountRunChainInspectorIsland } from "../components/shell/runChainInspectorIsland";');
    expect(source).not.toContain('void import("../components/shell/runChainInspectorIsland")');
    expect(source).toContain('import { mountRunChainOverviewIsland } from "../components/shell/runChainOverviewIsland";');
    expect(source).not.toContain('void import("../components/shell/runChainOverviewIsland")');
    expect(source).toContain('import { mountWorkLensIsland } from "../components/shell/workLensIsland";');
    expect(source).not.toContain('void import("../components/shell/workLensIsland")');
  });

  test("statically imports only the unified settings pane island from the shell", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountOrUpdateSettingsPaneIsland } from "../components/settings/settingsPaneIsland";');
    expect(source).toContain('import { mountSettingsPaneIsland } from "../components/settings/settingsPaneIsland";');
    expect(source).not.toContain('import { mountSettingsDefaultLlmIsland } from "../components/settings/settingsDefaultLlmIsland";');
    expect(source).not.toContain('import { mountSettingsGroupsIsland } from "../components/settings/settingsGroupsIsland";');
    expect(source).not.toContain('import { mountSettingsProviderDetailIsland } from "../components/settings/settingsProviderDetailIsland";');
    expect(source).not.toContain('import { mountSettingsProviderManagementIsland } from "../components/settings/settingsProviderManagementIsland";');
    expect(source).not.toContain('import { mountSettingsSidebarIsland } from "../components/settings/settingsSidebarIsland";');
    expect(source).not.toContain('import { mountSettingsStatusIsland } from "../components/settings/settingsStatusIsland";');
    expect(source).not.toContain('import { mountSettingsStatusItemIsland } from "../components/settings/settingsStatusItemIsland";');
  });

  test("statically imports the file action islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountFileActionsSurfaceIsland } from "../components/workspace/fileActionsSurfaceIsland";');
    expect(source).not.toContain('void import("../components/workspace/fileActionsSurfaceIsland")');
    expect(source).toContain('import { mountFileImportCardIsland } from "../components/workspace/fileImportCardIsland";');
    expect(source).not.toContain('void import("../components/workspace/fileImportCardIsland")');
    expect(source).toContain('import { mountFileOperationStatusIsland } from "../components/workspace/fileOperationStatusIsland";');
    expect(source).not.toContain('void import("../components/workspace/fileOperationStatusIsland")');
    expect(source).toContain('import { mountFileUploadStatusIsland } from "../components/workspace/fileUploadStatusIsland";');
    expect(source).not.toContain('void import("../components/workspace/fileUploadStatusIsland")');
    expect(source).toContain('import { mountFormatChipListIsland } from "../components/shell/formatChipListIsland";');
    expect(source).not.toContain('void import("../components/shell/formatChipListIsland")');
    expect(source).toContain('import { mountOrUpdateSessionFileListIsland } from "../components/chat/sessionFileListIsland";');
    expect(source).not.toContain('void import("../components/chat/sessionFileListIsland")');
    expect(source).toContain('import { mountSessionUploadCardIsland } from "../components/chat/sessionUploadCardIsland";');
    expect(source).not.toContain('void import("../components/chat/sessionUploadCardIsland")');
  });

  test("does not import shared resource/system sidebar islands into the workbench shell", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).not.toContain('import { mountSharedSidebarCommandButtonIsland } from "../components/shell/sharedSidebarCommandButtonIsland";');
    expect(source).not.toContain('void import("../components/shell/sharedSidebarCommandButtonIsland")');
    expect(source).not.toContain('import { mountSharedSidebarCommandsIsland } from "../components/shell/sharedSidebarCommandsIsland";');
    expect(source).not.toContain('void import("../components/shell/sharedSidebarCommandsIsland")');
    expect(source).not.toContain('import { mountSharedSidebarLinkIsland } from "../components/shell/sharedSidebarLinkIsland";');
    expect(source).not.toContain('void import("../components/shell/sharedSidebarLinkIsland")');
    expect(source).not.toContain('import { mountSharedSidebarLinksIsland } from "../components/shell/sharedSidebarLinksIsland";');
    expect(source).not.toContain('void import("../components/shell/sharedSidebarLinksIsland")');
  });

  test("statically imports the task action islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountTaskActionIsland } from "../components/tasks/taskActionIsland";');
    expect(source).not.toContain('void import("../components/tasks/taskActionIsland")');
    expect(source).toContain('import { mountTaskStateBadgeIsland } from "../components/tasks/taskStateBadgeIsland";');
    expect(source).not.toContain('void import("../components/tasks/taskStateBadgeIsland")');
  });

  test("statically imports the remaining desktop Vue islands", () => {
    const source = readFileSync(resolve(__dirname, "desktopWorkbenchShell.ts"), "utf8");

    expect(source).toContain('import { mountHelpSurfaceIsland } from "../components/shell/helpSurfaceIsland";');
    expect(source).not.toContain('void import("../components/shell/helpSurfaceIsland")');
    expect(source).toContain('import { mountModuleWorkSectionIsland } from "../components/shell/moduleWorkSectionIsland";');
    expect(source).not.toContain('void import("../components/shell/moduleWorkSectionIsland")');
    expect(source).not.toContain('void import("../components/shell/quickActionsIsland")');
    expect(source).not.toContain('import { mountQuickActionsIsland } from "../components/shell/quickActionsIsland";');
    expect(source).toContain('import { mountSkillEditorIsland } from "../components/tools-skills/skillEditorIsland";');
    expect(source).not.toContain('void import("../components/tools-skills/skillEditorIsland")');
    expect(source).toContain('import { mountWorkspaceBrowserIsland } from "../components/workspace/workspaceBrowserIsland";');
    expect(source).not.toContain('void import("../components/workspace/workspaceBrowserIsland")');
  });
});
