import { Brain, Folder, Info, RefreshCw, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MemorySnapshot, MemoryStore } from "../services";

export function MemoryPage({ memoryStore }: { memoryStore: MemoryStore }) {
  const { t } = useTranslation("memory");
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void memoryStore.load().then(
      (nextSnapshot) => {
        if (!cancelled) {
          setSnapshot(nextSnapshot);
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memoryStore, reloadToken]);

  const memoryCount = useMemo(() => {
    if (!snapshot) return 0;
    return snapshot.userMemories.length
      + snapshot.workspaces.reduce((total, workspace) => total + workspace.memories.length, 0);
  }, [snapshot]);
  const orderedWorkspaces = useMemo(() => {
    if (!snapshot) return [];
    return [...snapshot.workspaces].sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      return left.path.localeCompare(right.path);
    });
  }, [snapshot]);
  const workspaceCount = snapshot?.workspaces.filter((workspace) => workspace.memories.length > 0).length ?? 0;

  const reload = () => setReloadToken((token) => token + 1);

  return (
    <div className="react-memory-page">
      <div className="react-memory-overview">
        <p>{t("overview")}</p>
        <button aria-label={t("refresh")} disabled={loading} onClick={reload} type="button">
          <RefreshCw aria-hidden="true" className={loading ? "react-memory-spinner" : undefined} size={15} />
          {loading ? t("refreshing") : t("refreshAction")}
        </button>
      </div>

      <aside className="react-memory-note">
        <Info aria-hidden="true" size={17} />
        <div>
          <strong>{t("usedWhen")}</strong>
          <p>{t("snapshotNote")}</p>
        </div>
      </aside>

      {error ? (
        <div className="react-memory-error" role="alert">
          <div>
            <strong>{t("loadFailed")}</strong>
            <span>{error}</span>
          </div>
          <button disabled={loading} onClick={reload} type="button">{t("retry")}</button>
        </div>
      ) : null}

      {loading && !snapshot ? <p className="react-memory-status" role="status">{t("loading")}</p> : null}

      {snapshot ? (
        memoryCount === 0 ? (
          <div className="react-memory-empty">
            <Brain aria-hidden="true" size={22} />
            <strong>{t("emptyTitle")}</strong>
            <p>{t("emptyDescription")}</p>
          </div>
        ) : (
          <>
            <div className="react-memory-summary" aria-label={t("summary.label")}>
              <span>{t("summary.total", { count: memoryCount })}</span>
              <i aria-hidden="true" />
              <span>{t("summary.user", { count: snapshot.userMemories.length })}</span>
              <i aria-hidden="true" />
              <span>{t("summary.workspace", { count: workspaceCount })}</span>
            </div>

            <UserMemorySection memories={snapshot.userMemories} />

            <section className="react-memory-section" aria-labelledby="workspace-memory-heading">
              <header>
                <Folder aria-hidden="true" size={17} />
                <div>
                  <h2 id="workspace-memory-heading">{t("workspace.title")}</h2>
                  <p>{t("workspace.description")}</p>
                </div>
              </header>
              <div className="react-memory-workspaces">
                {orderedWorkspaces.map((workspace) => (
                  <article className="react-memory-workspace" data-current={workspace.current || undefined} key={workspace.path}>
                    <header>
                      <div>
                        <code title={workspace.path}>{workspace.path}</code>
                        {workspace.current ? <span>{t("workspace.current")}</span> : null}
                      </div>
                      <small>{t("workspace.count", { count: workspace.memories.length })}</small>
                    </header>
                    {workspace.memories.length > 0 ? (
                      <MemoryList memories={workspace.memories} />
                    ) : (
                      <p className="react-memory-scope-empty">{t("workspace.empty")}</p>
                    )}
                  </article>
                ))}
              </div>
            </section>
          </>
        )
      ) : null}
    </div>
  );
}

function UserMemorySection({ memories }: { memories: string[] }) {
  const { t } = useTranslation("memory");
  return (
    <section className="react-memory-section" aria-labelledby="user-memory-heading">
      <header>
        <UserRound aria-hidden="true" size={17} />
        <div>
          <h2 id="user-memory-heading">{t("user.title")}</h2>
          <p>{t("user.description")}</p>
        </div>
      </header>
      {memories.length > 0 ? (
        <MemoryList memories={memories} />
      ) : (
        <p className="react-memory-scope-empty">{t("user.empty")}</p>
      )}
    </section>
  );
}

function MemoryList({ memories }: { memories: string[] }) {
  return (
    <ul className="react-memory-list">
      {memories.map((memory, index) => <li key={`${index}:${memory}`}>{memory}</li>)}
    </ul>
  );
}
