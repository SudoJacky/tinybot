type Tone = "ready" | "warn" | "error" | "muted";

interface RouteIntent {
  href?: string;
  sessionId?: string;
}

export function buildDesktopSafeModeRecoveryUx(input: {
  phase: "starting" | "connecting" | "loading" | "ready" | "failed";
  owner?: "shell" | "external" | "";
  failureType?: "port-conflict" | "command-failed" | "bootstrap-incompatible" | "missing-runtime";
  responseClass?: string;
  routeIntent?: RouteIntent;
}) {
  const failed = input.phase === "failed";
  const completeThrough = failed ? 1 : phaseIndex(input.phase);
  const summary = failed
    ? "Startup failed; choose a recovery action"
    : input.owner === "external"
      ? "Using an existing gateway"
      : input.phase === "ready"
        ? "Tinybot is ready"
        : "Tinybot is starting";
  return {
    summary,
    diagnosticsDefaultOpen: failed,
    progressSteps: [
      progressStep("start", "Starting Tinybot", completeThrough, 0),
      progressStep("connect", "Connecting to local gateway", completeThrough, 1),
      progressStep("workspace", "Loading workspace", completeThrough, 2),
      progressStep("ready", "Ready", completeThrough, 3),
    ],
    recoveryCards: failed ? [recoveryCard(input.failureType ?? "command-failed", input.responseClass)] : [],
    safeModeAction: {
      id: "open-browser-compatible-webui",
      label: "Open native workbench",
      href: safeModeHref(input.routeIntent),
    },
  };
}

export function buildDesktopWorkbenchShellUx(input: {
  activeModule: string;
  selectedEntityId?: string;
  hiddenPanels?: string[];
  attention?: { taskUpdates?: number; references?: number; blocked?: number; failed?: number };
  routeHydrating?: boolean;
  theme?: string;
  language?: string;
}) {
  const moduleLabel = titleCase(input.activeModule);
  return {
    regions: [
      { id: "activity-rail", label: "Activity rail" },
      { id: "module-sidebar", label: "Module sidebar" },
      { id: "main-work", label: "Main work" },
      { id: "inspector", label: "Inspector" },
      { id: "task-center", label: "Task Center" },
    ],
    activeModule: input.activeModule,
    selectedEntityId: input.selectedEntityId ?? "",
    hiddenPanelBadges: attentionBadges(input.attention),
    skeleton: input.routeHydrating ? { id: `${input.activeModule}-skeleton`, label: `Loading ${moduleLabel}` } : null,
    inspectorTabs: ["overview", "tools", "references", "files", "raw"].map((id) => ({ id, label: titleCase(id) })),
    contextualHelp: { href: helpHref(input.activeModule), label: `${moduleLabel} help` },
    preferenceBridge: {
      theme: input.theme ?? "system",
      language: input.language ?? "en-US",
    },
  };
}

export function buildDesktopChatSessionUx(input: {
  sessions?: Array<{ key: string; title: string; pinned?: boolean; status?: string }>;
  attachments?: Array<{ id: string; source: "session" | "knowledge" | "workspace"; title: string }>;
  responding?: boolean;
  scroll?: { distanceFromBottom: number; viewportHeight: number };
  activities?: Array<{ id: string; kind: "tool" | "reference"; label: string }>;
}) {
  const sessions = input.sessions ?? [];
  const runningStatuses = new Set(["running", "streaming", "approval_required", "requires_approval", "blocked", "failed", "interrupted"]);
  const pinned = sessions.filter((session) => session.pinned);
  const running = sessions.filter((session) => !session.pinned && runningStatuses.has((session.status ?? "").toLowerCase()));
  const recent = sessions.filter((session) => !session.pinned && !running.includes(session));
  return {
    starters: [
      { id: "ask", label: "Ask a question", href: "/chat/new" },
      { id: "analyze-file", label: "Analyze a file", href: "/files" },
      { id: "use-knowledge", label: "Use knowledge base", href: "/knowledge" },
      { id: "plan-cowork", label: "Plan multi-step work", href: "/cowork" },
      { id: "edit-workspace-file", label: "Edit workspace file", href: "/workspace" },
    ],
    sessionGroups: [
      { id: "pinned", label: "Pinned", sessions: pinned },
      { id: "running", label: "Running", sessions: running },
      { id: "recent", label: "Recent", sessions: recent },
    ],
    attachmentChips: (input.attachments ?? []).map((attachment) => ({
      ...attachment,
      sourceLabel: fileSourceLabel(attachment.source),
    })),
    stopGeneration: input.responding
      ? { primary: true, label: "Stop generation", disabledReason: "" }
      : { primary: false, label: "Stop generation", disabledReason: "No active response" },
    streaming: {
      keepAnchoredToBottom: (input.scroll?.distanceFromBottom ?? 0) <= Math.max(48, (input.scroll?.viewportHeight ?? 0) * 0.08),
    },
    activityChips: (input.activities ?? []).map((activity) => ({ ...activity, opensInspector: true })),
  };
}

export function buildDesktopTaskCenterAttentionUx(items: Array<{
  id: string;
  state: string;
  source: string;
  title: string;
  actions: Array<{ id: string; label: string }>;
}>) {
  const running = items.filter((item) => item.state === "active").length;
  const blocked = items.filter((item) => item.state === "blocked").length;
  const failed = items.filter((item) => item.state === "failed").length;
  const ordered = [...items].sort((left, right) => stateRank(left.state) - stateRank(right.state));
  return {
    compactLabel: `${running} running \u00b7 ${blocked} blocked \u00b7 ${failed} failed`,
    autoOpenReason: blocked > 0 ? "blocked" : failed > 0 ? "failed" : "",
    rows: ordered.map((item) => ({ ...item, primaryAction: primaryTaskAction(item.state, item.actions) })),
    notificationPolicy: ({ appFocused }: { appFocused: boolean }) => {
      const target = ordered.find((item) => item.state === "blocked" || item.state === "failed");
      return {
        shouldNotify: !appFocused && Boolean(target),
        deepLink: target ? { module: target.source, entityId: target.id } : null,
      };
    },
  };
}

export function buildDesktopCommandPaletteUx(input: {
  platform?: string;
  query?: string;
  results?: Array<{ id: string; groupId: string; title: string; keywords?: string[]; updatedAt?: string; activeModule?: boolean }>;
}) {
  const tokens = (input.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const results = [...(input.results ?? [])]
    .map((result) => ({
      ...result,
      actions: paletteActions(result.groupId),
      score: paletteScore(result, tokens),
    }))
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  return {
    shortcuts: [input.platform === "darwin" ? "Cmd+K" : "Ctrl+K", "Ctrl+Shift+P"],
    results,
    refreshPolicy: { debounceMs: 180, keepCachedResults: true },
  };
}

export function buildDesktopSettingsProviderSetupUx(input: {
  hasUsableProvider?: boolean;
  dirty?: boolean;
  providerSecrets?: Array<{ providerId: string; configured?: boolean; masked?: boolean }>;
  modelDiscovery?: Array<{ providerId: string; status: string; message?: string }>;
}) {
  return {
    firstRun: {
      required: !input.hasUsableProvider,
      steps: ["choose-provider", "enter-key", "test-connection", "pick-default-model", "start-chat"].map((id) => ({ id })),
    },
    intentGroups: [
      ["ai-provider-model", "AI provider and model"],
      ["workspace-files", "Workspace and files"],
      ["knowledge", "Knowledge"],
      ["tools-skills", "Tools and skills"],
      ["gateway-runtime", "Gateway/runtime"],
      ["diagnostics", "Diagnostics"],
      ["advanced", "Advanced"],
    ].map(([id, label], index) => ({ id, label, collapsed: id === "advanced", order: index })),
    secretStates: (input.providerSecrets ?? []).map((secret) => ({
      providerId: secret.providerId,
      label: secret.configured && secret.masked
        ? "Saved key will be reused"
        : secret.configured
          ? "Enter a new key to replace it"
          : "Key missing",
    })),
    modelDiscoveryByProvider: Object.fromEntries((input.modelDiscovery ?? []).map((item) => [item.providerId, item])),
    unsavedBar: {
      visible: Boolean(input.dirty),
      actions: ["Save", "Reset", "Test connection"],
    },
  };
}

export function buildDesktopKnowledgeTraceUx(input: {
  readinessRows?: Array<{ id: string; tone: Tone }>;
  documents?: Array<{ id: string; status?: string; phaseLabel?: string; updatedAt?: string }>;
  selectedResult?: { id: string; docId?: string; entities?: string[]; relations?: string[] };
}) {
  const rows = input.readinessRows ?? [];
  const partial = rows.some((row) => row.tone === "warn" || row.tone === "error" || row.tone === "muted");
  return {
    stages: ["import", "index", "ask", "trace", "use"].map((id) => ({ id, label: titleCase(id) })),
    readinessMessage: partial ? "Knowledge is partially available." : "Knowledge is ready.",
    documentBadges: (input.documents ?? []).map((document) => ({
      id: document.id,
      badges: documentBadges(document),
    })),
    queryActions: ["useInCurrentChat", "openEvidence", "inspectGraph", "rebuildSource"].map((id) => ({ id })),
    graphFocus: {
      rootId: input.selectedResult?.id ?? "",
      docId: input.selectedResult?.docId ?? "",
      entities: input.selectedResult?.entities ?? [],
      relations: input.selectedResult?.relations ?? [],
      expandable: true,
    },
  };
}

export function buildDesktopFileLifecycleUx(input: {
  destination: "session" | "knowledge" | "workspace";
  file?: { name: string; size: number; type?: string };
  workspaceState?: "saved" | "dirty" | "saving" | "conflict" | "failed";
  temporarySessionFile?: boolean;
  operation?: "save" | "export" | "reveal";
}) {
  return {
    destinationCopy: destinationCopy(input.destination),
    validation: validateDesktopUpload(input.file),
    workspaceStatus: workspaceStatus(input.workspaceState ?? "saved"),
    temporaryLifecycleText: input.temporarySessionFile ? "Available to this chat session." : "",
    toast: input.operation ? { operation: input.operation, actions: ["Reveal", "Copy path", "Open folder"] } : null,
  };
}

export function buildDesktopToolsSkillsManagementUx(input: {
  tools?: Array<{ name: string; description?: string; riskHint?: string; enabled?: boolean }>;
  skills?: Array<{ name: string; enabled?: boolean; always?: boolean; available?: boolean; status?: string; deletable?: boolean }>;
}) {
  const tools = input.tools ?? [];
  const skills = input.skills ?? [];
  return {
    conceptCopy: {
      tools: "Tools are capabilities the assistant can call.",
      skills: "Skills are reusable instructions and workflows you manage.",
    },
    toolGroups: toolGroups(tools),
    skillRows: skills.map((skill) => ({
      ...skill,
      badges: skillBadges(skill),
    })),
    editorActions: ["validate", "previewDiff", "exampleInvocation", "dryRun"].map((id) => ({ id })),
    deleteConfirmation: { requiredText: skills.find((skill) => skill.deletable)?.name ?? "" },
  };
}

export function buildDesktopCoworkCockpitUx(input: {
  nativeReady?: boolean;
  selected?: { type: string; id: string };
  session?: { id: string; status?: string; finalDraft?: string };
}) {
  return {
    readiness: {
      mode: input.nativeReady ? "native" : "preview",
      fallbackHref: "/cowork",
    },
    stages: ["goal", "plan", "run", "review-outputs", "finalize"].map((id) => ({ id, label: titleCase(id) })),
    primarySurface: "timeline-task-feed",
    graphFocus: {
      rootId: input.selected?.id ?? input.session?.id ?? "",
      type: input.selected?.type ?? "session",
    },
    confirmations: ["emergencyStopSession", "selectFinalResult", "mergeFinalResult", "deleteSession"].map((action) => ({
      action,
      consequence: "This changes the Cowork session output or execution state.",
    })),
    handoffActions: ["insertSummaryIntoChat", "saveFinalDraftToWorkspace", "exportTrace", "createFollowUpTask"].map((id) => ({ id })),
  };
}

export function buildDesktopLoadingPerformanceUx(input: {
  route?: string;
  longListCounts?: { sessions?: number; knowledgeDocuments?: number; taskRows?: number; coworkTraces?: number };
}) {
  const counts = input.longListCounts ?? {};
  return {
    immediate: ["startup-shell", "chat-shell", "composer", "session-list-metadata", "task-center-shell", "command-palette-shell"],
    lazy: ["knowledge-graph", "cowork-cockpit", "provider-model-discovery", "tools-skills-editor", "docs-pages", "3d-graph-rendering"],
    routeHydration: {
      skeleton: `${titleCase(input.route ?? "route")} skeleton`,
      keepStaleData: true,
    },
    virtualization: {
      sessions: { enabled: (counts.sessions ?? 0) > 80 },
      knowledgeDocuments: { enabled: (counts.knowledgeDocuments ?? 0) > 80 },
      taskRows: { enabled: (counts.taskRows ?? 0) > 60 },
      coworkTraces: { enabled: (counts.coworkTraces ?? 0) > 80 },
    },
    memoizedProjections: ["run-chain-items", "task-center-items", "command-palette-data"],
    refreshPolicy: { commandPaletteDebounceMs: 180, idlePrefetch: true },
    measurements: [
      "first-usable-composer",
      "first-session-list",
      "command-palette-open-latency",
      "streaming-frame-drops",
      "route-hydration-time",
      "graph-memory-after-open",
    ].map((id) => ({ id })),
  };
}

function progressStep(id: string, label: string, completeThrough: number, index: number) {
  return {
    id,
    label,
    state: completeThrough > index ? "complete" : completeThrough === index ? "current" : "pending",
  };
}

function phaseIndex(phase: string): number {
  if (phase === "ready") return 4;
  if (phase === "loading") return 2;
  if (phase === "connecting") return 1;
  return 0;
}

function recoveryCard(failureType: string, responseClass = "") {
  const cards: Record<string, { title: string; primaryAction: string; hint: string }> = {
    "port-conflict": {
      title: "Port already in use",
      primaryAction: "Use existing gateway",
      hint: "A local process is already listening on the gateway port.",
    },
    "command-failed": {
      title: "Gateway command failed",
      primaryAction: "Copy diagnostics",
      hint: "The gateway command exited before Tinybot could load.",
    },
    "bootstrap-incompatible": {
      title: "Bootstrap incompatible",
      primaryAction: "Open native workbench",
      hint: `The local gateway responded${responseClass ? ` with ${responseClass}` : ""}, but not with the WebUI bootstrap shape this desktop build expects.`,
    },
    "missing-runtime": {
      title: "Missing runtime dependency",
      primaryAction: "Show setup steps",
      hint: "A required local runtime dependency is unavailable.",
    },
  };
  return { id: failureType, ...(cards[failureType] ?? cards["command-failed"]) };
}

function safeModeHref(routeIntent?: RouteIntent): string {
  const params = new URLSearchParams();
  if (routeIntent?.href) {
    params.set("route", routeIntent.href);
  }
  if (routeIntent?.sessionId) {
    params.set("session", routeIntent.sessionId);
  }
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

function attentionBadges(attention: { taskUpdates?: number; references?: number; blocked?: number; failed?: number } = {}) {
  return [
    attention.taskUpdates ? { id: "task-updates", label: `${attention.taskUpdates} task updates` } : null,
    attention.references ? { id: "references", label: `${attention.references} reference selected` } : null,
    attention.blocked ? { id: "blocked", label: `${attention.blocked} blocked` } : null,
    attention.failed ? { id: "failed", label: `${attention.failed} failed` } : null,
  ].filter((badge): badge is { id: string; label: string } => Boolean(badge));
}

function helpHref(moduleId: string): string {
  const routes: Record<string, string> = {
    knowledge: "/docs/knowledge",
    workspace: "/docs/webui",
    files: "/docs/webui",
    cowork: "/docs/tasks",
    chat: "/docs/quickstart",
  };
  return routes[moduleId] ?? "/docs";
}

function fileSourceLabel(source: string): string {
  if (source === "session") return "session file";
  if (source === "knowledge") return "knowledge document";
  return "workspace file";
}

function stateRank(state: string): number {
  return state === "blocked" ? 0 : state === "failed" ? 1 : state === "active" ? 2 : state === "canceled" ? 3 : 4;
}

function primaryTaskAction(state: string, actions: Array<{ id: string; label: string }>) {
  const preferred = state === "blocked"
    ? ["approveOnce", "deny", "open"]
    : state === "failed"
      ? ["retry", "copyDiagnostics", "open"]
      : state === "active"
        ? ["cancel", "open"]
        : ["open", "dismiss"];
  return preferred.map((id) => actions.find((action) => action.id === id)).find(Boolean) ?? actions[0] ?? null;
}

function paletteActions(groupId: string) {
  const base = [{ id: "open", label: "Open" }, { id: "focus", label: "Focus" }];
  if (groupId === "knowledgeDocuments") {
    return [...base, { id: "inspect", label: "Inspect" }, { id: "useInChat", label: "Use in chat" }];
  }
  if (groupId === "workspaceFiles") {
    return [...base, { id: "reveal", label: "Reveal" }];
  }
  return base;
}

function paletteScore(
  result: { title: string; keywords?: string[]; updatedAt?: string; activeModule?: boolean },
  tokens: string[],
): number {
  const text = [result.title, ...(result.keywords ?? [])].join(" ").toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (result.title.toLowerCase() === token) score += 100;
    if (result.title.toLowerCase().includes(token)) score += 20;
    if (text.includes(token)) score += 10;
  }
  if (result.activeModule) score += 25;
  if (result.updatedAt) score += 5;
  return score;
}

function documentBadges(document: { status?: string; phaseLabel?: string }) {
  const status = (document.status ?? "").toLowerCase();
  const badges: string[] = [];
  if (document.phaseLabel) {
    badges.push(document.phaseLabel);
  } else if (status === "indexed") {
    badges.push("Indexed");
  }
  if (["stale", "needs_rebuild", "failed"].includes(status)) {
    badges.push(status === "failed" ? "Failed" : "Needs rebuild");
  }
  return badges;
}

function destinationCopy(destination: string): string {
  if (destination === "session") return "Attach to this conversation";
  if (destination === "knowledge") return "Import and index for retrieval";
  return "Open or save as workspace file";
}

function validateDesktopUpload(file?: { name: string; size: number; type?: string }) {
  if (!file) {
    return { accepted: true, reason: "" };
  }
  const maxSize = 25 * 1024 * 1024;
  if (file.size > maxSize) {
    return { accepted: false, reason: "File size exceeds the desktop upload limit." };
  }
  if (file.type === "application/octet-stream" && !/\.(txt|md|json|csv|pdf)$/i.test(file.name)) {
    return { accepted: false, reason: "File type is not supported for this destination." };
  }
  return { accepted: true, reason: "" };
}

function workspaceStatus(state: "saved" | "dirty" | "saving" | "conflict" | "failed") {
  const labels = {
    saved: "Saved",
    dirty: "Unsaved changes",
    saving: "Saving...",
    conflict: "Conflict detected",
    failed: "Save failed",
  };
  return {
    label: labels[state],
    actions: state === "conflict" ? ["Keep mine", "Reload theirs", "Compare changes"] : [],
  };
}

function toolGroups(tools: Array<{ name: string; description?: string; riskHint?: string }>) {
  const groups = [
    { id: "web", tools: [] as typeof tools },
    { id: "files", tools: [] as typeof tools },
    { id: "execution", tools: [] as typeof tools },
    { id: "knowledge", tools: [] as typeof tools },
    { id: "workspace", tools: [] as typeof tools },
    { id: "requires-approval", tools: [] as typeof tools },
    { id: "other", tools: [] as typeof tools },
  ];
  for (const tool of tools) {
    const text = `${tool.name} ${tool.description ?? ""} ${tool.riskHint ?? ""}`.toLowerCase();
    if (text.includes("approval")) groups.find((group) => group.id === "requires-approval")?.tools.push(tool);
    if (text.includes("exec") || text.includes("command") || text.includes("shell")) groups.find((group) => group.id === "execution")?.tools.push(tool);
    else if (text.includes("web") || text.includes("browser")) groups.find((group) => group.id === "web")?.tools.push(tool);
    else if (text.includes("file")) groups.find((group) => group.id === "files")?.tools.push(tool);
    else if (text.includes("knowledge")) groups.find((group) => group.id === "knowledge")?.tools.push(tool);
    else if (text.includes("workspace")) groups.find((group) => group.id === "workspace")?.tools.push(tool);
    else groups.find((group) => group.id === "other")?.tools.push(tool);
  }
  return groups;
}

function skillBadges(skill: { enabled?: boolean; always?: boolean; available?: boolean; status?: string }) {
  const badges: string[] = [];
  if (skill.enabled) badges.push("Enabled");
  if (skill.always) badges.push("Always on");
  if (skill.available === false) badges.push("Unavailable");
  if ((skill.status ?? "").toLowerCase().includes("validation")) badges.push("Needs validation");
  return badges;
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
