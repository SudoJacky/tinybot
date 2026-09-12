import { lazy, Suspense, useCallback, useEffect, useImperativeHandle, useMemo, useReducer, useRef, useState, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { ChatStore, SessionSummary, WorkspaceStore } from "../services";
import type { ArtifactRef, LoadedArtifactDetail } from "../../app-core/chat/chatTurnContracts";
import type { OfficeArtifactSource, SpreadsheetCellChangeRequest } from "../../app-core/chat/officeArtifact";
import { resolveCodeArtifactLanguage } from "../../app-core/chat/codeArtifact";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import type { NativeBrowserSnapshot, NativeBrowserSession } from "../../app-core/native/nativeBrowserSnapshot";
import { officeContentReference } from "../../app-core/chat/officeContentReference";
import { projectLoadedArtifactDetail } from "../../app-core/chat/chatProjection";
import { logRendererEvent } from "../../app-core/native/rendererLogger";
import { AssistantFileLinkError, assistantFileArtifact, assistantFileLinkTitle, resolveAssistantFileLink, type AssistantFileLink } from "../chat/assistantFileLinks";
import { sessionWorkspaceName } from "../chat/sessionWorkspaces";
import { useArtifactFile } from "../chat/useArtifactFile";
import { DataViewCard } from "../chat/DataViewCard";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";
import { ArtifactReviewPanel } from "./ArtifactReviewPanel";
import { DelimitedTextPreview } from "./DelimitedTextPreview";
import { artifactDelimiter } from "./delimitedText";
import { OfficeArtifactPreview } from "./OfficeArtifactPreview";
import { ImageArtifactPreview } from "./ImageArtifactPreview";
import { CodeArtifactPreview } from "./CodeArtifactPreview";
import { Sidecar } from "./Sidecar";
import { SidecarBrowser } from "./SidecarBrowser";
import { useSidecarBrowserState } from "./useSidecarBrowserState";
import { activeSidecarTab, createInitialSidecarState, DEFAULT_SIDECAR_WORKSPACE_ID, readPersistedSidecarWidth, reduceSidecarState,
  sidecarArtifactTabId, visibleSidecarTabs, writePersistedSidecarWidth, type SidecarArtifactTab, type SidecarBrowserTab, type SidecarTab, type SidecarTerminalTab, type SidecarState } from "./sidecarModel";

export type SidecarLayout = Pick<SidecarState, "presentation" | "layoutMotion" | "width">;
export function initialSidecarLayout(): SidecarLayout {
  const { presentation, layoutMotion, width } = createInitialSidecarState(readPersistedSidecarWidth(window.localStorage));
  return { presentation, layoutMotion, width };
}
export type SidecarResourcesHandle = {
  finishBrowserAnnotation(): Promise<void>;
  toggle(): void;
  openArtifact(artifact: ArtifactRef): Promise<void>;
  openFileLink(link: AssistantFileLink): Promise<void>;
};
type Props = {
  ref?: Ref<SidecarResourcesHandle>;
  activeSession?: SessionSummary;
  activeDisplaySession?: SessionSummary;
  activeSessionId: string;
  chatStore: ChatStore;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes" | "artifactReviews">;
  artifactReviewEpoch: number;
  sessionResponding: boolean;
  onLayoutChange(layout: SidecarLayout): void;
  onHide(): void;
  onReference(reference: AgentInputReference & { id: string }): void;
  onAskForSpreadsheetChange(artifact: ArtifactRef, request: SpreadsheetCellChangeRequest, revision?: string): void;
  onHandoff(sessionId: string): Promise<void>;
  onError(error: string): void;
};

type ArtifactSidecarContent = {
  localFile?: boolean;
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
  notice?: string;
  office?: OfficeArtifactSource;
};

type BrowserSnapshot = NativeBrowserSnapshot<NativeBrowserSession>;

const LazySidecarTerminal = lazy(async () => {
  const module = await import("./SidecarTerminal");
  return { default: module.SidecarTerminal };
});

export function SidecarResources({ ref, activeSession, activeDisplaySession, activeSessionId, chatStore, workspaceStore, artifactReviewEpoch,
  sessionResponding, onLayoutChange, onHide, onReference, onAskForSpreadsheetChange: handleSpreadsheetAskForChange,
  onHandoff, onError: reportTimelineError }: Props) {
  const { t } = useTranslation("chat");
  const browser = useSidecarBrowserState(chatStore, activeSession?.id ?? "");
  const { browserError, browserSnapshot } = browser.state;
  const { acceptBrowserSnapshot, clearBrowserError, clearBrowserSnapshot } = browser;
  const [sidecar, dispatchSidecar] = useReducer(
    reduceSidecarState,
    undefined,
    () => createInitialSidecarState(readPersistedSidecarWidth(window.localStorage)),
  );
  const [artifactSidecarContent, setArtifactSidecarContent] = useState<Record<string, ArtifactSidecarContent>>({});
  const [browserProvisionErrors, setBrowserProvisionErrors] = useState<Record<string, string>>({});
  const [terminalErrors, setTerminalErrors] = useState<Record<string, string>>({});
  const [browserProvisionEpoch, setBrowserProvisionEpoch] = useState(0);
  const sidecarRef = useRef(sidecar);
  const browserProvisioningResourceIdRef = useRef("");
  const browserActivationTargetRef = useRef("");
  sidecarRef.current = sidecar;
  const sidecarTabs = useMemo(() => visibleSidecarTabs(sidecar), [sidecar]);
  const sidecarActiveTab = useMemo(() => activeSidecarTab(sidecar), [sidecar]);
  const explicitWorkspaceId = activeDisplaySession?.workingDirectory?.trim() ?? "";
  const activeWorkspaceId = activeDisplaySession
    ? explicitWorkspaceId || DEFAULT_SIDECAR_WORKSPACE_ID
    : "";
  const activeWorkspaceLabel = explicitWorkspaceId
    ? sessionWorkspaceName(explicitWorkspaceId)
    : activeDisplaySession ? t("shell.generalSessions") : "";

  const unboundBrowserResource = useMemo(() => sidecar.tabs.find((tab): tab is SidecarBrowserTab => (
    tab.kind === "browser"
      && tab.threadId === activeSession?.id
      && !tab.nativeTabId
  )), [activeSession?.id, sidecar.tabs]);
  const retainedBrowserResource = useMemo(() => sidecar.tabs.find((tab): tab is SidecarBrowserTab => (
    tab.kind === "browser"
      && tab.threadId === activeSession?.id
      && Boolean(tab.browserSessionId)
      && Boolean(tab.nativeTabId)
  )), [activeSession?.id, sidecar.tabs]);

  const synchronizeBrowserSnapshot = useCallback((snapshot: BrowserSnapshot, acceptForActiveThread = true) => {
    if (acceptForActiveThread && snapshot.data.sessionId === activeSessionId) {
      acceptBrowserSnapshot(snapshot);
    }
    dispatchSidecar({
      browserSessionId: snapshot.data.browserSessionId,
      tabs: snapshot.data.tabs.map((tab) => ({
        nativeTabId: tab.tabId,
        title: browserResourceTitle(tab.title, tab.url, t("sidecar.browser")),
      })),
      threadId: snapshot.data.sessionId,
      type: "tab.syncBrowserSession",
    });
  }, [acceptBrowserSnapshot, activeSessionId, t]);

  useEffect(() => {
    dispatchSidecar({
      threadId: activeSession?.id ?? "",
      type: "scope.changed",
      workspaceId: activeWorkspaceId,
    });
  }, [activeSession?.id, activeWorkspaceId]);

  useEffect(() => {
    if (browserSnapshot) synchronizeBrowserSnapshot(browserSnapshot, false);
  }, [browserSnapshot, synchronizeBrowserSnapshot]);

  useEffect(() => {
    const resource = retainedBrowserResource;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource?.browserSessionId
      || !browserRuntime
      || browserSnapshot?.data.browserSessionId === resource.browserSessionId) return;
    let cancelled = false;
    void browserRuntime.snapshot(resource.browserSessionId)
      .then((snapshot) => {
        if (cancelled) return;
        if (snapshot.data.sessionId !== resource.threadId) {
          throw new Error(
            `Browser snapshot session ${snapshot.data.sessionId} does not match resource thread ${resource.threadId}.`,
          );
        }
        synchronizeBrowserSnapshot(snapshot);
      })
      .catch((error) => {
        if (!cancelled) {
          setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [
    browserProvisionEpoch,
    browserSnapshot?.data.browserSessionId,
    chatStore.browserRuntime,
    retainedBrowserResource,
    synchronizeBrowserSnapshot,
  ]);

  useEffect(() => {
    const resource = unboundBrowserResource;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource
      || browserProvisionErrors[resource.id]
      || browserProvisioningResourceIdRef.current) return;
    browserProvisioningResourceIdRef.current = resource.id;
    void (async () => {
      try {
        if (!browserRuntime) throw new Error(t("sidecar.browserBuildUnavailable"));
        let snapshot = await browserRuntime.createSession({ ownerSessionId: resource.threadId });

        const currentResources = sidecarRef.current.tabs.filter((tab): tab is SidecarBrowserTab => (
          tab.kind === "browser" && tab.threadId === resource.threadId
        ));
        const currentResource = currentResources.find((tab) => tab.id === resource.id);
        const resourceStillExists = Boolean(currentResource);
        const resourceAlreadyBound = Boolean(
          currentResource?.browserSessionId === snapshot.data.browserSessionId
            && currentResource.nativeTabId
            && snapshot.data.tabs.some((tab) => tab.tabId === currentResource.nativeTabId),
        );
        const boundNativeTabIds = new Set(currentResources.flatMap((tab) => tab.nativeTabId ? [tab.nativeTabId] : []));
        const hasUnboundNativeTab = snapshot.data.tabs.some((tab) => !boundNativeTabIds.has(tab.tabId));
        let createdNativeTabId = "";
        if (resourceStillExists && !resourceAlreadyBound && !hasUnboundNativeTab) {
          const previousNativeTabIds = new Set(snapshot.data.tabs.map((tab) => tab.tabId));
          snapshot = await browserRuntime.createTab(snapshot.data.browserSessionId);
          createdNativeTabId = snapshot.data.tabs.find((tab) => !previousNativeTabIds.has(tab.tabId))?.tabId ?? "";
        }

        if (!sidecarRef.current.tabs.some((tab) => tab.id === resource.id)) {
          if (createdNativeTabId && snapshot.data.tabs.length > 1) {
            await browserRuntime.closeTab(snapshot.data.browserSessionId, createdNativeTabId);
          }
          return;
        }
        synchronizeBrowserSnapshot(snapshot);
      } catch (error) {
        if (sidecarRef.current.tabs.some((tab) => tab.id === resource.id)) {
          setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
        }
      } finally {
        if (browserProvisioningResourceIdRef.current === resource.id) {
          browserProvisioningResourceIdRef.current = "";
        }
        setBrowserProvisionEpoch((current) => current + 1);
      }
    })();
  }, [
    browserProvisionEpoch,
    browserProvisionErrors,
    chatStore.browserRuntime,
    synchronizeBrowserSnapshot,
    t,
    unboundBrowserResource,
  ]);

  useEffect(() => {
    const resource = sidecarActiveTab?.kind === "browser" ? sidecarActiveTab : undefined;
    const browserRuntime = chatStore.browserRuntime;
    if (!resource?.browserSessionId
      || !resource.nativeTabId
      || !browserRuntime
      || browserSnapshot?.data.browserSessionId !== resource.browserSessionId) return;
    const activationTarget = `${resource.browserSessionId}:${resource.nativeTabId}`;
    if (browserSnapshot.data.activeTabId === resource.nativeTabId) {
      if (browserActivationTargetRef.current === activationTarget) {
        browserActivationTargetRef.current = "";
      }
      return;
    }
    if (browserActivationTargetRef.current === activationTarget) return;
    browserActivationTargetRef.current = activationTarget;
    void browserRuntime.activateTab(resource.browserSessionId, resource.nativeTabId)
      .then((snapshot) => synchronizeBrowserSnapshot(snapshot))
      .catch((error) => {
        if (browserActivationTargetRef.current === activationTarget) {
          browserActivationTargetRef.current = "";
        }
        setBrowserProvisionErrors((current) => ({ ...current, [resource.id]: errorMessage(error) }));
      });
  }, [browserSnapshot, chatStore.browserRuntime, sidecarActiveTab, synchronizeBrowserSnapshot]);

  useEffect(() => {
    writePersistedSidecarWidth(window.localStorage, sidecar.width);
  }, [sidecar.width]);


  const { presentation, width, layoutMotion } = sidecar;
  useEffect(() => { onLayoutChange({ presentation, width, layoutMotion }); }, [presentation, width, layoutMotion, onLayoutChange]);
  useImperativeHandle(ref, () => ({
    async finishBrowserAnnotation() {
      const session = browserSnapshot?.data;
      if (!session?.annotationTabId) return;
      if (!chatStore.browserRuntime) throw new Error(t("sidecar.browserBuildUnavailable"));
      await chatStore.browserRuntime.annotate({ browserSessionId: session.browserSessionId, tabId: session.annotationTabId, action: { type: "stop" } });
    },
    toggle() { dispatchSidecar({ type: sidecar.presentation === "closed" ? "presentation.show" : "presentation.hide" }); },
    openArtifact: handleOpenArtifact,
    openFileLink: handleOpenAssistantFileLink,
  }));
  function hideSidecar() { onHide(); dispatchSidecar({ type: "presentation.hide" }); }
  async function handleOpenArtifact(artifact: ArtifactRef) {
    if (!activeSession) {
      return;
    }
    const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
    dispatchSidecar({
      artifactId: artifact.id,
      threadId: activeSession.id,
      title: artifact.title,
      type: "tab.openArtifact",
    });
    if (artifact.kind === "data_view") {
      setArtifactSidecarContent((current) => ({
        ...current,
        [tabId]: {
          artifact,
          ...(artifact.dataView ? { detail: { id: artifact.id, title: artifact.title, mimeType: artifact.mimeType, dataView: artifact.dataView } } : {}),
          loading: false,
          ...(artifact.dataViewError ? { error: artifact.dataViewError } : {}),
        },
      }));
      return;
    }
    setArtifactSidecarContent((current) => ({
      ...current,
      [tabId]: { artifact, loading: Boolean(chatStore.loadArtifact) },
    }));
    if (!chatStore.loadArtifact) {
      return;
    }
    try {
      const payload = await chatStore.loadArtifact({
        artifactId: artifact.id,
        sessionKey: activeSession.id,
      });
      const detail = projectLoadedArtifactDetail(artifact, payload);
      setArtifactSidecarContent((current) => current[tabId]
        ? { ...current, [tabId]: { ...current[tabId], detail, loading: false } }
        : current);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setArtifactSidecarContent((current) => current[tabId]
        ? { ...current, [tabId]: { ...current[tabId], error: message, loading: false } }
        : current);
    }
  }

  async function handleOpenAssistantFileLink(link: AssistantFileLink) {
    if (!activeSession) {
      return;
    }

    let artifact: ArtifactRef;
    try {
      artifact = assistantFileArtifact(resolveAssistantFileLink(link.href, activeSession.workingDirectory, link.sourcePath));
      logRendererEvent("info", "artifact.file_link.resolved", {
        href: link.href, sourcePath: link.sourcePath, path: artifact.fetchPath, sessionId: activeSession.id,
      });
    } catch (error) {
      artifact = assistantFileArtifact({ path: link.href, title: assistantFileLinkTitle(link.href) });
      const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
      dispatchSidecar({
        artifactId: artifact.id,
        threadId: activeSession.id,
        title: artifact.title,
        type: "tab.openArtifact",
      });
      const message = error instanceof AssistantFileLinkError && error.code === "outside_workspace"
        ? t("details.fileOutsideWorkspace")
        : errorMessage(error);
      console.error("[artifact-preview] workspace file link resolution failed", {
        error,
        href: link.href,
        sourcePath: link.sourcePath,
        sessionId: activeSession.id,
        workspaceRoot: activeSession.workingDirectory,
      });
      setArtifactSidecarContent((current) => ({
        ...current,
        [tabId]: { artifact, error: message, loading: false },
      }));
      return;
    }

    const tabId = sidecarArtifactTabId(activeSession.id, artifact.id);
    dispatchSidecar({
      artifactId: artifact.id,
      threadId: activeSession.id,
      title: artifact.title,
      type: "tab.openArtifact",
    });
    setArtifactSidecarContent((current) => ({
      ...current,
      [tabId]: { artifact, localFile: true, loading: false },
    }));
  }

  async function handleCloseSidecarTab(tab: SidecarTab) {
    if (tab.kind === "browser") {
      setBrowserProvisionErrors((current) => omitRecordKey(current, tab.id));
      const browserRuntime = chatStore.browserRuntime;
      if (!browserRuntime || !tab.browserSessionId || !tab.nativeTabId) {
        dispatchSidecar({ tabId: tab.id, type: "tab.close" });
        return;
      }
      try {
        let snapshot = await browserRuntime.snapshot(tab.browserSessionId);
        const remainingResources = sidecarRef.current.tabs.filter((candidate) => (
          candidate.kind === "browser"
            && candidate.threadId === tab.threadId
            && candidate.id !== tab.id
        ));
        if (snapshot.data.tabs.length === 1 && remainingResources.length) {
          snapshot = await browserRuntime.createTab(snapshot.data.browserSessionId);
        }
        if (snapshot.data.tabs.length === 1) {
          await browserRuntime.closeSession(snapshot.data.browserSessionId);
          clearBrowserSnapshot(snapshot.data.browserSessionId);
          dispatchSidecar({ tabId: tab.id, type: "tab.close" });
          return;
        }
        const next = await browserRuntime.closeTab(snapshot.data.browserSessionId, tab.nativeTabId);
        dispatchSidecar({ tabId: tab.id, type: "tab.close" });
        synchronizeBrowserSnapshot(next);
      } catch (error) {
        setBrowserProvisionErrors((current) => ({ ...current, [tab.id]: errorMessage(error) }));
      }
      return;
    }

    if (tab.kind === "terminal") {
      setTerminalErrors((current) => omitRecordKey(current, tab.id));
      try {
        await chatStore.terminalRuntime?.terminate(tab.id);
      } catch (error) {
        setTerminalErrors((current) => ({ ...current, [tab.id]: errorMessage(error) }));
        return;
      }
      dispatchSidecar({ tabId: tab.id, type: "tab.close" });
      return;
    }

    dispatchSidecar({ tabId: tab.id, type: "tab.close" });
    if (tab.kind === "artifact") {
      setArtifactSidecarContent((current) => omitRecordKey(current, tab.id));
    }
  }

  function renderSidecarArtifact(tab: SidecarArtifactTab) {
    const content = artifactSidecarContent[tab.id];
    if (!content) {
      return <p className="react-empty-state">{t("details.noPreview")}</p>;
    }
    return (
      <ArtifactDetails
        key={tab.id}
        reviewEpoch={artifactReviewEpoch}
        responding={sessionResponding}
        localThreadId={content.localFile ? tab.threadId : undefined}
        observeFile={sidecar.presentation !== "closed" && tab.threadId === activeSessionId}
        workspaceStore={workspaceStore}
        onReference={(reference) => {
          const id = "artifact:" + tab.id + ":" + reference.detail;
          onReference({ ...reference, id });
        }}
        artifact={content.artifact}
        detail={content.detail}
        error={content.error}
        loading={content.loading}
        notice={content.notice}
        office={content.office}
        onAskForSpreadsheetChange={handleSpreadsheetAskForChange}
        onOpenFileLink={handleOpenAssistantFileLink}
      />
    );
  }

  function renderSidecarBrowser(tab: SidecarBrowserTab, surfaceVisible: boolean) {
    return (
      <SidecarBrowser
        onReference={onReference}
        browserRuntime={chatStore.browserRuntime}
        externalError={browserProvisionErrors[tab.id] || browserError}
        snapshot={browserSnapshot?.data.sessionId === tab.threadId ? browserSnapshot : undefined}
        surfaceVisible={surfaceVisible}
        tab={tab}
        onHandoffComplete={() => handleBrowserHandoffComplete(tab)}
        onRetryProvision={() => {
          clearBrowserError();
          setBrowserProvisionErrors((current) => omitRecordKey(current, tab.id));
          setBrowserProvisionEpoch((current) => current + 1);
        }}
        onSnapshot={synchronizeBrowserSnapshot}
      />
    );
  }

  function renderSidecarTerminal(tab: SidecarTerminalTab) {
    return (
      <Suspense fallback={(
        <div aria-busy="true" className="react-sidecar__deferred" role="status">
          <Loader2 aria-hidden="true" size={18} />
          <span>{t("sidecar.terminalStarting")}</span>
        </div>
      )}>
        <LazySidecarTerminal
          externalError={terminalErrors[tab.id]}
          tab={tab}
          terminalRuntime={chatStore.terminalRuntime}
          workspaceLabel={activeWorkspaceLabel}
        />
      </Suspense>
    );
  }

  async function handleBrowserHandoffComplete(tab: SidecarBrowserTab) {
    if (!activeSession || activeSession.id !== tab.threadId) return;
    try {
      await onHandoff(activeSession.id);
    } catch (error) {
      reportTimelineError(t("sidecar.browserHandoffFailed", { message: errorMessage(error) }));
    }
  }

  return (
<Sidecar
        scopeKey={JSON.stringify([activeSessionId, activeWorkspaceId])}
        activeTabId={sidecarActiveTab?.id ?? ""}
        canCreateBrowser={Boolean(activeSession)}
        canCreateTerminal={Boolean(activeWorkspaceId)}
        presentation={sidecar.presentation}
        renderArtifact={renderSidecarArtifact}
        renderBrowser={renderSidecarBrowser}
        renderTerminal={renderSidecarTerminal}
        tabs={sidecarTabs}
        width={sidecar.width}
        onActivateTab={(tabId) => dispatchSidecar({ tabId, type: "tab.activate" })}
        onCloseTab={handleCloseSidecarTab}
        onCreateBrowser={() => dispatchSidecar({ type: "tab.newBrowser" })}
        onCreateTerminal={(shell) => dispatchSidecar({ shell, type: "tab.newTerminal" })}
        onHide={hideSidecar}
        onResize={(width, maxWidth) => dispatchSidecar({ maxWidth, type: "presentation.resize", width })}
        onToggleExpanded={() => dispatchSidecar({ type: "presentation.toggleExpanded" })}
      />
  );
}

function ArtifactDetails({
  artifact,
  detail: storedDetail,
  error: storedError,
  loading: storedLoading,
  notice: storedNotice,
  office: storedOffice,
  localThreadId,
  reviewEpoch,
  responding,
  observeFile,
  workspaceStore,
  onReference,
  onAskForSpreadsheetChange,
  onOpenFileLink,
}: {
  artifact: ArtifactRef;
  detail?: LoadedArtifactDetail;
  error?: string;
  loading: boolean;
  notice?: string;
  office?: OfficeArtifactSource;
  localThreadId?: string;
  reviewEpoch: number;
  responding: boolean;
  observeFile: boolean;
  workspaceStore?: Pick<WorkspaceStore, "readThreadFile" | "readThreadFileBytes" | "artifactReviews">;
  onReference: (reference: AgentInputReference) => void;
  onAskForSpreadsheetChange: (artifact: ArtifactRef, request: SpreadsheetCellChangeRequest, revision?: string) => void;
  onOpenFileLink: (link: AssistantFileLink) => void;
}) {
  const { t } = useTranslation("chat");
  const [refreshKey, setRefreshKey] = useState(0);
  const file = useArtifactFile({
    refreshKey,
    artifact, enabled: Boolean(localThreadId) && observeFile, threadId: localThreadId, workspaceStore,
    unavailableMessage: t("details.filePreviewUnavailable"), binaryMessage: t("details.binaryFilePreviewUnsupported"),
  });
  const { detail, error, loading, office } = localThreadId ? file : { detail: storedDetail, error: storedError, loading: storedLoading, office: storedOffice };
  const notice = localThreadId ? (file.truncated ? t("details.filePreviewTruncated") : undefined) : storedNotice;
  function referenceArtifact() {
    const text = detail?.dataView ? JSON.stringify(detail.dataView) : detail?.textContent;
    const excerpt = text && text.length > 12000 ? text.slice(0, 12000) + "\n[Preview excerpt truncated]" : text;
    onReference({
      kind: "reference", title: artifact.title, detail: t("details.artifactReference"),
      ...(localThreadId ? { referenceKind: "file", sourcePath: artifact.fetchPath, scope: localThreadId, revision: file.revision } as const : {}),
      sourceText: [
        `Artifact: ${artifact.title}`, `Artifact ID: ${artifact.id}`,
        ...(localThreadId ? [`File: ${artifact.fetchPath}`, `Viewed revision: ${file.revision}`, "Verify the current file before editing; this reference describes the viewed revision."] : []),
        ...(excerpt ? [excerpt] : []),
      ].join("\n"),
    });
  }
  const markdown = isMarkdownArtifact(artifact, detail);
  const delimiter = !markdown && !office && !detail?.dataView && !detail?.imageDataUrl
    ? artifactDelimiter(artifact.fetchPath || artifact.title, detail?.mimeType || artifact.mimeType) : undefined;
  const delimited = delimiter !== undefined && detail?.textContent !== undefined;
  const codeLanguage = resolveCodeArtifactLanguage({ path: artifact.fetchPath, title: artifact.title, mimeType: detail?.mimeType || artifact.mimeType });
  const referenceAction = <button disabled={loading || Boolean(error)} onClick={referenceArtifact} type="button">{t("details.referenceInChat")}</button>;
  const markdownContent = detail?.textContent && markdown
    ? { text: detail.textContent, title: detail.title }
    : undefined;
  return (
    <div className="react-artifact-detail" data-content={markdown || office?.kind === "document" ? "document" : "preview"}>
      {!delimited ? <div className="react-artifact-detail__toolbar">
        {localThreadId ? <span role="status">{t("details.fileAutoUpdates")}</span> : null}
        <div className="react-artifact-detail__actions">{referenceAction}</div>
      </div> : null}
      {localThreadId && artifact.fetchPath && workspaceStore?.artifactReviews ? (
        <ArtifactReviewPanel store={workspaceStore.artifactReviews} path={artifact.fetchPath} threadId={localThreadId}
          revision={error ? undefined : file.revision} epoch={reviewEpoch} responding={responding}
          kind={office?.kind} title={artifact.title} onRestored={() => setRefreshKey((value) => value + 1)} />
      ) : null}

      {loading ? <p aria-live="polite">{t("details.loadingArtifact")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p className="react-artifact-detail__notice">{notice}</p> : null}
      {detail?.imageDataUrl ? <ImageArtifactPreview key={detail.imageDataUrl} src={detail.imageDataUrl} title={detail.title} path={artifact.fetchPath} /> : null}
      {detail?.dataView ? <DataViewCard artifact={{ ...artifact, dataView: detail.dataView }} expanded /> : null}
      {office ? (
        <OfficeArtifactPreview
          onAskForContentChange={!error && localThreadId && file.revision && artifact.fetchPath ? (request) => {
            const position = request.start === request.end ? String(request.start) : `${request.start}–${request.end}`;
            onReference(officeContentReference({ request, path: artifact.fetchPath!, title: artifact.title, threadId: localThreadId, revision: file.revision!,
              label: t(request.kind === "document" ? "details.officeParagraphSelection" : "details.officeSlideSelection", { position }),
            }));
          } : undefined}
          onAskForChange={error ? undefined : (selection) => onAskForSpreadsheetChange(artifact, selection, file.revision)}
          source={office}
        />
      ) : null}
      {delimited ? <DelimitedTextPreview actions={referenceAction} delimiter={delimiter} key={artifact.id} text={detail.textContent!} title={artifact.title} truncated={Boolean(notice)} /> : markdownContent ? (
        <article aria-label={markdownContent.title} className="react-artifact-detail__document" role="document">
          <AssistantMarkdown
            onOpenFileLink={(link) => onOpenFileLink({ ...link, sourcePath: localThreadId ? artifact.fetchPath : undefined })}
            streaming={false}
            text={markdownContent.text}
          />
        </article>
      ) : detail?.textContent ? codeLanguage
        ? <CodeArtifactPreview text={detail.textContent} language={codeLanguage} />
        : <pre className="react-artifact-detail__text">{detail.textContent}</pre> : null}
      {!markdown && !office ? <details className="react-artifact-detail__metadata">
        <summary>{t("details.fileDetails")}</summary>
        <dl>
          <div><dt>{t("details.id")}</dt><dd>{artifact.id}</dd></div>
          {detail?.mimeType || artifact.mimeType ? <div><dt>{t("details.type")}</dt><dd>{detail?.mimeType || artifact.mimeType}</dd></div> : null}
          {localThreadId ? <div><dt>{t("details.status")}</dt><dd>{t("details.fileAutoUpdates")}</dd></div> : null}
        </dl>
      </details> : null}
      {!loading && !error && !office && !delimited && !detail?.dataView && !detail?.imageDataUrl && !detail?.textContent ? <p>{t("details.noPreview")}</p> : null}
    </div>
  );
}

function isMarkdownArtifact(artifact: ArtifactRef, detail?: LoadedArtifactDetail): boolean {
  const mimeType = (detail?.mimeType || artifact.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  return artifact.kind.toLowerCase() === "markdown" || mimeType === "text/markdown";
}

function browserResourceTitle(title: string, url: string, fallback: string): string {
  const normalizedTitle = title.trim();
  if (normalizedTitle && normalizedTitle !== "about:blank" && normalizedTitle !== "New tab") {
    return normalizedTitle;
  }
  if (!url || url === "about:blank") return fallback;
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function omitRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}


function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
