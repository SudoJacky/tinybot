import {
  AlertCircle,
  CheckCircle2,
  Download,
  RefreshCw,
  X,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useModalDialog } from "../../components/ui/useModalDialog";
import {
  createDesktopNativeUpdateClient,
  type DesktopUpdateClient,
  type DesktopUpdateSnapshot,
} from "../../app-core/native/desktopNativeUpdate";
import {
  loadLatestDesktopUpdateNotes,
  rememberLatestDesktopUpdateNotes,
  type DesktopUpdateNotes,
} from "../../app-core/native/desktopUpdateNotes";
import { AssistantMarkdown } from "../chat/AssistantMarkdown";

type DesktopUpdateDialogsProps = {
  aboutOpenSignal: number;
  updateClient?: DesktopUpdateClient | null;
  whatsNewOpenSignal: number;
};

type OpenDialog = "about" | "update" | "whats-new" | null;
type PendingAction = "check" | "install" | null;

const browserPreviewSnapshot: DesktopUpdateSnapshot = {
  currentVersion: "Development build",
  availableVersion: null,
  releaseNotes: null,
  displayNotes: null,
  publishedAt: null,
  phase: "idle",
  progressPercent: null,
  error: null,
};

export function DesktopUpdateDialogs({
  aboutOpenSignal,
  updateClient,
  whatsNewOpenSignal,
}: DesktopUpdateDialogsProps) {
  const { t } = useTranslation("updates");
  const client = useMemo(
    () => updateClient === undefined ? createDesktopNativeUpdateClient() : updateClient,
    [updateClient],
  );
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot>(browserPreviewSnapshot);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [latestNotes, setLatestNotes] = useState<DesktopUpdateNotes | null>(null);
  const dismissedVersionRef = useRef<string | null>(null);
  const lastAboutSignalRef = useRef(aboutOpenSignal);
  const lastWhatsNewSignalRef = useRef(whatsNewOpenSignal);
  const primaryActionRef = useRef<HTMLButtonElement>(null);

  const acceptSnapshot = useCallback((next: DesktopUpdateSnapshot) => {
    setSnapshot(next);
    if (next.phase === "available") {
      try {
        rememberLatestDesktopUpdateNotes(next);
      } catch (error) {
        console.error("[tinybot-updater] Failed to persist the latest update notes.", error);
        setActionError(t("notesSaveFailed", { message: toErrorMessage(error) }));
      }
    }
    if (
      next.phase === "available"
      && next.availableVersion
      && dismissedVersionRef.current !== next.availableVersion
    ) {
      setOpenDialog("update");
    }
  }, [t]);

  useEffect(() => {
    if (!client) {
      return;
    }
    let active = true;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        unlisten = await client.listen((next) => {
          if (active) {
            acceptSnapshot(next);
          }
        });
        const current = await client.status();
        if (active) {
          acceptSnapshot(current);
        }
      } catch (error) {
        if (active) {
          setActionError(toErrorMessage(error));
        }
      }
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, [acceptSnapshot, client]);

  useEffect(() => {
    if (aboutOpenSignal === lastAboutSignalRef.current) {
      return;
    }
    lastAboutSignalRef.current = aboutOpenSignal;
    setActionError(null);
    setOpenDialog("about");
  }, [aboutOpenSignal]);

  useEffect(() => {
    if (whatsNewOpenSignal === lastWhatsNewSignalRef.current) {
      return;
    }
    lastWhatsNewSignalRef.current = whatsNewOpenSignal;
    setActionError(null);
    try {
      setLatestNotes(loadLatestDesktopUpdateNotes());
    } catch (error) {
      console.error("[tinybot-updater] Failed to load the latest update notes.", error);
      setLatestNotes(null);
      setActionError(t("notesLoadFailed", { message: toErrorMessage(error) }));
    }
    setOpenDialog("whats-new");
  }, [t, whatsNewOpenSignal]);

  useEffect(() => {
    if (openDialog) {
      primaryActionRef.current?.focus();
    }
  }, [openDialog]);

  const closeDialog = useCallback(() => {
    if (isUpdateBusy(snapshot.phase, pendingAction)) {
      return;
    }
    if (openDialog === "update" && snapshot.availableVersion) {
      dismissedVersionRef.current = snapshot.availableVersion;
    }
    setActionError(null);
    setOpenDialog(null);
  }, [openDialog, pendingAction, snapshot.availableVersion, snapshot.phase]);

  async function checkForUpdate() {
    if (!client) {
      setActionError(t("desktopOnly"));
      return;
    }
    setActionError(null);
    setPendingAction("check");
    try {
      acceptSnapshot(await client.check());
    } catch (error) {
      setActionError(toErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  async function installUpdate() {
    const version = snapshot.availableVersion;
    if (!client || !version) {
      setActionError(t("unavailable"));
      return;
    }
    setActionError(null);
    setPendingAction("install");
    try {
      acceptSnapshot(await client.install(version));
    } catch (error) {
      setActionError(toErrorMessage(error));
    } finally {
      setPendingAction(null);
    }
  }

  const busy = isUpdateBusy(snapshot.phase, pendingAction);
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLElement>({
    active: openDialog !== null,
    closeEnabled: !busy,
    onClose: closeDialog,
  });

  if (!openDialog) {
    return null;
  }

  const isWhatsNew = openDialog === "whats-new";
  const error = isWhatsNew ? actionError : actionError ?? snapshot.error;
  const isUpdatePrompt = openDialog === "update" && Boolean(snapshot.availableVersion);
  const dialogLabel = isUpdatePrompt
    ? t("updateAvailableLabel")
    : isWhatsNew
      ? t("whatsNewLabel")
      : t("aboutLabel");
  const heading = isUpdatePrompt
    ? t("availableTitle", { version: snapshot.availableVersion ?? "" })
    : isWhatsNew && latestNotes
      ? t("whatsNewTitle", { version: latestNotes.version })
      : isWhatsNew
        ? t("whatsNew")
        : t("aboutLabel");

  return (
    <div
      className="desktop-update-overlay"
      onPointerDown={onBackdropPointerDown}
    >
      <section
        aria-label={dialogLabel}
        aria-modal="true"
        className="desktop-update-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <header className="desktop-update-dialog__header">
          <span className="desktop-update-dialog__mark" aria-hidden="true">
            <img alt="" src="/assets/app-icon.svg" />
          </span>
          <div>
            <p>{isUpdatePrompt ? t("softwareUpdate") : isWhatsNew ? t("releaseNotes") : t("desktopName")}</p>
            <h2>{heading}</h2>
          </div>
          <button
            aria-label={t("close")}
            className="desktop-update-dialog__close"
            disabled={busy}
            title={t("close")}
            type="button"
            onClick={closeDialog}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {isUpdatePrompt ? (
          <UpdateAvailableContent snapshot={snapshot} />
        ) : isWhatsNew ? (
          <WhatsNewContent notes={latestNotes} />
        ) : (
          <AboutContent
            snapshot={snapshot}
            onReviewUpdate={() => setOpenDialog("update")}
          />
        )}

        {error ? (
          <p className="desktop-update-dialog__status desktop-update-dialog__status--error" role="alert">
            <AlertCircle aria-hidden="true" size={16} />
            <span>{error}</span>
          </p>
        ) : isWhatsNew ? null : (
          <UpdateStatus snapshot={snapshot} />
        )}

        <footer className="desktop-update-dialog__actions">
          {isUpdatePrompt ? (
            <>
              <button disabled={busy} type="button" onClick={closeDialog}>{t("later")}</button>
              <button
                className="desktop-update-dialog__primary"
                data-dialog-initial-focus
                disabled={busy}
                ref={primaryActionRef}
                type="button"
                onClick={() => void installUpdate()}
              >
                {snapshot.phase === "downloading" ? (
                  <RefreshCw aria-hidden="true" className="desktop-update-dialog__spinner" size={15} />
                ) : (
                  <Download aria-hidden="true" size={15} />
                )}
                {installButtonLabel(snapshot, t)}
              </button>
            </>
          ) : isWhatsNew ? (
            <button
              className="desktop-update-dialog__primary"
              data-dialog-initial-focus
              ref={primaryActionRef}
              type="button"
              onClick={closeDialog}
            >
              {t("close")}
            </button>
          ) : (
            <button
              className="desktop-update-dialog__primary"
              data-dialog-initial-focus
              disabled={busy || !client}
              ref={primaryActionRef}
              type="button"
              onClick={() => void checkForUpdate()}
            >
              <RefreshCw
                aria-hidden="true"
                className={snapshot.phase === "checking" ? "desktop-update-dialog__spinner" : undefined}
                size={15}
              />
              {checkButtonLabel(snapshot, Boolean(client), t)}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function AboutContent({
  snapshot,
  onReviewUpdate,
}: {
  snapshot: DesktopUpdateSnapshot;
  onReviewUpdate: () => void;
}) {
  const { t } = useTranslation("updates");
  const version = snapshot.currentVersion === browserPreviewSnapshot.currentVersion
    ? t("developmentBuild")
    : snapshot.currentVersion;
  return (
    <div className="desktop-update-dialog__about">
      <div className="desktop-update-dialog__version-row">
        <span>{t("currentVersion")}</span>
        <strong>v{version}</strong>
      </div>
      <p>
        {t("aboutDescription")}
      </p>
      {snapshot.phase === "available" && snapshot.availableVersion ? (
        <button
          className="desktop-update-dialog__available-link"
          type="button"
          onClick={onReviewUpdate}
        >
          {t("readyToReview", { version: snapshot.availableVersion })}
        </button>
      ) : null}
    </div>
  );
}

function UpdateAvailableContent({ snapshot }: { snapshot: DesktopUpdateSnapshot }) {
  const { i18n, t } = useTranslation("updates");
  return (
    <div className="desktop-update-dialog__release">
      <div className="desktop-update-dialog__version-row">
        <span>{t("version")}</span>
        <strong>v{snapshot.currentVersion} → v{snapshot.availableVersion}</strong>
        {snapshot.publishedAt ? <small>{formatPublishedAt(snapshot.publishedAt, i18n.language)}</small> : null}
      </div>
      <UpdateNotesContent
        displayNotes={snapshot.displayNotes}
        displayTitle={t("beforeUpdate")}
        emptyText={t("noNotes")}
        releaseNotes={snapshot.releaseNotes}
        releaseTitle={t("whatsNew")}
      />
      {snapshot.phase === "downloading" || snapshot.phase === "installing" ? (
        <div className="desktop-update-dialog__progress">
          <div>
            <span>{snapshot.phase === "installing" ? t("preparingInstaller") : t("downloadingUpdate")}</span>
            <strong>{snapshot.progressPercent ?? 0}%</strong>
          </div>
          <progress max={100} value={snapshot.progressPercent ?? 0} />
        </div>
      ) : null}
    </div>
  );
}

function WhatsNewContent({ notes }: { notes: DesktopUpdateNotes | null }) {
  const { i18n, t } = useTranslation("updates");
  return (
    <div className="desktop-update-dialog__release">
      {notes ? (
        <div className="desktop-update-dialog__version-row">
          <span>{t("version")}</span>
          <strong>v{notes.version}</strong>
          {notes.publishedAt ? <small>{formatPublishedAt(notes.publishedAt, i18n.language)}</small> : null}
        </div>
      ) : null}
      <UpdateNotesContent
        displayNotes={notes?.displayNotes ?? null}
        displayTitle={t("releaseHighlights")}
        emptyText={t("noSavedNotes")}
        releaseNotes={notes?.releaseNotes ?? null}
        releaseTitle={t("releaseNotes")}
      />
    </div>
  );
}

function UpdateNotesContent({
  displayNotes,
  displayTitle,
  emptyText,
  releaseNotes,
  releaseTitle,
}: {
  displayNotes: string | null;
  displayTitle: string;
  emptyText: string;
  releaseNotes: string | null;
  releaseTitle: string;
}) {
  return (
    <>
      {displayNotes ? (
        <aside className="desktop-update-dialog__notice">
          <strong>{displayTitle}</strong>
          <AssistantMarkdown streaming={false} text={displayNotes} />
        </aside>
      ) : null}
      <section className="desktop-update-dialog__notes">
        <h3>{releaseTitle}</h3>
        {releaseNotes ? (
          <AssistantMarkdown streaming={false} text={releaseNotes} />
        ) : (
          <p>{emptyText}</p>
        )}
      </section>
    </>
  );
}

function UpdateStatus({ snapshot }: { snapshot: DesktopUpdateSnapshot }) {
  const { t } = useTranslation("updates");
  if (snapshot.phase !== "up_to_date") {
    return null;
  }
  return (
    <p className="desktop-update-dialog__status" role="status">
      <CheckCircle2 aria-hidden="true" size={16} />
      <span>{t("latest")}</span>
    </p>
  );
}

function isUpdateBusy(phase: DesktopUpdateSnapshot["phase"], pendingAction: PendingAction): boolean {
  return pendingAction !== null || phase === "checking" || phase === "downloading" || phase === "installing";
}

function checkButtonLabel(snapshot: DesktopUpdateSnapshot, available: boolean, t: TFunction<"updates">): string {
  if (!available) {
    return t("browserUnavailable");
  }
  if (snapshot.phase === "checking") {
    return t("checking");
  }
  return snapshot.phase === "up_to_date" ? t("checkAgain") : t("check");
}

function installButtonLabel(snapshot: DesktopUpdateSnapshot, t: TFunction<"updates">): string {
  if (snapshot.phase === "downloading") {
    return t("downloading", { percent: snapshot.progressPercent ?? 0 });
  }
  if (snapshot.phase === "installing") {
    return t("installing");
  }
  return t("install");
}

function formatPublishedAt(value: string, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
