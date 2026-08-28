import {
  createNativeBrowserSessionSnapshot,
  type NativeBrowserSession,
  type NativeBrowserSnapshot,
} from "./nativeBrowserSnapshot";

export type NativeBrowserCapabilityDecision = {
  available: boolean;
  reason?: string;
  reasonCode?: string;
};

export type NativeBrowserRuntimeCapabilities = {
  agentInteraction: NativeBrowserCapabilityDecision;
  directInput: NativeBrowserCapabilityDecision;
  downloads: NativeBrowserCapabilityDecision;
  incognitoProfiles: NativeBrowserCapabilityDecision;
  persistentProfiles: NativeBrowserCapabilityDecision;
  popups: NativeBrowserCapabilityDecision;
  realCapture: NativeBrowserCapabilityDecision;
  runtimeKind: string;
  runtimeVersion: string;
  schemaVersion: "tinybot.browser_runtime_capabilities.v1";
  semanticObservation: NativeBrowserCapabilityDecision;
  sessionSnapshot: NativeBrowserCapabilityDecision;
  uploads: NativeBrowserCapabilityDecision;
};

export type NativeBrowserAction =
  | { type: "navigate"; url: string }
  | { type: "back" | "forward" | "reload" | "stop" | "resume" }
  | { type: "click"; x: number; y: number }
  | { type: "clickTarget"; targetRef: string }
  | { type: "type"; text: string }
  | { type: "fill"; targetRef: string; text: string }
  | { type: "key"; key: string }
  | { type: "scroll"; deltaX: number; deltaY: number }
  | { type: "wait"; targetRef?: string; text?: string; timeoutMs: number }
  | { type: "userHandoff"; reason: string };

export type NativeBrowserRuntimeApi = {
  activateTab(browserSessionId: string, tabId: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  back(browserSessionId: string, tabId: string): Promise<void>;
  capabilities(): Promise<NativeBrowserRuntimeCapabilities>;
  closeSession(browserSessionId: string): Promise<void>;
  closeTab(browserSessionId: string, tabId: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  createSession(input: { initialUrl?: string; ownerSessionId: string; persistence?: "persistent" | "incognito"; profileId?: string }): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  createTab(browserSessionId: string, url?: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  deleteProfile(profileId: string): Promise<void>;
  forward(browserSessionId: string, tabId: string): Promise<void>;
  interact(input: {
    action: NativeBrowserAction;
    browserSessionId: string;
    captureId?: string;
    commandId: string;
    controlEpoch: number;
    observationRevision?: number;
    tabId: string;
  }): Promise<unknown>;
  navigate(browserSessionId: string, tabId: string, url: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  observe(input: { browserSessionId: string; capture?: boolean; semantic?: boolean; tabId: string }): Promise<{ snapshot: NativeBrowserSnapshot<NativeBrowserSession> }>;
  reload(browserSessionId: string, tabId: string): Promise<void>;
  resolvePolicyRequest(browserSessionId: string, requestId: string, approved: boolean): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  restartTab(browserSessionId: string, tabId: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  snapshot(browserSessionId: string): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
  stop(browserSessionId: string, tabId: string): Promise<void>;
  updateSurface(input: {
    browserSessionId: string;
    layoutRevision: number;
    live: boolean;
    rect: { deviceScale: number; height: number; width: number; x: number; y: number };
    surfaceId: string;
    tabId: string;
    topmost: boolean;
    unobscured: boolean;
    visible: boolean;
  }): Promise<NativeBrowserSnapshot<NativeBrowserSession>>;
};

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function createDesktopNativeBrowserApi(options: { invoke: Invoke }): NativeBrowserRuntimeApi {
  const invokeInput = <T>(command: string, input?: unknown): Promise<T> => options.invoke<T>(command, input === undefined ? undefined : { input });
  const session = async (command: string, input: unknown) => normalizeNativeBrowserSnapshot(await invokeInput<unknown>(command, input));
  const target = (browserSessionId: string, tabId: string) => ({ browserSessionId, tabId });
  return {
    activateTab: (browserSessionId, tabId) => session("browser_activate_tab", target(browserSessionId, tabId)),
    back: (browserSessionId, tabId) => invokeInput("browser_back", target(browserSessionId, tabId)),
    capabilities: () => options.invoke("browser_capabilities"),
    closeSession: (browserSessionId) => invokeInput("browser_close_session", { browserSessionId }),
    closeTab: (browserSessionId, tabId) => session("browser_close_tab", target(browserSessionId, tabId)),
    createSession: (input) => session("browser_create_session", { persistence: "persistent", ...input }),
    createTab: (browserSessionId, url) => session("browser_create_tab", { browserSessionId, ...(url ? { url } : {}) }),
    deleteProfile: (profileId) => invokeInput("browser_delete_profile", { profileId }),
    forward: (browserSessionId, tabId) => invokeInput("browser_forward", target(browserSessionId, tabId)),
    interact: (input) => invokeInput("browser_interact", input),
    navigate: (browserSessionId, tabId, url) => session("browser_navigate", { browserSessionId, tabId, url }),
    observe: async (input) => {
      const value = await invokeInput<{ snapshot: unknown }>("browser_observe", input);
      return { ...value, snapshot: normalizeNativeBrowserSnapshot(value.snapshot) };
    },
    reload: (browserSessionId, tabId) => invokeInput("browser_reload", target(browserSessionId, tabId)),
    resolvePolicyRequest: (browserSessionId, requestId, approved) => session("browser_resolve_policy_request", { approved, browserSessionId, requestId }),
    restartTab: (browserSessionId, tabId) => session("browser_restart_tab", target(browserSessionId, tabId)),
    snapshot: (browserSessionId) => session("browser_snapshot", { browserSessionId }),
    stop: (browserSessionId, tabId) => invokeInput("browser_stop", target(browserSessionId, tabId)),
    updateSurface: (input) => session("browser_update_surface", input),
  };
}

export function normalizeNativeBrowserSnapshot(value: unknown): NativeBrowserSnapshot<NativeBrowserSession> {
  if (!isRecord(value) || !isRecord(value.data)) throw new Error("Native browser snapshot must be an object.");
  const data = value.data as unknown as NativeBrowserSession;
  return createNativeBrowserSessionSnapshot(data, {
    observedAt: requiredString(value.observedAt, "Native browser observedAt"),
    revision: typeof value.revision === "number" || typeof value.revision === "string" ? value.revision : 0,
    sourceId: requiredString(value.sourceId, "Native browser sourceId"),
  });
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
