import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Globe2,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  TinyOsNativeBrowserSession,
  TinyOsNativeSnapshot,
} from "../../app-core/chat/tinyOsNativeSnapshot";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import type { SidecarBrowserTab } from "./sidecarModel";
import "./SidecarBrowser.css";

type BrowserSnapshot = TinyOsNativeSnapshot<TinyOsNativeBrowserSession>;

export type SidecarBrowserProps = {
  browserRuntime?: NativeBrowserRuntimeApi;
  externalError?: string;
  onHandoffComplete: () => void | Promise<void>;
  onRetryProvision: () => void;
  onSnapshot: (snapshot: BrowserSnapshot) => void;
  snapshot?: BrowserSnapshot;
  surfaceVisible: boolean;
  tab: SidecarBrowserTab;
};

export function SidecarBrowser({
  browserRuntime,
  externalError = "",
  onHandoffComplete,
  onRetryProvision,
  onSnapshot,
  snapshot,
  surfaceVisible,
  tab: resource,
}: SidecarBrowserProps) {
  const { t } = useTranslation("chat");
  const session = snapshot && snapshot.data.browserSessionId === resource.browserSessionId
    ? snapshot.data
    : undefined;
  const tab = session?.tabs.find((candidate) => candidate.tabId === resource.nativeTabId);
  const [address, setAddress] = useState(tab?.url ?? "");
  const [error, setError] = useState("");
  const [handoffCompleting, setHandoffCompleting] = useState(false);
  const liveRuntimeAvailable = Boolean(
    browserRuntime
      && session
      && tab
      && session.runtimeKind === "windows_webview2",
  );
  const liveSurfaceVisible = Boolean(
    liveRuntimeAvailable
      && surfaceVisible
      && tab?.rendererLifecycle !== "failed"
      && !error
      && !externalError,
  );

  useEffect(() => {
    setAddress(tab?.url ?? "");
    setError("");
  }, [tab?.tabId, tab?.url]);

  async function execute(operation: () => Promise<BrowserSnapshot | void>) {
    setError("");
    try {
      const result = await operation();
      if (result) onSnapshot(result);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  function navigateToAddress() {
    if (!browserRuntime || !session || !tab) return;
    try {
      const destination = normalizeBrowserAddress(
        address,
        t("sidecar.browserEnterAddress"),
        t("sidecar.browserInvalidAddress"),
      );
      setAddress(destination);
      void execute(() => browserRuntime.navigate(session.browserSessionId, tab.tabId, destination));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function retryFailedSession() {
    if (!browserRuntime || !session) return;
    await execute(async () => {
      await browserRuntime.closeSession(session.browserSessionId);
      return browserRuntime.createSession({
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
        throw new Error(t("sidecar.browserHandoffChanged"));
      }
      await browserRuntime.interact({
        action: { type: "resume" },
        browserSessionId: latest.data.browserSessionId,
        commandId: `browser-handoff-resume-${Date.now().toString(36)}`,
        controlEpoch: latest.data.control.controlEpoch,
        tabId: latest.data.activeTabId,
      });
      await onHandoffComplete();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setHandoffCompleting(false);
    }
  }

  if (!browserRuntime) {
    return <BrowserUnavailable message={t("sidecar.browserBuildUnavailable")} />;
  }
  if (externalError) {
    return <BrowserUnavailable message={externalError} onRetry={onRetryProvision} />;
  }
  if (!resource.browserSessionId || !resource.nativeTabId || !session) {
    return (
      <div aria-live="polite" className="react-sidecar-browser-state" role="status">
        <Globe2 aria-hidden="true" size={24} />
        <strong>{t("sidecar.browserStarting")}</strong>
        <span>{t("sidecar.browserPreparing")}</span>
      </div>
    );
  }
  if (!liveRuntimeAvailable || !tab) {
    return <BrowserUnavailable message={t("sidecar.browserAttachFailed")} />;
  }

  const controlCopy = browserControlCopy(session.control?.state, t);
  const insecureHttp = tab.url.startsWith("http://");

  return (
    <div className="react-sidecar-browser-runtime">
      <div className="react-sidecar-browser-bar">
        <button
          aria-label={t("sidecar.browserBack")}
          disabled={!(tab.canGoBack ?? Boolean(tab.activeHistoryIndex))}
          title={t("sidecar.browserBack")}
          type="button"
          onClick={() => void execute(() => browserRuntime.back(session.browserSessionId, tab.tabId))}
        >
          <ChevronLeft aria-hidden="true" size={16} />
        </button>
        <button
          aria-label={t("sidecar.browserForward")}
          disabled={!(tab.canGoForward ?? tab.activeHistoryIndex < tab.history.length - 1)}
          title={t("sidecar.browserForward")}
          type="button"
          onClick={() => void execute(() => browserRuntime.forward(session.browserSessionId, tab.tabId))}
        >
          <ChevronRight aria-hidden="true" size={16} />
        </button>
        <button
          aria-label={tab.loading ? t("sidecar.browserStop") : t("sidecar.browserReload")}
          title={tab.loading ? t("sidecar.browserStop") : t("sidecar.browserReload")}
          type="button"
          onClick={() => void execute(() => (
            tab.loading
              ? browserRuntime.stop(session.browserSessionId, tab.tabId)
              : browserRuntime.reload(session.browserSessionId, tab.tabId)
          ))}
        >
          {tab.loading ? <X aria-hidden="true" size={14} /> : <RotateCcw aria-hidden="true" size={14} />}
        </button>
        {insecureHttp
          ? <AlertTriangle aria-label={t("sidecar.browserInsecure")} className="react-sidecar-browser-bar__insecure" size={14} />
          : <Globe2 aria-hidden="true" size={14} />}
        <form onSubmit={(event) => { event.preventDefault(); navigateToAddress(); }}>
          <input
            aria-label={t("sidecar.browserAddress")}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={address}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <button disabled={!address.trim()} type="submit">{t("sidecar.browserGo")}</button>
        </form>
        {controlCopy ? (
          <span aria-live="polite" className="react-sidecar-browser-bar__control" data-state={session.control?.state}>
            {controlCopy}
          </span>
        ) : null}
      </div>

      {session.pendingPolicyRequest ? (
        <section aria-label={t("sidecar.browserPolicy")} className="react-sidecar-browser-notice" role="alert">
          <div>
            <ShieldCheck aria-hidden="true" size={15} />
            <span>
              <strong>{session.pendingPolicyRequest.kind === "popup" ? t("sidecar.browserPopup") : t("sidecar.browserExternal")}</strong>
              <code>{session.pendingPolicyRequest.safeUrl}</code>
            </span>
          </div>
          <div>
            <button type="button" onClick={() => void execute(() => browserRuntime.resolvePolicyRequest(session.browserSessionId, session.pendingPolicyRequest!.requestId, false))}>
              {t("sidecar.browserDeny")}
            </button>
            <button type="button" onClick={() => void execute(() => browserRuntime.resolvePolicyRequest(session.browserSessionId, session.pendingPolicyRequest!.requestId, true))}>
              {t("sidecar.browserAllowOnce")}
            </button>
          </div>
        </section>
      ) : null}

      {session.control?.state === "user_required" && !session.pendingPolicyRequest ? (
        <section aria-label={t("sidecar.browserHandoff")} className="react-sidecar-browser-notice" role="alert">
          <div>
            <ShieldCheck aria-hidden="true" size={15} />
            <span>
              <strong>{t("sidecar.browserYouControl")}</strong>
              <span>{session.control.reason || t("sidecar.browserContinueUntilReturn")}</span>
            </span>
          </div>
          <button disabled={handoffCompleting} type="button" onClick={() => void completeUserHandoff()}>
            {handoffCompleting ? t("sidecar.browserHandingBack") : t("sidecar.browserHandBack")}
          </button>
        </section>
      ) : null}

      {tab.rendererLifecycle === "failed" ? (
        <div className="react-sidecar-browser-state" role="alert">
          <AlertTriangle aria-hidden="true" size={24} />
          <strong>{session.lifecycle === "failed" ? t("sidecar.browserFailedStart") : t("sidecar.browserTabUnresponsive")}</strong>
          <span>{session.control?.reason || t("sidecar.browserRestartDescription")}</span>
          <button
            type="button"
            onClick={() => void (session.lifecycle === "failed"
              ? retryFailedSession()
              : execute(() => browserRuntime.restartTab(session.browserSessionId, tab.tabId)))}
          >
            {session.lifecycle === "failed" ? t("sidecar.browserRetry") : t("sidecar.browserRestartTab")}
          </button>
        </div>
      ) : (
        <BrowserSurfaceHost
          browserRuntime={browserRuntime}
          onError={setError}
          onSnapshot={onSnapshot}
          session={session}
          tabId={tab.tabId}
          visible={liveSurfaceVisible}
        />
      )}
      {error ? <p className="react-sidecar-browser-error" role="alert">{error}</p> : null}
    </div>
  );
}

function BrowserUnavailable({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation("chat");
  return (
    <div className="react-sidecar-browser-state" role="alert">
      <AlertTriangle aria-hidden="true" size={24} />
      <strong>{t("sidecar.browserUnavailable")}</strong>
      <span>{message}</span>
      {onRetry ? <button type="button" onClick={onRetry}>{t("sidecar.browserRetry")}</button> : null}
    </div>
  );
}

export function normalizeBrowserAddress(value: string, emptyMessage: string, invalidMessage: string): string {
  const address = value.trim();
  if (!address) throw new Error(emptyMessage);
  if (/^(?:https?:\/\/|about:blank$)/i.test(address)) return address;
  if (/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(address)) return `http://${address}`;
  if (!address.includes(" ") && address.includes(".")) return `https://${address}`;
  throw new Error(invalidMessage);
}

function browserControlCopy(
  state: "idle" | "agent_active" | "user_required" | "interrupted" | "failed" | "recovering" | undefined,
  t: TFunction<"chat">,
): string {
  switch (state) {
    case "agent_active": return t("sidecar.browserAgentActive");
    case "user_required": return t("sidecar.browserUserRequired");
    case "interrupted": return t("sidecar.browserInterrupted");
    case "failed": return t("sidecar.browserControlFailed");
    case "recovering": return t("sidecar.browserRecovering");
    default: return "";
  }
}

type BrowserSurfaceUpdateInput = Parameters<NativeBrowserRuntimeApi["updateSurface"]>[0];
const BROWSER_SURFACE_SETTLE_MS = 80;

function sameBrowserSurfaceUpdate(
  left: BrowserSurfaceUpdateInput | undefined,
  right: BrowserSurfaceUpdateInput,
): boolean {
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

function sameHiddenBrowserSurfaceTarget(
  left: BrowserSurfaceUpdateInput | undefined,
  right: BrowserSurfaceUpdateInput,
): boolean {
  return Boolean(left
    && !left.visible
    && !right.visible
    && left.browserSessionId === right.browserSessionId
    && left.live === right.live
    && left.surfaceId === right.surfaceId
    && left.tabId === right.tabId);
}

function BrowserSurfaceHost({
  browserRuntime,
  onError,
  onSnapshot,
  session,
  tabId,
  visible,
}: {
  browserRuntime: NativeBrowserRuntimeApi;
  onError: (message: string) => void;
  onSnapshot: (snapshot: BrowserSnapshot) => void;
  session: TinyOsNativeBrowserSession;
  tabId: string;
  visible: boolean;
}) {
  const { t } = useTranslation("chat");
  const hostRef = useRef<HTMLDivElement>(null);
  const layoutRevision = useRef(session.surface?.layoutRevision ?? 0);
  layoutRevision.current = Math.max(layoutRevision.current, session.surface?.layoutRevision ?? 0);
  const lastReportedUpdate = useRef<BrowserSurfaceUpdateInput | undefined>(undefined);
  const pendingUpdate = useRef<BrowserSurfaceUpdateInput | undefined>(undefined);
  const updateInFlight = useRef(false);
  const frame = useRef(0);
  const settleTimer = useRef(0);
  const scheduledVisible = useRef(visible);
  const surfaceId = useMemo(() => `sidecar-browser-surface-${session.browserSessionId}`, [session.browserSessionId]);

  const flushUpdate = useCallback(function flushPendingSurfaceUpdate() {
    const input = pendingUpdate.current;
    if (updateInFlight.current || !input) return;
    pendingUpdate.current = undefined;
    updateInFlight.current = true;
    void browserRuntime.updateSurface(input).then(onSnapshot).catch((reason) => {
      if (sameBrowserSurfaceUpdate(lastReportedUpdate.current, input)) {
        lastReportedUpdate.current = undefined;
      }
      onError(errorMessage(reason));
    }).finally(() => {
      updateInFlight.current = false;
      flushPendingSurfaceUpdate();
    });
  }, [browserRuntime, onError, onSnapshot]);

  const report = useCallback((nextVisible: boolean) => {
    const host = hostRef.current;
    if (!host) return;
    const bounds = host.getBoundingClientRect();
    const show = nextVisible && document.visibilityState !== "hidden";
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
      topmost: show,
      unobscured: show,
      visible: show,
    };
    if (sameBrowserSurfaceUpdate(lastReportedUpdate.current, nextUpdate)
      || sameHiddenBrowserSurfaceTarget(lastReportedUpdate.current, nextUpdate)) return;
    layoutRevision.current = nextUpdate.layoutRevision;
    lastReportedUpdate.current = nextUpdate;
    pendingUpdate.current = nextUpdate;
    flushUpdate();
  }, [flushUpdate, session.browserSessionId, surfaceId, tabId]);

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
    if (!host) return;
    const scheduleCurrent = () => schedule(visible);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(scheduleCurrent);
    observer?.observe(host);
    window.addEventListener("resize", scheduleCurrent);
    window.addEventListener("scroll", scheduleCurrent, true);
    document.addEventListener("visibilitychange", scheduleCurrent);
    return () => {
      window.cancelAnimationFrame(frame.current);
      window.clearTimeout(settleTimer.current);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleCurrent);
      window.removeEventListener("scroll", scheduleCurrent, true);
      document.removeEventListener("visibilitychange", scheduleCurrent);
      report(false);
    };
  }, [report, schedule, visible]);

  useLayoutEffect(() => {
    schedule(visible);
  }, [schedule, visible]);

  return (
    <div
      aria-label={t("sidecar.browserPage")}
      className="react-sidecar-browser-surface"
      data-live={visible ? "true" : undefined}
      ref={hostRef}
      role="document"
    >
      <span aria-live="polite">
        {visible ? t("sidecar.browserLoadingPage") : t("sidecar.browserTemporarilyHidden")}
      </span>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
