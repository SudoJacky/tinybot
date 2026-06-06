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
});
