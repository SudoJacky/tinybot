import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { TFunction } from "i18next";
import { ExternalLink, Loader2, Minus } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  createDesktopStopCommand,
  createDesktopTurnSubmitCommand,
} from "../../app-core/chat/desktopCommand";
import { readDefaultChatModelPreference, writeDefaultChatModel } from "../../app-core/chat/chatModelPreference";
import {
  readCurrentChatReasoningEffort,
  writeCurrentChatReasoningEffort,
} from "../../app-core/chat/reasoningEffort";
import {
  createDesktopNativePetQuickChatWindowClient,
  type DesktopPetQuickChatRequest,
  type DesktopPetQuickChatWindowClient,
} from "../../app-core/native/desktopNativePetQuickChat";
import {
  ClaudeStyleAiInput,
  type ComposerFileReference,
  type ComposerSendOptions,
  type ModelOption,
  type PastedContent,
} from "../../components/ui/claude-style-ai-input";
import { pickDesktopChatFiles } from "../../app-core/native/desktopNativeFilePicker";
import type { ChatModelOption, ChatStore, SessionStore, SessionSummary, SettingsStore } from "../services";
import { ChatTimeline } from "../chat/ChatTimeline";
import {
  projectLatestContextUsage,
  type ContextUsageDefaults,
} from "../chat/chatContextUsage";
import { prepareChatSubmission } from "../chat/chatSubmission";
import type { ReactChatMessage } from "../chat/messageActions";
import { deriveSessionTitle, displaySessionTitle } from "../chat/sessionTitle";
import { useChatSessionRuntime, type ChatSessionRuntimeEffect } from "../chat/useChatSessionRuntime";
import "../chat/ChatPage.css";
import "./DesktopPetQuickChatWindow.css";

type DesktopPetQuickChatServices = {
  chatStore: ChatStore;
  sessionStore: SessionStore;
  settingsStore: SettingsStore;
};

const EMPTY_INTERACTIVE_FORM_IDS = new Set<string>();

export function DesktopPetQuickChatWindow({
  client,
  services,
}: {
  client?: DesktopPetQuickChatWindowClient;
  services: DesktopPetQuickChatServices;
}) {
  const { t } = useTranslation("common");
  const { t: tChat } = useTranslation("chat");
  const windowClient = useMemo(
    () => client ?? createDesktopNativePetQuickChatWindowClient(),
    [client],
  );
  const rootRef = useRef<HTMLElement | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);
  const [activeRequestId, setActiveRequestId] = useState("");
  const [draft, setDraft] = useState("");
  const [composerFiles, setComposerFiles] = useState<ComposerFileReference[]>([]);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [recentSessions, setRecentSessions] = useState<SessionSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [composerModel, setComposerModel] = useState("");
  const [contextUsageDefaults, setContextUsageDefaults] = useState<ContextUsageDefaults>({});
  const [reasoningEffort, setReasoningEffort] = useState(readCurrentChatReasoningEffort);
  const [optimisticMessages, setOptimisticMessages] = useState<ReactChatMessage[]>([]);
  const [loadError, setLoadError] = useState("");

  const refreshRecentSessions = useCallback(async () => {
    const sessions = await services.sessionStore.list();
    setRecentSessions(sessions
      .filter(isGeneralSession)
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .slice(0, 3));
  }, [services.sessionStore]);

  function handleRuntimeEffect(effect: ChatSessionRuntimeEffect) {
    if (effect.type === "message_received") {
      setOptimisticMessages((current) => (
        current.some((message) => message.id === effect.message.id)
          ? current
          : [...current, effect.message]
      ));
      return;
    }
    if (effect.type === "timeline_applied") {
      setOptimisticMessages([]);
      if (!isTimelineRunning(effect.timeline.turns)) void refreshRecentSessions().catch(reportQuickChatError);
    }
  }

  const sessionRuntime = useChatSessionRuntime({
    chatStore: services.chatStore,
    onEffect: handleRuntimeEffect,
    sessionId: session?.id ?? "",
  });
  const timeline = sessionRuntime.state.timeline;
  const activeContextUsage = useMemo(
    () => projectLatestContextUsage(timeline?.turns ?? [], contextUsageDefaults),
    [contextUsageDefaults, timeline],
  );
  const sessionRunning = isTimelineRunning(timeline?.turns ?? []);
  const latestFailedTurnId = [...(timeline?.turns ?? [])].reverse()
    .find((turn) => turn.status === "failed" || turn.status === "interrupted")?.id ?? "";

  const applyQuickChatRequest = useEffectEvent((request: DesktopPetQuickChatRequest) => {
    console.info("[desktop-pet-quick-chat] request.received", {
      requestId: request.requestId,
      textLength: request.draft.length,
      attachmentCount: request.attachments.length,
    });
    setActiveRequestId(request.requestId);
    setDraft(request.draft);
    setComposerFiles(request.attachments.map((attachment, index) => ({
      ...attachment,
      id: `${request.requestId}-attachment-${index}`,
    })));
    setSession(null);
    setOptimisticMessages([]);
    setLoadError("");
    void refreshRecentSessions().catch((error) => {
      setLoadError(errorMessage(error));
      reportQuickChatError(error);
    });
  });

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void windowClient.listen((request) => {
      if (disposed) return;
      applyQuickChatRequest(request);
    }).then((stopListening) => {
      if (disposed) stopListening();
      else unlisten = stopListening;
    }).catch((error) => {
      setLoadError(errorMessage(error));
      reportQuickChatError(error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [windowClient]);

  useEffect(() => {
    void refreshRecentSessions().catch((error) => {
      setLoadError(errorMessage(error));
      reportQuickChatError(error);
    });
  }, [refreshRecentSessions]);

  useEffect(() => {
    if (!services.settingsStore.loadChatModels) return;
    let cancelled = false;
    void services.settingsStore.loadChatModels().then((nextModels) => {
      if (cancelled) return;
      const composerModels = nextModels.map((model) => toComposerModelOption(model, tChat));
      const preference = readDefaultChatModelPreference();
      const selected = composerModels.find((model) => (
        model.modelId === preference?.modelId
        && (model.providerId ?? "") === (preference?.providerId ?? "")
      )) ?? composerModels.find((model) => nextModels.find((source) => source.id === model.modelId)?.default)
        ?? composerModels[0];
      setModels(composerModels);
      setComposerModel(selected?.id ?? "");
    }).catch((error) => {
      if (cancelled) return;
      setLoadError(errorMessage(error));
      reportQuickChatError(error);
    });
    return () => {
      cancelled = true;
    };
  }, [services.settingsStore, tChat]);

  useEffect(() => {
    if (!models.length || !session) return;
    const selected = findComposerModel(models, session.model ?? "", session.modelProvider ?? "");
    if (selected) setComposerModel(selected.id);
  }, [models, session]);

  useEffect(() => {
    if (!services.settingsStore.loadAgentDefaultsSettings) {
      setContextUsageDefaults({});
      return;
    }
    let cancelled = false;
    void services.settingsStore.loadAgentDefaultsSettings().then((settings) => {
      const contextWindowTokens = settings.fallbackContextWindowTokens;
      if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
        throw new Error(`Invalid context window token fallback: ${contextWindowTokens}`);
      }
      if (!cancelled) {
        setContextUsageDefaults({
          contextWindowStrategy: settings.values.contextWindowStrategy.trim() || undefined,
          contextWindowTokens,
        });
      }
    }).catch((error) => {
      console.error("[desktop-pet-quick-chat] context.defaults.load.failed", {
        error: errorMessage(error),
      });
      if (!cancelled) setContextUsageDefaults({});
    });
    return () => {
      cancelled = true;
    };
  }, [services.settingsStore]);

  useEffect(() => {
    if (!activeRequestId) return;
    const frame = window.requestAnimationFrame(() => {
      const textarea = rootRef.current?.querySelector<HTMLTextAreaElement>(".claude-ai-input__textarea");
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeRequestId]);

  useEffect(() => {
    conversationEndRef.current?.scrollIntoView?.({ block: "end" });
  }, [optimisticMessages, timeline]);

  async function handleSend(
    message: string,
    files: ComposerFileReference[],
    pastedContent: PastedContent[],
    options: ComposerSendOptions,
  ) {
    const prepared = await prepareChatSubmission({
      availableSessionIds: new Set(),
      files,
      isRunning: false,
      loadSessionTranscript: services.chatStore.copyMarkdown,
      message,
      now: () => new Date().toISOString(),
      options,
      pastedContent,
      queuedInputs: [],
      selectedSkillIds: [],
      selectedSessionIds: [],
      sessions: [],
      t: tChat,
    });
    if (prepared.kind === "empty") return;
    if (prepared.kind !== "send_message") {
      throw new Error(t("desktopPet.quickChat.commandUnsupported"));
    }

    const targetSession = session ?? await services.sessionStore.create({
      title: deriveSessionTitle(prepared.visibleText, tChat),
      ...(prepared.turnInput.model ? { model: prepared.turnInput.model } : {}),
      ...(prepared.turnInput.provider ? { modelProvider: prepared.turnInput.provider } : {}),
      entryPoint: "desktop-pet",
    });
    if (!session) setSession(targetSession);
    const command = createDesktopTurnSubmitCommand({
      message: prepared.turnInput,
      sessionId: targetSession.id,
      source: { control: "desktop-pet-quick-chat", surface: "chat" },
    });
    const optimisticMessage: ReactChatMessage = {
      id: command.commandId,
      role: "user",
      createdAtMs: Date.now(),
      text: prepared.visibleText,
      status: "complete",
    };
    setOptimisticMessages([optimisticMessage]);
    try {
      await services.chatStore.dispatch(command);
      setDraft("");
      await refreshRecentSessions();
    } catch (error) {
      setOptimisticMessages([]);
      throw error;
    }
  }

  async function handleStop() {
    if (!session) return;
    await services.chatStore.dispatch(createDesktopStopCommand({
      sessionId: session.id,
      source: { control: "desktop-pet-quick-chat", surface: "chat" },
    }));
  }

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    void windowClient.startDragging().catch(reportQuickChatError);
  }

  function selectRecentSession(nextSession: SessionSummary) {
    setSession(nextSession);
    setDraft("");
    setComposerFiles([]);
    setOptimisticMessages([]);
    setLoadError("");
  }

  const headerTitle = session ? displaySessionTitle(session.title, tChat) : t("desktopPet.quickChat.newChat");
  const runtimeError = sessionRuntime.state.error || loadError;
  const emptyActiveSession = !session || (
    sessionRuntime.state.status === "ready"
    && timeline?.sessionId === session.id
    && timeline.turns.length === 0
    && optimisticMessages.length === 0
  );

  return (
    <main ref={rootRef} aria-label={t("desktopPet.quickChat.panel")} className="react-desktop-pet-quick-chat">
      <header
        className="react-desktop-pet-quick-chat__header"
        onPointerDown={handleHeaderPointerDown}
      >
        <h1 title={headerTitle}>{headerTitle}</h1>
        <div aria-label={t("desktopPet.quickChat.windowControls")} role="group">
          <button
            aria-label={t("desktopPet.quickChat.openInMain")}
            disabled={!session}
            title={t("desktopPet.quickChat.openInMain")}
            type="button"
            onClick={() => void windowClient.openInMain(session?.id).catch(reportQuickChatError)}
          >
            <ExternalLink aria-hidden="true" size={17} />
          </button>
          <button
            aria-label={t("desktopPet.quickChat.minimize")}
            title={t("desktopPet.quickChat.minimize")}
            type="button"
            onClick={() => void windowClient.dismiss().catch(reportQuickChatError)}
          >
            <Minus aria-hidden="true" size={17} />
          </button>
        </div>
      </header>

      <section aria-live="polite" className="react-desktop-pet-quick-chat__conversation">
        {runtimeError ? <p className="react-desktop-pet-quick-chat__error" role="alert">{runtimeError}</p> : null}
        {session ? (
          <>
            {sessionRuntime.state.status === "loading" && !timeline ? (
              <p className="react-desktop-pet-quick-chat__loading" role="status">
                <Loader2 aria-hidden="true" />
                <span>{t("desktopPet.quickChat.loading")}</span>
              </p>
            ) : null}
            <ChatTimeline
              actions={{}}
              error={sessionRuntime.state.error}
              hookResults={sessionRuntime.state.hookResults}
              interactiveFormIds={EMPTY_INTERACTIVE_FORM_IDS}
              latestFailedTurnId={latestFailedTurnId}
              optimisticMessages={optimisticMessages}
              sessionRunning={sessionRunning}
              turns={timeline?.turns ?? []}
            />
            {sessionRuntime.state.agentUiForms.length ? (
              <button
                className="react-desktop-pet-quick-chat__continue"
                type="button"
                onClick={() => void windowClient.openInMain(session.id).catch(reportQuickChatError)}
              >
                {t("desktopPet.quickChat.needsInput")}
              </button>
            ) : null}
          </>
        ) : (
          <div className="react-desktop-pet-quick-chat__recent">
            <h2>{t("desktopPet.quickChat.recent")}</h2>
            {recentSessions.map((recent) => (
              <button key={recent.id} type="button" onClick={() => selectRecentSession(recent)}>
                <span>{displaySessionTitle(recent.title, tChat)}</span>
                <time>{formatRecentTime(recent.updatedAtMs, t("desktopPet.quickChat.today"))}</time>
              </button>
            ))}
            {recentSessions.length ? (
              <button className="react-desktop-pet-quick-chat__see-all" type="button" onClick={() => void windowClient.openInMain().catch(reportQuickChatError)}>
                {t("desktopPet.quickChat.seeAll")}
              </button>
            ) : null}
          </div>
        )}
        <div ref={conversationEndRef} aria-hidden="true" />
      </section>

      <ClaudeStyleAiInput
        className="react-desktop-pet-quick-chat__composer"
        contextUsage={activeContextUsage}
        defaultModel={composerModel}
        defaultReasoningEffort={reasoningEffort}
        files={composerFiles}
        models={models}
        onFilesChange={setComposerFiles}
        placeholder={t("desktopPet.quickChat.placeholder")}
        responding={sessionRunning}
        value={draft}
        onModelChange={(modelId) => {
          const selected = models.find((model) => model.id === modelId);
          if (!selected) return;
          setComposerModel(modelId);
          const selectedModelId = selected.modelId || selected.id;
          if (emptyActiveSession) {
            writeDefaultChatModel(selectedModelId, selected.providerId);
          }
          if (session) {
            setSession((current) => current && current.id === session.id
              ? {
                  ...current,
                  model: selectedModelId,
                  modelProvider: selected.providerId,
                }
              : current);
            const setModel = selected.providerId
              ? services.sessionStore.setModel?.(session.id, selectedModelId, selected.providerId)
              : services.sessionStore.setModel?.(session.id, selectedModelId);
            void setModel?.catch((error) => {
              const message = tChat("errors.modelSaveFailed", { message: errorMessage(error) });
              setLoadError(message);
              reportQuickChatError(error);
            });
          }
        }}
        onReasoningEffortChange={(effort) => {
          setReasoningEffort(effort);
          writeCurrentChatReasoningEffort(effort);
        }}
        onSelectFiles={pickDesktopChatFiles}
        onSendMessage={handleSend}
        onStopResponding={handleStop}
        onValueChange={setDraft}
      />
    </main>
  );
}

function isGeneralSession(session: SessionSummary): boolean {
  return !session.archived
    && !session.projectCoordinator
    && !session.projectGroupId
    && !session.workingDirectory;
}

function isTimelineRunning(turns: readonly { status: string }[]): boolean {
  const status = turns[turns.length - 1]?.status;
  return status === "pending" || status === "running" || status === "awaiting_user";
}

function toComposerModelOption(model: ChatModelOption, t: TFunction<"chat">): ModelOption {
  return {
    id: model.providerId
      ? `provider:${encodeURIComponent(model.providerId)}|model:${encodeURIComponent(model.id)}`
      : model.id,
    modelId: model.id,
    ...(model.providerId ? { providerId: model.providerId } : {}),
    name: model.label || model.id,
    description: model.description || model.providerLabel || t("composer.configuredModel"),
  };
}

function findComposerModel(
  models: readonly ModelOption[],
  modelId: string,
  providerId = "",
): ModelOption | undefined {
  if (!modelId) return undefined;
  const actualModelId = (model: ModelOption) => model.modelId || model.id;
  return (providerId
    ? models.find((model) => actualModelId(model) === modelId && model.providerId === providerId)
    : undefined)
    ?? models.find((model) => actualModelId(model) === modelId);
}

function formatRecentTime(updatedAtMs: number, todayLabel: string): string {
  const date = new Date(updatedAtMs);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return todayLabel;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportQuickChatError(error: unknown): void {
  console.error("[desktop-pet-quick-chat] Window interaction failed.", error);
}
