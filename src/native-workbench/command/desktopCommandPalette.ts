import { DESKTOP_MENU_COMMANDS, type DesktopMenuCommandId } from "./desktopCommandNavigation";
import { focusDesktopEntity, type DesktopWorkbenchEntityModule } from "../shell/desktopEntityFocus";
import { resolveDesktopNavigationTarget } from "../shell/desktopNavigation";
import { buildDesktopCommandPaletteUx } from "../native/desktopNativeUx";
import type { DesktopCommandEntry } from "../shell/desktopSharedModels";
import type { NativeChatSession } from "../chat/nativeChat";
import { mountCommandPaletteResultsIsland } from "../components/shared/commandPaletteResultsIsland";

export type DesktopCommandPaletteGroupId =
  | "commands"
  | "sessions";

export type DesktopCommandPaletteDestinationModule =
  | "command"
  | DesktopWorkbenchEntityModule;

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
  actions: DesktopCommandPaletteResultAction[];
}

export interface DesktopCommandPaletteResultAction {
  id: string;
  label: string;
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
  ranking?: DesktopCommandPaletteRankingContext;
}

export interface DesktopCommandPaletteRankingContext {
  activeModule?: DesktopWorkbenchEntityModule;
  recentEntityIds?: string[];
}

export interface DesktopCommandPaletteInput {
  desktopCommands?: DesktopCommandEntry[];
  sessions?: LoadedRows<NativeChatSession>;
  workspaceFiles?: LoadedRows<unknown>;
  knowledgeDocuments?: LoadedRows<unknown>;
  tools?: LoadedRows<unknown>;
  skills?: LoadedRows<unknown>;
  coworkSessions?: LoadedRows<unknown>;
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

export function createDesktopCommandPaletteState(
  input: DesktopCommandPaletteInput = {},
  ranking: DesktopCommandPaletteRankingContext = {},
): DesktopCommandPaletteState {
  const commandResults = commandResultsFromInput(input.desktopCommands);
  const resultGroups: Array<[DesktopCommandPaletteGroupId, string, LoadedRows<unknown>, DesktopCommandPaletteResult[]]> = [
    ["commands", "Commands", { loaded: true, rows: DESKTOP_MENU_COMMANDS }, commandResults],
    ["sessions", "Sessions", input.sessions ?? unloaded(), sessionResults(input.sessions?.rows ?? [])],
  ];

  return {
    groups: resultGroups.map(([id, label, source, results]) => ({
      id,
      label,
      loaded: source.loaded,
      count: source.loaded ? results.length : 0,
    })),
    results: resultGroups.flatMap(([, , source, results]) => source.loaded ? results : []),
    ranking,
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
  const matches = state.results
    .filter((result) => tokens.every((token) => searchableText(result).includes(token)))
    .slice(0, limit);
  if (!state.ranking?.activeModule && !state.ranking?.recentEntityIds?.length) {
    return matches;
  }
  const ranked = buildDesktopCommandPaletteUx({
    query,
    results: matches.map((result) => ({
      id: result.id,
      groupId: result.groupId,
      title: result.title,
      keywords: result.keywords,
      updatedAt: state.ranking?.recentEntityIds?.includes(result.destination.entityId ?? result.id.split(":").slice(1).join(":")) ? "recent" : "",
      activeModule: result.destination.module === state.ranking?.activeModule,
    })),
  });
  const order = new Map(ranked.results.map((result, index) => [result.id, index]));
  return [...matches].sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0)).slice(0, limit);
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

  let focused = false;
  if (result.destination.module !== "command") {
    focused = focusDesktopEntity(targetDocument, {
      module: result.destination.module as DesktopWorkbenchEntityModule,
      entityId: result.destination.entityId,
    });
  }
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
    actions: paletteActions("commands"),
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
    actions: paletteActions("commands"),
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
    return { module: "chat", entityId, href: `/chat/${entityId}` };
  }
  return { module: "command" };
}

function moduleForDesktopCommandHref(href: string): DesktopCommandPaletteDestinationModule {
  if (href.startsWith("/files")) {
    return "files";
  }
  if (href.startsWith("/tools")) {
    return "tools";
  }
  if (href.startsWith("/cowork")) {
    return "cowork";
  }
  if (href.startsWith("/knowledge")) {
    return "knowledge";
  }
  if (href.startsWith("/chat")) {
    return "chat";
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

function renderPalette(targetDocument: Document, state: DesktopCommandPaletteState, query: string): void {
  const results = targetDocument.querySelector<HTMLElement>("#desktop-command-palette-results");
  if (!results) {
    return;
  }
  const matches = buildDesktopCommandPaletteResults(state, query);
  mountCommandPaletteResultsIsland(results, { results: matches });
  const loaded = state.groups.filter((group) => group.loaded).map((group) => `${group.label} ${group.count}`).join(" / ");
  const unloaded = state.groups.filter((group) => !group.loaded).map((group) => group.label).join(", ");
  setPaletteStatus(targetDocument, query ? `${matches.length} result(s). ${loaded}` : `Type to search. ${loaded}${unloaded ? `. Not loaded: ${unloaded}.` : "."}`);
}

function sessionResults(rows: NativeChatSession[]): DesktopCommandPaletteResult[] {
  return rows.map((session) => ({
    id: `session:${session.key}`,
    groupId: "sessions",
    group: "Sessions",
    title: session.title || "New session",
    secondary: session.updatedAt || session.chatId || session.key,
    keywords: [session.key, session.chatId],
    destination: { module: "chat", entityId: session.chatId || session.key, href: session.chatId ? `/chat/${session.chatId}` : "/chat" },
    actions: paletteActions("sessions"),
  }));
}

function paletteActions(groupId: DesktopCommandPaletteGroupId): DesktopCommandPaletteResultAction[] {
  void groupId;
  return [
    { id: "open", label: "Open" },
    { id: "focus", label: "Focus" },
  ];
}

function commandKeywords(id: DesktopMenuCommandId): string[] {
  switch (id) {
    case "open-chat":
      return ["chat", "conversation", "sessions"];
    case "open-tinybot-repo":
      return ["github", "repo", "repository"];
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
    case "open-safe-mode":
      return ["safe mode", "browser compatible", "root webui", "recovery"];
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
    default:
      return [];
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

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
