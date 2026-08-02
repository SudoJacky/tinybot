import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Download,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createDesktopNativeUpdateClient,
  type DesktopUpdateClient,
  type DesktopUpdateSnapshot,
} from "../../app-core/native/desktopNativeUpdate";

type DesktopUpdateDialogsProps = {
  aboutOpenSignal: number;
  updateClient?: DesktopUpdateClient | null;
};

type OpenDialog = "about" | "update" | null;
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
}: DesktopUpdateDialogsProps) {
  const client = useMemo(
    () => updateClient === undefined ? createDesktopNativeUpdateClient() : updateClient,
    [updateClient],
  );
  const [snapshot, setSnapshot] = useState<DesktopUpdateSnapshot>(browserPreviewSnapshot);
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const dismissedVersionRef = useRef<string | null>(null);
  const lastAboutSignalRef = useRef(aboutOpenSignal);
  const primaryActionRef = useRef<HTMLButtonElement>(null);

  const acceptSnapshot = useCallback((next: DesktopUpdateSnapshot) => {
    setSnapshot(next);
    if (
      next.phase === "available"
      && next.availableVersion
      && dismissedVersionRef.current !== next.availableVersion
    ) {
      setOpenDialog("update");
    }
  }, []);

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
    if (openDialog) {
      primaryActionRef.current?.focus();
    }
  }, [openDialog]);

  useEffect(() => {
    if (!openDialog) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isUpdateBusy(snapshot.phase, pendingAction)) {
        closeDialog();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openDialog, pendingAction, snapshot.phase]);

  function closeDialog() {
    if (isUpdateBusy(snapshot.phase, pendingAction)) {
      return;
    }
    if (openDialog === "update" && snapshot.availableVersion) {
      dismissedVersionRef.current = snapshot.availableVersion;
    }
    setActionError(null);
    setOpenDialog(null);
  }

  async function checkForUpdate() {
    if (!client) {
      setActionError("Update checks are only available in the Tinybot desktop app.");
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
      setActionError("No reviewed update is available to install.");
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

  if (!openDialog) {
    return null;
  }

  const busy = isUpdateBusy(snapshot.phase, pendingAction);
  const error = actionError ?? snapshot.error;
  const isUpdatePrompt = openDialog === "update" && Boolean(snapshot.availableVersion);
  const dialogLabel = isUpdatePrompt ? "Tinybot update available" : "About Tinybot";

  return (
    <div
      className="desktop-update-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          closeDialog();
        }
      }}
    >
      <section
        aria-label={dialogLabel}
        aria-modal="true"
        className="desktop-update-dialog"
        role="dialog"
      >
        <header className="desktop-update-dialog__header">
          <span className="desktop-update-dialog__mark" aria-hidden="true">
            <Bot size={24} strokeWidth={1.8} />
          </span>
          <div>
            <p>{isUpdatePrompt ? "Software update" : "Tinybot Desktop"}</p>
            <h2>{isUpdatePrompt ? `Tinybot ${snapshot.availableVersion} is available` : "About Tinybot"}</h2>
          </div>
          <button
            aria-label="Close"
            className="desktop-update-dialog__close"
            disabled={busy}
            title="Close"
            type="button"
            onClick={closeDialog}
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {isUpdatePrompt ? (
          <UpdateAvailableContent snapshot={snapshot} />
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
        ) : (
          <UpdateStatus snapshot={snapshot} />
        )}

        <footer className="desktop-update-dialog__actions">
          {isUpdatePrompt ? (
            <>
              <button disabled={busy} type="button" onClick={closeDialog}>Later</button>
              <button
                className="desktop-update-dialog__primary"
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
                {installButtonLabel(snapshot)}
              </button>
            </>
          ) : (
            <button
              className="desktop-update-dialog__primary"
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
              {checkButtonLabel(snapshot, Boolean(client))}
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
  return (
    <div className="desktop-update-dialog__about">
      <div className="desktop-update-dialog__version-row">
        <span>Current version</span>
        <strong>v{snapshot.currentVersion}</strong>
      </div>
      <p>
        Tinybot is a desktop AI workspace for conversations, tools, and local project work.
      </p>
      {snapshot.phase === "available" && snapshot.availableVersion ? (
        <button
          className="desktop-update-dialog__available-link"
          type="button"
          onClick={onReviewUpdate}
        >
          Version {snapshot.availableVersion} is ready to review
        </button>
      ) : null}
    </div>
  );
}

function UpdateAvailableContent({ snapshot }: { snapshot: DesktopUpdateSnapshot }) {
  return (
    <div className="desktop-update-dialog__release">
      <div className="desktop-update-dialog__version-row">
        <span>Version</span>
        <strong>v{snapshot.currentVersion} → v{snapshot.availableVersion}</strong>
        {snapshot.publishedAt ? <small>{formatPublishedAt(snapshot.publishedAt)}</small> : null}
      </div>
      {snapshot.displayNotes ? (
        <aside className="desktop-update-dialog__notice">
          <strong>Before you update</strong>
          <p>{snapshot.displayNotes}</p>
        </aside>
      ) : null}
      <section className="desktop-update-dialog__notes">
        <h3>What&apos;s new</h3>
        <p>{snapshot.releaseNotes ?? "No release notes were provided for this update."}</p>
      </section>
      {snapshot.phase === "downloading" || snapshot.phase === "installing" ? (
        <div className="desktop-update-dialog__progress">
          <div>
            <span>{snapshot.phase === "installing" ? "Preparing installer" : "Downloading update"}</span>
            <strong>{snapshot.progressPercent ?? 0}%</strong>
          </div>
          <progress max={100} value={snapshot.progressPercent ?? 0} />
        </div>
      ) : null}
    </div>
  );
}

function UpdateStatus({ snapshot }: { snapshot: DesktopUpdateSnapshot }) {
  if (snapshot.phase !== "up_to_date") {
    return null;
  }
  return (
    <p className="desktop-update-dialog__status" role="status">
      <CheckCircle2 aria-hidden="true" size={16} />
      <span>You&apos;re using the latest version.</span>
    </p>
  );
}

function isUpdateBusy(phase: DesktopUpdateSnapshot["phase"], pendingAction: PendingAction): boolean {
  return pendingAction !== null || phase === "checking" || phase === "downloading" || phase === "installing";
}

function checkButtonLabel(snapshot: DesktopUpdateSnapshot, available: boolean): string {
  if (!available) {
    return "Unavailable in browser preview";
  }
  if (snapshot.phase === "checking") {
    return "Checking…";
  }
  return snapshot.phase === "up_to_date" ? "Check again" : "Check for updates";
}

function installButtonLabel(snapshot: DesktopUpdateSnapshot): string {
  if (snapshot.phase === "downloading") {
    return `Downloading ${snapshot.progressPercent ?? 0}%`;
  }
  if (snapshot.phase === "installing") {
    return "Installing…";
  }
  return "Download and install";
}

function formatPublishedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
