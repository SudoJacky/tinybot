import { describe, expect, test } from "vitest";
import {
  getDesktopSettingsFieldBehaviorMetadata,
  getDesktopSettingsFieldMetadata,
  getDesktopSettingsGroupMetadata,
} from "./desktopSettingsMetadata";

describe("desktop settings metadata", () => {
  test("owns navigation metadata for every settings group", () => {
    expect(getDesktopSettingsGroupMetadata("provider-models")).toMatchObject({
      navigationArea: "core",
      navigationMode: "section",
      i18nKey: "settings.groups.provider-models",
    });
  });

  test("keeps sensitive field metadata out of the pane builder", () => {
    expect(getDesktopSettingsFieldMetadata("provider-models", "apiKey")).toMatchObject({
      sensitive: true,
      i18nKey: "settings.fields.provider-models.apiKey",
    });
    expect(getDesktopSettingsFieldMetadata("general", "unknown")).toBeNull();
  });

  test("projects auto-commit and confirmation policy through one interface", () => {
    expect(getDesktopSettingsFieldBehaviorMetadata("tools-mcp", "execEnable")).toMatchObject({
      commitMode: "auto",
      confirmation: { when: "enable" },
    });
    expect(getDesktopSettingsFieldBehaviorMetadata("general", "model")).toEqual({
      commitMode: "manual",
      confirmation: undefined,
      notice: undefined,
    });
  });
});
