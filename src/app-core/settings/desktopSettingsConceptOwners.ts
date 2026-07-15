import type {
  DesktopSettingsPaneField,
  DesktopSettingsPaneGroup,
  DesktopSettingsPaneModel,
} from "./desktopSettingsProviders";

export type DesktopSettingsConceptRole =
  | "editable-owner"
  | "read-only-summary"
  | "navigation-link"
  | "hidden"
  | "feature-preview";

export interface DesktopSettingsConceptOwner {
  concept: string;
  groupId: DesktopSettingsPaneGroup["id"];
  fieldId?: string;
  role: DesktopSettingsConceptRole;
  ownerGroupId?: DesktopSettingsPaneGroup["id"];
  ownerFieldId?: string;
}

export interface DesktopSettingsConceptOwnerIssue {
  concept: string;
  field?: string;
  code: "missing_group" | "missing_field" | "owner_not_editable" | "preview_is_editable" | "preview_is_navigable";
}

const DESKTOP_SETTINGS_CONCEPT_OWNERS: DesktopSettingsConceptOwner[] = [
  { concept: "default-route", groupId: "general", fieldId: "provider", role: "editable-owner" },
  { concept: "default-model", groupId: "general", fieldId: "model", role: "editable-owner" },
  { concept: "provider-profile", groupId: "provider-models", fieldId: "apiKey", role: "editable-owner" },
  {
    concept: "provider-profile-identity",
    groupId: "provider-models",
    fieldId: "profileId",
    role: "read-only-summary",
    ownerGroupId: "provider-models",
    ownerFieldId: "apiKey",
  },
  { concept: "mcp-servers", groupId: "tools-approvals", fieldId: "mcpServers", role: "editable-owner" },
  { concept: "workspace", groupId: "files-workspace", fieldId: "workspace", role: "editable-owner" },
  { concept: "session-files", groupId: "files-workspace", fieldId: "sessionFiles", role: "read-only-summary" },
  { concept: "channels", groupId: "channels", fieldId: "sendProgress", role: "editable-owner" },
  { concept: "gateway-endpoint", groupId: "gateway-runtime", fieldId: "host", role: "editable-owner" },
  { concept: "diagnostics", groupId: "logs-diagnostics", fieldId: "diagnostics", role: "read-only-summary" },
  { concept: "memory", groupId: "memory-experience", fieldId: "memory", role: "feature-preview" },
  { concept: "skills", groupId: "skills", fieldId: "skills", role: "feature-preview" },
  { concept: "automations", groupId: "automations", fieldId: "automations", role: "feature-preview" },
];

export function getDesktopSettingsConceptOwners(): DesktopSettingsConceptOwner[] {
  return DESKTOP_SETTINGS_CONCEPT_OWNERS.map((owner) => ({ ...owner }));
}

export function validateDesktopSettingsConceptOwners(
  pane: DesktopSettingsPaneModel,
): DesktopSettingsConceptOwnerIssue[] {
  const issues: DesktopSettingsConceptOwnerIssue[] = [];
  for (const owner of DESKTOP_SETTINGS_CONCEPT_OWNERS) {
    const group = pane.groups.find((candidate) => candidate.id === owner.groupId);
    if (!group) {
      issues.push({ concept: owner.concept, code: "missing_group" });
      continue;
    }
    const field = owner.fieldId ? findConceptOwnerField(group, owner.fieldId) : undefined;
    if (owner.fieldId && !field) {
      issues.push({ concept: owner.concept, field: `${owner.groupId}.${owner.fieldId}`, code: "missing_field" });
      continue;
    }
    if (owner.role === "editable-owner" && field && !isEditableOwnerField(field)) {
      issues.push({ concept: owner.concept, field: `${owner.groupId}.${owner.fieldId}`, code: "owner_not_editable" });
    }
    if (owner.role === "feature-preview") {
      if (group.navigationMode !== "preview") {
        issues.push({ concept: owner.concept, code: "preview_is_navigable" });
      }
      for (const previewField of group.fields) {
        if (isEditableOwnerField(previewField)) {
          issues.push({ concept: owner.concept, field: `${group.id}.${previewField.id}`, code: "preview_is_editable" });
        }
      }
    }
  }
  return issues;
}

function findConceptOwnerField(
  group: DesktopSettingsPaneGroup,
  fieldId: string,
): DesktopSettingsPaneField | undefined {
  return group.fields.find((field) => field.id === fieldId);
}

function isEditableOwnerField(field: DesktopSettingsPaneField): boolean {
  return field.sourceKind === "config" && field.control !== "readonly" && field.disabled !== true;
}
