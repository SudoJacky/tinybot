import { DESKTOP_MENU_COMMANDS, type DesktopMenuCommandId } from "./desktopCommandNavigation";
import { resolveDesktopNavigationTarget } from "./desktopNavigation";
import type { DesktopCommandEntry } from "./desktopSharedModels";
import type { NativeChatSession } from "./nativeChat";
import type { DesktopCoworkSessionRow } from "./desktopCowork";
import type { DesktopKnowledgeDocumentRow } from "./desktopKnowledgeTraceability";
import type { DesktopSkillRow, DesktopToolRow } from "./desktopToolsSkills";
import type { DesktopWorkspaceFileRow } from "./desktopWorkspaceFiles";

export type DesktopCommandPaletteGroupId =
  | "commands"
  | "sessions"
  | "workspaceFiles"
  | "knowledgeDocuments"
  | "tools"
  | "skills"
  | "coworkSessions";

export type DesktopCommandPaletteDestinationModule =
  | "command"
  | "sessions"
  | "workspace"
  | "knowledge"
  | "tools"
  | "skills"
  | "cowork";

export interface DesktopCommandPaletteDestination {
  module: DesktopCommandPaletteDestinationModule;
  commandId?: DesktopMenuCommandId;
  entityId?: string;
  href?: string;
}

export interface DesktopCommandPaletteResult {
  id: string;
  groupId: DesktopCommandPaletteGroupId;
  group: string;
  title: string;
  secondary: string;
  keywords: string[];
  destination: DesktopCommandPaletteDestination;
}

export interface DesktopCommandPaletteGroupState {
  id: DesktopCommandPaletteGroupId;
  label: string;
  loaded: boolean;
  count: number;
}

export interface DesktopCommandPaletteState {
  groups: DesktopCommandPaletteGroupState[];
  results: DesktopCommandPaletteResult[];
}

export interface DesktopCommandPaletteInput {
  desktopCommands?: DesktopCommandEntry[];
  sessions?: LoadedRows<NativeChatSession>;
  workspaceFiles?: LoadedRows<DesktopWorkspaceFileRow>;
  knowledgeDocuments?: LoadedRows<DesktopKnowledgeDocumentRow>;
  tools?: LoadedRows<DesktopToolRow>;
  skills?: LoadedRows<DesktopSkillRow>;
  coworkSessions?: LoadedRows<DesktopCoworkSessionRow>;
}

export interface InstallDesktopCommandPaletteOptions {
  gatewayOrigin?: string;
  targetDocument?: Document;
  targetWindow?: Window;
  desktopCommands?: DesktopCommandEntry[];
  loadData?: () => Promise<DesktopCommandPaletteInput>;
}

export interface ActivateDesktopCommandPaletteResultOptions {
  gatewayOrigin: string;
  targetDocument?: Document;
  targetWindow?: Window;
}

interface LoadedRows<T> {
  loaded: boolean;
  rows: T[];
}

const OPEN_PALETTE_EVENT = "tinybot:open-command-palette";

export function createDesktopCommandPaletteState(input: DesktopCommandPaletteInput = {}): DesktopCommandPaletteState {
  const commandResults = commandResultsFromInput(input.desktopCommands);
  const resultGroups: Array<[DesktopCommandPaletteGroupId, string, LoadedRows<unknown>, DesktopCommandPaletteResult[]]> = [
    ["commands", "Commands", { loaded: true, rows: DESKTOP_MENU_COMMANDS }, commandResults],
    ["sessions", "Sessions", input.sessions ?? unloaded(), sessionResults(input.sessions?.rows ?? [])],
    ["workspaceFiles", "Workspace files", input.workspaceFiles ?? unloaded(), workspaceResults(input.workspaceFiles?.rows ?? [])],
    ["knowledgeDocuments", "Knowledge documents", input.knowledgeDocuments ?? unloaded(), knowledgeResults(input.knowledgeDocuments?.rows ?? [])],
    ["tools", "Tools", input.tools ?? unloaded(), toolResults(input.tools?.rows ?? [])],
    ["skills", "Skills", input.skills ?? unloaded(), skillResults(input.skills?.rows ?? [])],
    ["coworkSessions", "Cowork sessions", input.coworkSessions ?? unloaded(), coworkResults(input.coworkSessions?.rows ?? [])],
  ];

  return {
    groups: resultGroups.map(([id, label, source, results]) => ({
      id,
      label,
      loaded: source.loaded,
      count: source.loaded ? results.length : 0,
    })),
    results: resultGroups.flatMap(([, , source, results]) => source.loaded ? results : []),
  };
}

export function buildDesktopCommandPaletteResults(
  state: DesktopCommandPaletteState,
  query: string,
  limit = 40,
): DesktopCommandPaletteResult[] {
  const tokens = normalizeQuery(query);
  if (!tokens.length) {
    return state.results.slice(0, limit);
  }
  return state.results
    .filter((result) => tokens.every((token) => searchableText(result).includes(token)))
    .slice(0, limit);
}

export function openDesktopCommandPalette(targetDocument: Document = document, query = ""): void {
  targetDocument.dispatchEvent(new CustomEvent(OPEN_PALETTE_EVENT, { detail: { query } }));
}

export function activateDesktopCommandPaletteResult(
  result: DesktopCommandPaletteResult,
  {
    gatewayOrigin,
    targetDocument = document,
    targetWindow = window,
  }: ActivateDesktopCommandPaletteResultOptions,
): void {
  if (result.destination.module === "command" && result.destination.commandId) {
    targetDocument.dispatchEvent(new CustomEvent("desktop-menu-command", { detail: { id: result.destination.commandId } }));
    setPaletteFeedback(targetDocument, `Command ${result.title}`);
    return;
  }

  if (result.destination.href) {
    routePaletteNavigation(result.destination.href, { gatewayOrigin, targetDocument, targetWindow });
  }

  const focused = focusPaletteDestination(targetDocument, result.destination);
  targetDocument.dispatchEvent(new CustomEvent("tinybot:desktop-palette-activate", { detail: result.destination }));
  setPaletteFeedback(targetDocument, `${focused ? "Focused" : "Open"} ${result.group}: ${result.title}`);
}

export function installDesktopCommandPalette({
  gatewayOrigin = "",
  targetDocument = document,
  targetWindow = window,
  desktopCommands = [],
  loadData = async () => ({}),
}: InstallDesktopCommandPaletteOptions = {}): void {
  const palette = targetDocument.querySelector<HTMLElement>("#desktop-command-palette");
  const input = targetDocument.querySelector<HTMLInputElement>("#desktop-command-palette-input");
  const close = targetDocument.querySelector<HTMLButtonElement>("#desktop-command-palette-close");
  const results = targetDocument.querySelector<HTMLElement>("#desktop-command-palette-results");
  if (!palette || !input) {
    return;
  }
  const paletteInput = input;

  let state = createDesktopCommandPaletteState({ desktopCommands });
  let previousFocus: HTMLElement | null = null;
  renderPalette(targetDocument, state, "");

  targetDocument.addEventListener(OPEN_PALETTE_EVENT, (event) => {
    const activeElement = targetDocument.activeElement;
    previousFocus = activeElement && "focus" in activeElement ? activeElement as HTMLElement : null;
    const query = (event as CustomEvent<{ query?: unknown }>).detail?.query;
    if (typeof query === "string") {
      paletteInput.value = query;
      renderPalette(targetDocument, state, query);
    }
    palette.hidden = false;
    paletteInput.focus();
    void refreshPaletteData();
  });
  paletteInput.addEventListener("input", () => renderPalette(targetDocument, state, paletteInput.value));
  results?.addEventListener("click", (event) => {
    const eventTarget = event.target as { closest?: (selector: string) => HTMLElement | null } | null;
    const target = typeof eventTarget?.closest === "function" ? eventTarget.closest("[data-palette-result-id]") : null;
    const result = state.results.find((item) => item.id === target?.dataset.paletteResultId);
    if (!result) {
      return;
    }
    activateDesktopCommandPaletteResult(result, { gatewayOrigin, targetDocument, targetWindow });
    closePalette();
  });
  close?.addEventListener("click", () => {
    closePalette();
  });
  targetDocument.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !palette.hidden) {
      closePalette();
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !palette.hidden && targetDocument.activeElement === paletteInput) {
      const [firstResult] = buildDesktopCommandPaletteResults(state, paletteInput.value, 1);
      if (firstResult) {
        activateDesktopCommandPaletteResult(firstResult, { gatewayOrigin, targetDocument, targetWindow });
        closePalette();
      }
      event.preventDefault();
      return;
    }
    if (event.key === "ArrowDown" && !palette.hidden && targetDocument.activeElement === paletteInput) {
      const firstButton = results?.querySelector<HTMLElement>("[data-palette-result-id]");
      firstButton?.focus();
      event.preventDefault();
    }
  });

  function closePalette(): void {
    palette!.hidden = true;
    previousFocus?.focus();
    previousFocus = null;
  }

  async function refreshPaletteData(): Promise<void> {
    setPaletteStatus(targetDocument, "Loading command palette data.");
    try {
      const loadedData = await loadData();
      state = createDesktopCommandPaletteState({
        ...loadedData,
        desktopCommands: loadedData.desktopCommands ?? desktopCommands,
      });
      renderPalette(targetDocument, state, paletteInput.value);
    } catch (error) {
      state = createDesktopCommandPaletteState({ desktopCommands });
      renderPalette(targetDocument, state, paletteInput.value);
      setPaletteStatus(targetDocument, `Command palette data unavailable: ${stringifyError(error)}`);
    }
  }
}

function commandResultsFromInput(desktopCommands: DesktopCommandEntry[] | undefined): DesktopCommandPaletteResult[] {
  if (!desktopCommands?.length) {
    return menuCommandResults(DESKTOP_MENU_COMMANDS);
  }

  const representedCommands = new Set(desktopCommands.map((entry) => entry.commandId).filter(Boolean));
  return [
    ...desktopCommands.map(desktopCommandEntryResult),
    ...menuCommandResults(DESKTOP_MENU_COMMANDS.filter((command) => !representedCommands.has(command.id))),
  ];
}

function menuCommandResults(commands: typeof DESKTOP_MENU_COMMANDS): DesktopCommandPaletteResult[] {
  return commands.map((command) => ({
    id: `command:${command.id}`,
    groupId: "commands",
    group: "Commands",
    title: command.label,
    secondary: command.shortcut,
    keywords: ["command", command.id, command.shortcut, ...commandKeywords(command.id)],
    destination: { module: "command", commandId: command.id },
  }));
}

function desktopCommandEntryResult(entry: DesktopCommandEntry): DesktopCommandPaletteResult {
  return {
    id: entry.id,
    groupId: "commands",
    group: entry.group,
    title: entry.title,
    secondary: entry.href ?? entry.commandId ?? "",
    keywords: [...entry.keywords, entry.commandId ? commandKeywords(entry.commandId).join(" ") : ""],
    destination: desktopCommandEntryDestination(entry),
  };
}

function desktopCommandEntryDestination(entry: DesktopCommandEntry): DesktopCommandPaletteDestination {
  if (entry.commandId) {
    return { module: "command", commandId: entry.commandId };
  }
  if (entry.href) {
    return { module: moduleForDesktopCommandHref(entry.href), href: entry.href };
  }
  if (entry.id.startsWith("sidebar:session:")) {
    const entityId = entry.id.replace(/^sidebar:session:/, "");
    return { module: "sessions", entityId, href: `/chat/${entityId}` };
  }
  return { module: "command" };
}

function moduleForDesktopCommandHref(href: string): DesktopCommandPaletteDestinationModule {
  if (href.startsWith("/tools")) {
    return "tools";
  }
  if (href.startsWith("/cowork")) {
    return "cowork";
  }
  if (href.startsWith("/workspace")) {
    return "workspace";
  }
  if (href.startsWith("/knowledge")) {
    return "knowledge";
  }
  if (href.startsWith("/chat")) {
    return "sessions";
  }
  return "command";
}

function routePaletteNavigation(
  href: string,
  {
    gatewayOrigin,
    targetDocument,
    targetWindow,
  }: {
    gatewayOrigin: string;
    targetDocument: Document;
    targetWindow: Window;
  },
): void {
  const target = resolveDesktopNavigationTarget(href, {
    desktopOrigin: targetWindow.location.origin,
    gatewayOrigin,
  });
  targetDocument.documentElement.dataset.desktopNavigationKind = target.kind;
  targetDocument.documentElement.dataset.desktopNavigationHref = target.href;
  if (target.kind === "internal-docs") {
    targetWindow.location.assign(target.href);
    return;
  }
  if (target.kind === "workbench-route") {
    targetWindow.history.pushState({ tinybotDesktopRoute: target.href }, "", target.href);
    targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-route", { detail: target }));
    return;
  }
  if (target.kind === "gateway-action") {
    targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-gateway-action", { detail: target }));
  }
}

function focusPaletteDestination(targetDocument: Document, destination: DesktopCommandPaletteDestination): boolean {
  if (!destination.entityId) {
    return false;
  }
  targetDocument.documentElement.dataset.desktopPaletteFocusModule = destination.module;
  targetDocument.documentElement.dataset.desktopPaletteFocusEntity = destination.entityId;
  const target = focusSelectorsFor(destination)
    .map((selector) => targetDocument.querySelector<HTMLElement>(selector))
    .find((element): element is HTMLElement => Boolean(element));
  if (!target) {
    return false;
  }
  target.focus();
  targetDocument.documentElement.dataset.desktopPaletteFocused = "true";
  return true;
}

function focusSelectorsFor(destination: DesktopCommandPaletteDestination): string[] {
  const entity = destination.entityId ? selectorValue(destination.entityId) : "";
  const generic = `[data-desktop-entity-module="${selectorValue(destination.module)}"][data-desktop-entity-id="${entity}"]`;
  switch (destination.module) {
    case "workspace":
      return [generic, `[data-desktop-workspace-file="${entity}"]`];
    case "sessions":
      return [generic, `[data-session-key="${entity}"]`];
    case "cowork":
      return [generic, `[data-cowork-session="${entity}"]`];
    default:
      return [generic];
  }
}

function renderPalette(targetDocument: Document, state: DesktopCommandPaletteState, query: string): void {
  const results = targetDocument.querySelector<HTMLElement>("#desktop-command-palette-results");
  if (!results) {
    return;
  }
  results.textContent = "";
  const matches = buildDesktopCommandPaletteResults(state, query);
  if (!matches.length) {
    const empty = targetDocument.createElement("p");
    empty.className = "desktop-command-palette-empty";
    empty.textContent = "No command palette matches.";
    results.append(empty);
  } else {
    for (const [index, match] of matches.entries()) {
      results.append(createResultButton(targetDocument, match, index === 0));
    }
  }
  const loaded = state.groups.filter((group) => group.loaded).map((group) => `${group.label} ${group.count}`).join(" / ");
  const unloaded = state.groups.filter((group) => !group.loaded).map((group) => group.label).join(", ");
  setPaletteStatus(targetDocument, query ? `${matches.length} result(s). ${loaded}` : `Type to search. ${loaded}${unloaded ? `. Not loaded: ${unloaded}.` : "."}`);
}

function createResultButton(targetDocument: Document, result: DesktopCommandPaletteResult, selected: boolean): HTMLElement {
  const button = targetDocument.createElement("button");
  button.type = "button";
  button.className = "desktop-command-palette-result";
  button.setAttribute("aria-selected", String(selected));
  button.setAttribute("data-palette-result-id", result.id);
  button.setAttribute("data-palette-module", result.destination.module);
  if (result.destination.commandId) {
    button.setAttribute("data-palette-command", result.destination.commandId);
  }
  button.setAttribute("data-palette-group", result.groupId);
  if (result.destination.entityId) {
    button.setAttribute("data-palette-entity", result.destination.entityId);
  }
  if (result.destination.href) {
    button.setAttribute("data-palette-href", result.destination.href);
  }
  const title = targetDocument.createElement("strong");
  title.textContent = result.title;
  const meta = targetDocument.createElement("span");
  meta.textContent = [result.group, result.secondary].filter(Boolean).join(" / ");
  button.append(title, meta);
  return button;
}

function sessionResults(rows: NativeChatSession[]): DesktopCommandPaletteResult[] {
  return rows.map((session) => ({
    id: `session:${session.key}`,
    groupId: "sessions",
    group: "Sessions",
    title: session.title || "New session",
    secondary: session.updatedAt || session.chatId || session.key,
    keywords: [session.key, session.chatId],
    destination: { module: "sessions", entityId: session.key, href: session.chatId ? `/chat/${session.chatId}` : "/chat" },
  }));
}

function workspaceResults(rows: DesktopWorkspaceFileRow[]): DesktopCommandPaletteResult[] {
  return rows.map((file) => ({
    id: `workspace:${file.path}`,
    groupId: "workspaceFiles",
    group: "Workspace files",
    title: file.path,
    secondary: file.meta,
    keywords: [file.updatedAt ?? "", file.exists ? "available" : "missing"],
    destination: { module: "workspace", entityId: file.path, href: "/workspace" },
  }));
}

function knowledgeResults(rows: DesktopKnowledgeDocumentRow[]): DesktopCommandPaletteResult[] {
  return rows.map((document) => ({
    id: `knowledge:${document.id || document.path}`,
    groupId: "knowledgeDocuments",
    group: "Knowledge documents",
    title: document.title || document.path,
    secondary: document.meta || document.path,
    keywords: [document.id, document.path, document.category, ...document.tags],
    destination: { module: "knowledge", entityId: document.id || document.path, href: "/knowledge" },
  }));
}

function toolResults(rows: DesktopToolRow[]): DesktopCommandPaletteResult[] {
  return rows.map((tool) => ({
    id: `tool:${tool.name}`,
    groupId: "tools",
    group: "Tools",
    title: tool.displayName || tool.name,
    secondary: tool.meta || tool.description,
    keywords: [tool.name, tool.description, tool.configHint, tool.riskHint],
    destination: { module: "tools", entityId: tool.name, href: "/tools" },
  }));
}

function skillResults(rows: DesktopSkillRow[]): DesktopCommandPaletteResult[] {
  return rows.map((skill) => ({
    id: `skill:${skill.name}`,
    groupId: "skills",
    group: "Skills",
    title: skill.name,
    secondary: skill.meta,
    keywords: [skill.source, skill.status, skill.available ? "available" : "unavailable"],
    destination: { module: "skills", entityId: skill.name, href: "/tools" },
  }));
}

function coworkResults(rows: DesktopCoworkSessionRow[]): DesktopCommandPaletteResult[] {
  return rows.map((session) => ({
    id: `cowork:${session.id}`,
    groupId: "coworkSessions",
    group: "Cowork sessions",
    title: session.title,
    secondary: session.meta,
    keywords: [session.id, session.goal, session.status, session.workflow],
    destination: { module: "cowork", entityId: session.id, href: "/cowork" },
  }));
}

function commandKeywords(id: DesktopMenuCommandId): string[] {
  switch (id) {
    case "open-docs":
      return ["desktop", "docs", "help", "documentation"];
    case "open-shortcut-help":
      return ["desktop", "help", "shortcuts", "keyboard"];
    case "open-page-help":
      return ["desktop", "help", "tour", "page", "regions"];
    case "open-command-palette":
      return ["palette", "quick search"];
    case "refresh-gateway-status":
      return ["gateway", "runtime", "diagnostics", "status"];
    case "search-sessions":
      return ["session", "search"];
    case "open-settings":
      return ["settings", "providers"];
    case "new-chat":
      return ["chat", "session"];
    case "stop-generation":
      return ["stop", "generation", "interrupt"];
    case "toggle-theme":
      return ["theme", "appearance"];
    case "toggle-sidebar":
      return ["sidebar", "layout"];
  }
}

function normalizeQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((token) => token.trim()).filter(Boolean);
}

function searchableText(result: DesktopCommandPaletteResult): string {
  return [result.group, result.title, result.secondary, ...result.keywords].join(" ").toLowerCase();
}

function unloaded<T>(): LoadedRows<T> {
  return { loaded: false, rows: [] };
}

function setPaletteStatus(targetDocument: Document, message: string): void {
  const status = targetDocument.querySelector<HTMLElement>("#desktop-command-palette-status");
  if (status) {
    status.textContent = message;
  }
}

function setPaletteFeedback(targetDocument: Document, message: string): void {
  const routeStatus = targetDocument.querySelector<HTMLElement>("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = message;
  }
  targetDocument.documentElement.dataset.desktopCommandFeedback = message;
}

function selectorValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
