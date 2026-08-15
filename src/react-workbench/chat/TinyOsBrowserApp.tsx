import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronLeft, ChevronRight, Circle, Globe2, Plus, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { TinyOsKernelSnapshot } from "../../app-core/chat/tinyOsKernelModel";
import type { TinyOsWindowRect } from "../../app-core/chat/tinyOsUiState";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";

export type TinyOsBrowserHandoff = {
  browserSessionId: string;
  ownerSessionId: string;
};

export function TinyOsBrowserApp({ browserRuntime, kernel, onHandoffComplete, surfaceLayout, surfaceVisible }: {
  browserRuntime?: NativeBrowserRuntimeApi;
  kernel?: TinyOsKernelSnapshot;
  onHandoffComplete: (input: TinyOsBrowserHandoff) => void;
  surfaceLayout?: TinyOsWindowRect;
  surfaceVisible: boolean;
}) {
  const { t } = useTranslation("tinyos");
  const session = kernel?.browserSessions[0];
  const [selectedTabId, setSelectedTabId] = useState(session?.activeTabId);
  const activeTabId = session?.tabs.some(({ tabId }) => tabId === selectedTabId) ? selectedTabId : session?.activeTabId;
  const tab = session?.tabs.find(({ tabId }) => tabId === activeTabId);
  const [address, setAddress] = useState(tab?.url ?? "");
  const [error, setError] = useState("");
  const [handoffCompleting, setHandoffCompleting] = useState(false);
  const liveRuntimeAvailable = Boolean(browserRuntime && session && tab && session.runtimeKind === "windows_webview2");
  const liveSurfaceVisible = liveRuntimeAvailable && surfaceVisible && tab?.rendererLifecycle !== "failed";

  useEffect(() => {
    setSelectedTabId(session?.activeTabId);
  }, [session?.activeTabId, session?.browserSessionId, session?.revision]);
  useEffect(() => {
    setAddress(tab?.url ?? "");
    setError("");
  }, [tab?.tabId, tab?.url]);

  async function execute(operation: () => Promise<unknown>) {
    setError("");
    try {
      await operation();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function activateTab(tabId: string) {
    if (!browserRuntime || !session) return;
    setSelectedTabId(tabId);
    void execute(() => browserRuntime.activateTab(session.browserSessionId, tabId));
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tabId: string) {
    if (!session || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = Math.max(0, session.tabs.findIndex((candidate) => candidate.tabId === tabId));
    const nextIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? session.tabs.length - 1
        : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + session.tabs.length) % session.tabs.length;
    const nextTabId = session.tabs[nextIndex]?.tabId;
    if (nextTabId) activateTab(nextTabId);
  }

  function navigateToAddress() {
    if (!browserRuntime || !session || !tab) return;
    try {
      const destination = normalizeBrowserAddress(address, t);
      setAddress(destination);
      void execute(() => browserRuntime.navigate(session.browserSessionId, tab.tabId, destination));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function retryFailedSession() {
    if (!browserRuntime || !session) return;
    await execute(async () => {
      await browserRuntime.closeSession(session.browserSessionId);
      await browserRuntime.createSession({
        ownerSessionId: session.sessionId,
        persistence: session.profilePersistence ?? "persistent",
        ...(session.profileId ? { profileId: session.profileId } : {}),
      });
    });
  }

  async function completeUserHandoff() {
    if (!browserRuntime || !session) return;
    setError("");
    setHandoffCompleting(true);
    try {
      const latest = await browserRuntime.snapshot(session.browserSessionId);
      if (latest.data.control?.state !== "user_required") {
        throw new Error(t("shell.browser.handoffChanged"));
      }
      await browserRuntime.interact({
        action: { type: "resume" },
        browserSessionId: latest.data.browserSessionId,
        commandId: `browser-handoff-resume-${Date.now().toString(36)}`,
        controlEpoch: latest.data.control.controlEpoch,
        tabId: latest.data.activeTabId,
      });
      onHandoffComplete({
        browserSessionId: latest.data.browserSessionId,
        ownerSessionId: latest.data.sessionId,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHandoffCompleting(false);
    }
  }

  if (!browserRuntime) {
    return <BrowserUnavailable message={t("shell.browser.buildUnavailable")} />;
  }
  if (!session) {
    return <div aria-live="polite" className="tinyos-browser tinyos-browser--starting" role="status"><Globe2 aria-hidden="true" size={24} /><strong>{t("shell.browser.starting")}</strong><span>{t("shell.browser.preparing")}</span></div>;
  }
  if (!liveRuntimeAvailable || !tab) {
    return <BrowserUnavailable message={t("shell.browser.attachFailed")} />;
  }

  const controlCopy = browserControlCopy(session.control?.state, t);
  const insecureHttp = tab.url.startsWith("http://");

  return <div className="tinyos-browser">
    <div aria-label={t("shell.browser.tabs")} className="tinyos-browser__tabs" role="tablist">
      {session.tabs.map((candidate) => {
        const selected = candidate.tabId === tab.tabId;
        const title = browserTabTitle(candidate.title, candidate.url, t);
        return <div className="tinyos-browser__tab" data-selected={selected ? "true" : undefined} key={candidate.tabId} role="presentation">
          <button aria-controls="tinyos-browser-page" aria-selected={selected} id={`tinyos-browser-tab-${candidate.tabId}`} role="tab" tabIndex={selected ? 0 : -1} title={candidate.title || candidate.url} type="button" onClick={() => activateTab(candidate.tabId)} onKeyDown={(event) => handleTabKeyDown(event, candidate.tabId)}>
            {candidate.loading ? <Circle aria-label={t("shell.browser.loading")} className="tinyos-browser__spinner" size={10} /> : <Globe2 aria-hidden="true" size={11} />}<span>{title}</span>
          </button>
          <button aria-label={t("shell.browser.closeTab", { title })} disabled={session.tabs.length <= 1} tabIndex={selected ? 0 : -1} type="button" onClick={() => void execute(() => browserRuntime.closeTab(session.browserSessionId, candidate.tabId))}><X aria-hidden="true" size={11} /></button>
        </div>;
      })}
      <button aria-label={t("shell.browser.newTabAria")} className="tinyos-browser__new-tab" title={t("shell.browser.newTab")} type="button" onClick={() => void execute(() => browserRuntime.createTab(session.browserSessionId))}><Plus aria-hidden="true" size={13} /></button>
    </div>
    <div className="tinyos-browser__bar">
      <button aria-label={t("shell.browser.backAria")} disabled={!(tab.canGoBack ?? Boolean(tab.activeHistoryIndex))} title={t("shell.browser.back")} type="button" onClick={() => void execute(() => browserRuntime.back(session.browserSessionId, tab.tabId))}><ChevronLeft aria-hidden="true" size={15} /></button>
      <button aria-label={t("shell.browser.forwardAria")} disabled={!(tab.canGoForward ?? tab.activeHistoryIndex < tab.history.length - 1)} title={t("shell.browser.forward")} type="button" onClick={() => void execute(() => browserRuntime.forward(session.browserSessionId, tab.tabId))}><ChevronRight aria-hidden="true" size={15} /></button>
      <button aria-label={tab.loading ? t("shell.browser.stopLoading") : t("shell.browser.reloadAria")} title={tab.loading ? t("shell.browser.stop") : t("shell.browser.reload")} type="button" onClick={() => void execute(() => tab.loading ? browserRuntime.stop(session.browserSessionId, tab.tabId) : browserRuntime.reload(session.browserSessionId, tab.tabId))}>{tab.loading ? <X aria-hidden="true" size={13} /> : <RotateCcw aria-hidden="true" size={13} />}</button>
      {insecureHttp ? <AlertTriangle aria-label={t("shell.browser.insecure")} className="tinyos-browser__insecure" size={13} /> : <Globe2 aria-hidden="true" size={13} />}
      <form onSubmit={(event) => { event.preventDefault(); navigateToAddress(); }}>
        <input aria-label={t("shell.browser.address")} autoCapitalize="none" autoCorrect="off" spellCheck={false} value={address} onChange={(event) => setAddress(event.currentTarget.value)} />
        <button disabled={!address.trim()} type="submit">{t("shell.browser.go")}</button>
      </form>
      {controlCopy ? <span aria-live="polite" className="tinyos-browser__control" data-state={session.control?.state}>{controlCopy}</span> : null}
    </div>
    {session.pendingPolicyRequest ? <section aria-label={t("shell.browser.policy")} className="tinyos-browser__policy" role="alert">
      <div><ShieldCheck aria-hidden="true" size={14} /><span><strong>{session.pendingPolicyRequest.kind === "popup" ? t("shell.browser.popup") : t("shell.browser.external")}</strong><code>{session.pendingPolicyRequest.safeUrl}</code></span></div>
      <div><button type="button" onClick={() => void execute(() => browserRuntime.resolvePolicyRequest(session.browserSessionId, session.pendingPolicyRequest!.requestId, false))}>{t("shell.browser.deny")}</button><button type="button" onClick={() => void execute(() => browserRuntime.resolvePolicyRequest(session.browserSessionId, session.pendingPolicyRequest!.requestId, true))}>{t("shell.browser.allowOnce")}</button></div>
    </section> : null}
    {session.control?.state === "user_required" && !session.pendingPolicyRequest ? <section aria-label={t("shell.browser.handoff")} className="tinyos-browser__handoff" role="alert">
      <div><ShieldCheck aria-hidden="true" size={14} /><span><strong>{t("shell.browser.youControl")}</strong><span>{session.control.reason || t("shell.browser.continueUntilReturn")}</span></span></div>
      <button disabled={handoffCompleting} type="button" onClick={() => void completeUserHandoff()}>{handoffCompleting ? t("shell.browser.handingBack") : t("shell.browser.handBack")}</button>
    </section> : null}
    {tab.rendererLifecycle === "failed"
      ? <div className="tinyos-browser__unavailable" role="alert"><AlertTriangle aria-hidden="true" size={22} /><strong>{session.lifecycle === "failed" ? t("shell.browser.failedStart") : t("shell.browser.tabUnresponsive")}</strong><span>{session.control?.reason || (session.lifecycle === "failed" ? t("shell.browser.retrySession") : t("shell.browser.restartSession"))}</span><button type="button" onClick={() => void (session.lifecycle === "failed" ? retryFailedSession() : execute(() => browserRuntime.restartTab(session.browserSessionId, tab.tabId)))}>{session.lifecycle === "failed" ? t("shell.browser.retryBrowser") : t("shell.browser.restartTab")}</button></div>
      : <BrowserSurfaceHost browserRuntime={browserRuntime} onError={setError} session={session} surfaceLayout={surfaceLayout} tabId={tab.tabId} visible={liveSurfaceVisible} />}
    {error ? <p className="tinyos-browser__error" role="alert">{error}</p> : null}
  </div>;
}

function BrowserUnavailable({ message }: { message: string }) {
  const { t } = useTranslation("tinyos");
  return <div className="tinyos-browser tinyos-browser__unavailable" role="alert"><AlertTriangle aria-hidden="true" size={24} /><strong>{t("shell.browser.unavailable")}</strong><span>{message}</span></div>;
}

function browserTabTitle(title: string, url: string, t: TFunction<"tinyos">): string {
  if (title.trim() && title !== "about:blank") return title;
  if (!url || url === "about:blank") return t("shell.browser.newTab");
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

export function normalizeBrowserAddress(value: string, t: TFunction<"tinyos">): string {
  const address = value.trim();
  if (!address) throw new Error(t("shell.browser.enterAddress"));
  if (/^(?:https?:\/\/|about:blank$)/i.test(address)) return address;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)) return `http://${address}`;
  if (!address.includes(" ") && address.includes(".")) return `https://${address}`;
  throw new Error(t("shell.browser.invalidAddress"));
}

function browserControlCopy(state: "idle" | "agent_active" | "user_required" | "interrupted" | "failed" | "recovering" | undefined, t: TFunction<"tinyos">): string {
  switch (state) {
    case "agent_active": return t("shell.browser.control.agentActive");
    case "user_required": return t("shell.browser.control.userRequired");
    case "interrupted": return t("shell.browser.control.interrupted");
    case "failed": return t("shell.browser.control.failed");
    case "recovering": return t("shell.browser.control.recovering");
    default: return "";
  }
}

type BrowserSurfaceUpdateInput = Parameters<NativeBrowserRuntimeApi["updateSurface"]>[0];
const BROWSER_SURFACE_SETTLE_MS = 80;

function sameBrowserSurfaceUpdate(left: BrowserSurfaceUpdateInput | undefined, right: BrowserSurfaceUpdateInput): boolean {
  if (!left) return false;
  return left.browserSessionId === right.browserSessionId
    && left.live === right.live
    && left.rect.deviceScale === right.rect.deviceScale
    && left.rect.height === right.rect.height
    && left.rect.width === right.rect.width
    && left.rect.x === right.rect.x
    && left.rect.y === right.rect.y
    && left.surfaceId === right.surfaceId
    && left.tabId === right.tabId
    && left.topmost === right.topmost
    && left.unobscured === right.unobscured
    && left.visible === right.visible;
}

function sameHiddenBrowserSurfaceTarget(left: BrowserSurfaceUpdateInput | undefined, right: BrowserSurfaceUpdateInput): boolean {
  return Boolean(left
    && !left.visible
    && !right.visible
    && left.browserSessionId === right.browserSessionId
    && left.live === right.live
    && left.surfaceId === right.surfaceId
    && left.tabId === right.tabId);
}

function BrowserSurfaceHost({ browserRuntime, onError, session, surfaceLayout, tabId, visible }: {
  browserRuntime?: NativeBrowserRuntimeApi;
  onError: (message: string) => void;
  session: TinyOsKernelSnapshot["browserSessions"][number];
  surfaceLayout?: TinyOsWindowRect;
  tabId: string;
  visible: boolean;
}) {
  const { t } = useTranslation("tinyos");
  const hostRef = useRef<HTMLDivElement>(null);
  const nativeLayoutRevision = session.surface?.layoutRevision ?? 0;
  const layoutRevision = useRef(nativeLayoutRevision);
  layoutRevision.current = Math.max(layoutRevision.current, nativeLayoutRevision);
  const lastReportedUpdate = useRef<BrowserSurfaceUpdateInput | undefined>(undefined);
  const pendingUpdate = useRef<BrowserSurfaceUpdateInput | undefined>(undefined);
  const updateInFlight = useRef(false);
  const frame = useRef(0);
  const settleTimer = useRef(0);
  const scheduledVisible = useRef(visible);
  const surfaceId = useMemo(() => `tinyos-browser-surface-${session.browserSessionId}`, [session.browserSessionId]);

  const flushUpdate = useCallback(function flushPendingSurfaceUpdate() {
    const input = pendingUpdate.current;
    if (!browserRuntime || updateInFlight.current || !input) return;
    pendingUpdate.current = undefined;
    updateInFlight.current = true;
    void browserRuntime.updateSurface(input).catch((reason) => {
      if (sameBrowserSurfaceUpdate(lastReportedUpdate.current, input)) {
        lastReportedUpdate.current = undefined;
      }
      onError(reason instanceof Error ? reason.message : String(reason));
    }).finally(() => {
      updateInFlight.current = false;
      flushPendingSurfaceUpdate();
    });
  }, [browserRuntime, onError]);

  const report = useCallback((nextVisible: boolean) => {
    const host = hostRef.current;
    if (!host || !browserRuntime) return;
    const bounds = host.getBoundingClientRect();
    const nextUpdate: BrowserSurfaceUpdateInput = {
      browserSessionId: session.browserSessionId,
      layoutRevision: layoutRevision.current + 1,
      live: true,
      rect: {
        deviceScale: window.devicePixelRatio || 1,
        height: Math.max(1, bounds.height),
        width: Math.max(1, bounds.width),
        x: Math.max(0, bounds.x),
        y: Math.max(0, bounds.y),
      },
      surfaceId,
      tabId,
      topmost: nextVisible,
      unobscured: nextVisible,
      visible: nextVisible,
    };
    if (sameBrowserSurfaceUpdate(lastReportedUpdate.current, nextUpdate)
      || sameHiddenBrowserSurfaceTarget(lastReportedUpdate.current, nextUpdate)) return;
    layoutRevision.current = nextUpdate.layoutRevision;
    lastReportedUpdate.current = nextUpdate;
    pendingUpdate.current = nextUpdate;
    flushUpdate();
  }, [browserRuntime, flushUpdate, session.browserSessionId, surfaceId, tabId]);

  const schedule = useCallback((nextVisible: boolean) => {
    scheduledVisible.current = nextVisible;
    window.cancelAnimationFrame(frame.current);
    window.clearTimeout(settleTimer.current);
    const enqueue = () => {
      settleTimer.current = 0;
      frame.current = window.requestAnimationFrame(() => report(scheduledVisible.current));
    };
    if (nextVisible) {
      settleTimer.current = window.setTimeout(enqueue, BROWSER_SURFACE_SETTLE_MS);
    } else {
      enqueue();
    }
  }, [report]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !browserRuntime) return;
    const scheduleCurrent = () => schedule(visible);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleCurrent);
    observer?.observe(host);
    window.addEventListener("resize", scheduleCurrent);
    window.addEventListener("scroll", scheduleCurrent, true);
    return () => {
      window.cancelAnimationFrame(frame.current);
      window.clearTimeout(settleTimer.current);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleCurrent);
      window.removeEventListener("scroll", scheduleCurrent, true);
      report(false);
    };
  }, [browserRuntime, report, schedule, visible]);

  useLayoutEffect(() => {
    schedule(visible);
  }, [schedule, surfaceLayout?.height, surfaceLayout?.width, surfaceLayout?.x, surfaceLayout?.y, visible]);

  return <div aria-label={t("shell.browser.page")} aria-labelledby={`tinyos-browser-tab-${tabId}`} className="tinyos-browser__surface-host" data-live={visible ? "true" : undefined} id="tinyos-browser-page" ref={hostRef} role="tabpanel"><span aria-live="polite">{visible ? t("shell.browser.loadingPage") : t("shell.browser.temporarilyHidden")}</span></div>;
}
