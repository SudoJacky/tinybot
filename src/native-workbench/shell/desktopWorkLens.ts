import type {
  DesktopTaskActionId,
  DesktopTaskCenterItem,
  DesktopTaskDestination,
  DesktopTaskSource,
  DesktopTaskState,
} from "../tasks/desktopTaskCenter";

export type DesktopWorkLensMode = "ready" | "fallback";
export type DesktopWorkLensKind = "chatRun" | "knowledgeJob" | "coworkRun" | "unsupported";
export type DesktopWorkLensSectionId = "happening" | "used" | "changed" | "next";
export type DesktopWorkLensRelatedResourceKind =
  | "file"
  | "evidence"
  | "tool"
  | "log"
  | "artifact"
  | "provider"
  | "coworkEntity"
  | "diagnostic";
export type DesktopWorkLensActionId =
  | "retry"
  | "cancel"
  | "resume"
  | "open"
  | "inspect"
  | "rebuild"
  | "copyDiagnostics"
  | "dismiss";
type DesktopWorkLensTaskActionId = Extract<DesktopWorkLensActionId, DesktopTaskActionId>;
export type DesktopWorkLensFallbackReason = "no-selection" | "unsupported-source" | "missing-context" | "projection-failed";

export interface DesktopWorkLensRelatedResourceInput {
  kind: DesktopWorkLensRelatedResourceKind;
  id: string;
  title: string;
  detail?: string;
  route: DesktopTaskDestination;
}

export interface DesktopWorkLensRelatedResource {
  kind: DesktopWorkLensRelatedResourceKind;
  id: string;
  title: string;
  detail: string;
  route: DesktopTaskDestination;
}

export interface DesktopWorkLensNextAction {
  id: DesktopWorkLensActionId;
  label: string;
  route?: DesktopTaskDestination;
  diagnosticText?: string;
}

export interface DesktopWorkLensSection {
  id: DesktopWorkLensSectionId;
  title: string;
  rows: Array<{ label: string; value: string }>;
}

export interface DesktopWorkLensProjectionInput {
  task?: DesktopTaskCenterItem | null;
  resources?: DesktopWorkLensRelatedResourceInput[];
  outputs?: DesktopWorkLensRelatedResourceInput[];
  fallbackReason?: DesktopWorkLensFallbackReason;
}

export interface DesktopWorkLensProjection {
  mode: DesktopWorkLensMode;
  kind: DesktopWorkLensKind;
  id: string;
  title: string;
  state: DesktopTaskState | "unsupported";
  stateReason: string;
  canonicalRoute: DesktopTaskDestination | null;
  fallbackReason: DesktopWorkLensFallbackReason | "";
  relatedResources: DesktopWorkLensRelatedResource[];
  outputs: DesktopWorkLensRelatedResource[];
  nextActions: DesktopWorkLensNextAction[];
  sections: DesktopWorkLensSection[];
}

const SUPPORTED_WORK_SOURCES: Partial<Record<DesktopTaskSource, DesktopWorkLensKind>> = {
  chat: "chatRun",
  knowledge: "knowledgeJob",
  cowork: "coworkRun",
};

const ACTION_LABELS: Record<DesktopWorkLensActionId, string> = {
  retry: "Retry",
  cancel: "Cancel",
  resume: "Resume",
  open: "Open",
  inspect: "Inspect",
  rebuild: "Rebuild",
  copyDiagnostics: "Copy diagnostics",
  dismiss: "Dismiss",
};

export function buildDesktopWorkLensProjection({
  task,
  resources,
  outputs,
  fallbackReason = "no-selection",
}: DesktopWorkLensProjectionInput): DesktopWorkLensProjection {
  if (!task) {
    return fallbackProjection({
      fallbackReason,
      title: "No running work selected",
      canonicalRoute: null,
      nextActions: [],
    });
  }

  const kind = SUPPORTED_WORK_SOURCES[task.source];
  const relatedResources = normalizeResources(resources ?? task.relatedResources);
  const outputResources = normalizeResources(outputs ?? task.outputs);
  if (!kind) {
    return fallbackProjection({
      fallbackReason: "unsupported-source",
      title: task.title,
      canonicalRoute: task.destination,
      nextActions: fallbackActions(task),
    });
  }

  const nextActions: DesktopWorkLensNextAction[] = task.actions.flatMap((action) => {
    if (action.id === "dismiss" || !isDesktopWorkLensTaskActionId(action.id)) {
      return [];
    }
    return [{
      id: action.id,
      label: ACTION_LABELS[action.id],
      route: action.id === "open" || action.id === "inspect" ? task.destination : undefined,
      diagnosticText: action.id === "copyDiagnostics" ? task.diagnostics : undefined,
    }];
  });

  return {
    mode: "ready",
    kind,
    id: task.id,
    title: task.title,
    state: task.state,
    stateReason: task.detail,
    canonicalRoute: task.destination,
    fallbackReason: "",
    relatedResources,
    outputs: outputResources,
    nextActions,
    sections: buildSections(task, relatedResources, outputResources, nextActions),
  };
}

function fallbackProjection({
  fallbackReason,
  title,
  canonicalRoute,
  nextActions,
}: {
  fallbackReason: DesktopWorkLensFallbackReason;
  title: string;
  canonicalRoute: DesktopTaskDestination | null;
  nextActions: DesktopWorkLensNextAction[];
}): DesktopWorkLensProjection {
  return {
    mode: "fallback",
    kind: "unsupported",
    id: "",
    title,
    state: "unsupported",
    stateReason: "",
    canonicalRoute,
    fallbackReason,
    relatedResources: [],
    outputs: [],
    nextActions,
    sections: [],
  };
}

function fallbackActions(task: DesktopTaskCenterItem): DesktopWorkLensNextAction[] {
  return task.actions
    .filter((action) => action.id === "open")
    .map(() => ({
      id: "open",
      label: ACTION_LABELS.open,
      route: task.destination,
    }));
}

function isDesktopWorkLensTaskActionId(action: DesktopTaskActionId): action is DesktopWorkLensTaskActionId {
  return Object.prototype.hasOwnProperty.call(ACTION_LABELS, action);
}

function normalizeResources(resources: DesktopWorkLensRelatedResourceInput[]): DesktopWorkLensRelatedResource[] {
  return resources
    .filter((resource) => resource.id.trim() && resource.title.trim())
    .map((resource) => ({
      kind: resource.kind,
      id: resource.id,
      title: resource.title,
      detail: resource.detail ?? "",
      route: resource.route,
    }));
}

function buildSections(
  task: DesktopTaskCenterItem,
  relatedResources: DesktopWorkLensRelatedResource[],
  outputs: DesktopWorkLensRelatedResource[],
  nextActions: DesktopWorkLensNextAction[],
): DesktopWorkLensSection[] {
  return [
    {
      id: "happening",
      title: "What is happening?",
      rows: compactRows([
        ["State", task.state],
        ["Status", task.status],
        ["Reason", task.detail],
        ["Progress", task.progressLabel],
      ]),
    },
    {
      id: "used",
      title: "What did it use?",
      rows: relatedResources.map((resource) => ({
        label: resourceKindLabel(resource.kind),
        value: [resource.title, resource.detail].filter(Boolean).join(" / "),
      })),
    },
    {
      id: "changed",
      title: "What changed?",
      rows: outputs.map((output) => ({
        label: resourceKindLabel(output.kind),
        value: [output.title, output.detail].filter(Boolean).join(" / "),
      })),
    },
    {
      id: "next",
      title: "What can I do next?",
      rows: nextActions.map((action) => ({
        label: action.label,
        value: action.route?.href ?? action.diagnosticText ?? "",
      })),
    },
  ];
}

function compactRows(rows: Array<[string, string]>): Array<{ label: string; value: string }> {
  return rows
    .filter(([, value]) => value.trim())
    .map(([label, value]) => ({ label, value }));
}

function resourceKindLabel(kind: DesktopWorkLensRelatedResourceKind): string {
  switch (kind) {
    case "coworkEntity":
      return "Cowork entity";
    default:
      return kind.charAt(0).toUpperCase() + kind.slice(1);
  }
}
