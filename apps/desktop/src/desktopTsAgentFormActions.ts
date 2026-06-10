import type { AgentUiForm } from "./agentUiEvents";

export type DesktopTsAgentFormAction = "submit" | "cancel";

export type DesktopTsAgentFormRequest = {
  values?: Record<string, unknown>;
  correlation?: Record<string, unknown>;
};

export type DesktopTsAgentFormSubmissionInput = {
  sessionId: string;
  formId: string;
  values: Record<string, unknown>;
  action: "submitted" | "cancelled";
};

export function buildDesktopTsAgentFormSubmissionInput(
  form: AgentUiForm,
  request: DesktopTsAgentFormRequest,
  action: DesktopTsAgentFormAction,
  fallbackSessionId = "",
): DesktopTsAgentFormSubmissionInput {
  const sessionId = stringValue(request.correlation?.session_id) ||
    stringValue(form.correlation?.session_id) ||
    fallbackSessionId;
  if (!sessionId) {
    throw new Error("TS agent form submission requires a session id.");
  }
  return {
    sessionId,
    formId: form.form_id,
    values: request.values ?? {},
    action: action === "cancel" ? "cancelled" : "submitted",
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
