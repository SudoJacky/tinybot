import {
  Brain,
  Folder,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryEntry, MemoryMutation, MemorySnapshot, MemoryStore } from "../services";
import { MemoryDeleteDialog, MemoryEditor } from "./MemoryEditor";

type Dialog =
  | { kind: "edit"; entry: MemoryEntry | null; revision: number }
  | { kind: "delete"; entries: MemoryEntry[]; revision: number };

export function MemoryPage({ memoryStore }: { memoryStore: MemoryStore }) {
  const { t } = useTranslation("memory");
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pending, setPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void memoryStore.load().then(
      (next) => {
        if (!cancelled) {
          setSnapshot(next);
          setLoading(false);
          setSelected(new Set());
        }
      },
      (cause: unknown) => {
        console.error("[memory-page] load failed", cause);
        if (!cancelled) {
          setError(String(cause));
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memoryStore, reloadToken]);
  const workspacePaths = useMemo(
    () =>
      snapshot
        ? [
            ...new Set([
              snapshot.currentWorkspacePath,
              ...snapshot.entries.flatMap((entry) => (entry.path ? [entry.path] : [])),
            ]),
          ]
        : [],
    [snapshot],
  );
  const entries = snapshot?.entries ?? [];
  const visible = entries.filter((entry) => {
    const scopeMatches =
      filter === "all" ||
      (filter === "user"
        ? entry.scope === "user"
        : filter === "current"
          ? entry.path === snapshot?.currentWorkspacePath
          : entry.scope === "workspace" && entry.path !== snapshot?.currentWorkspacePath);
    return (
      scopeMatches &&
      `${entry.content} ${entry.path ?? ""}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase())
    );
  });
  const groups = workspacePaths
    .map((path) => ({ path, entries: visible.filter((entry) => entry.path === path) }))
    .filter((group) => group.entries.length);
  const busy = loading || pending;
  function openDialog(next: Dialog) {
    setSaveError(null);
    setNotice("");
    setDialog(next);
  }
  async function mutate(mutation: MemoryMutation) {
    if (!dialog || pending) return;
    setPending(true);
    setSaveError(null);
    try {
      const next = await memoryStore.mutate({ expectedRevision: dialog.revision, mutation });
      setSnapshot(next);
      setDialog(null);
      setSelected(new Set());
      setSelecting(false);
      setNotice(t(mutation.operation === "delete" ? "manage.deleted" : "manage.saved"));
    } catch (cause) {
      console.error("[memory-page] mutation failed", { operation: mutation.operation, cause });
      setSaveError(t("manage.saveFailed", { message: String(cause) }));
    } finally {
      setPending(false);
    }
  }
  function renderList(list: MemoryEntry[]) {
    return (
      <ul className="react-memory-list">
        {list.map((entry) => (
          <li key={entry.id}>
            {selecting ? (
              <input
                type="checkbox"
                aria-label={t("manage.selectEntry", { content: entry.content })}
                checked={selected.has(entry.id)}
                disabled={busy}
                onChange={(event) =>
                  setSelected((old) => {
                    const next = new Set(old);
                    if (event.target.checked) next.add(entry.id);
                    else next.delete(entry.id);
                    return next;
                  })
                }
              />
            ) : null}
            <div className="react-memory-entry">
              <span>{entry.content}</span>
              {entry.userManaged ? (
                <small title={t("manage.protectionNote")}>
                  <ShieldCheck size={12} aria-hidden="true" />
                  {t("manage.userManaged")}
                </small>
              ) : null}
            </div>
            <div className="react-memory-row-actions">
              <button
                title={t("manage.edit")}
                aria-label={t("manage.editEntry", { content: entry.content })}
                disabled={busy}
                onClick={() => openDialog({ kind: "edit", entry, revision: snapshot!.revision })}
              >
                <Pencil size={15} aria-hidden="true" />
              </button>
              <button
                title={t("manage.delete")}
                aria-label={t("manage.deleteEntry", { content: entry.content })}
                disabled={busy}
                onClick={() =>
                  openDialog({ kind: "delete", entries: [entry], revision: snapshot!.revision })
                }
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="react-memory-page">
      <div className="react-memory-overview">
        <p>{t("overview")}</p>
        <div className="react-memory-toolbar-actions">
          <button
            disabled={busy || !snapshot}
            className="react-memory-primary"
            onClick={() => openDialog({ kind: "edit", entry: null, revision: snapshot!.revision })}
          >
            <Plus size={15} aria-hidden="true" />
            {t("manage.add")}
          </button>
          <button
            aria-label={t("refresh")}
            disabled={busy}
            onClick={() => {
              setNotice("");
              setReloadToken((value) => value + 1);
            }}
          >
            <RefreshCw
              size={15}
              aria-hidden="true"
              className={loading ? "react-memory-spinner" : undefined}
            />
            {t(loading ? "refreshing" : "refreshAction")}
          </button>
        </div>
      </div>
      <aside className="react-memory-note">
        <Info size={17} aria-hidden="true" />
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
          <button disabled={busy} onClick={() => setReloadToken((value) => value + 1)}>
            {t("retry")}
          </button>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="react-memory-feedback">
          {notice}
        </p>
      ) : null}
      {loading && !snapshot ? <p role="status">{t("loading")}</p> : null}
      {snapshot ? (
        <>
          <div className="react-memory-filters">
            <label className="react-memory-search">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label={t("manage.search")}
                placeholder={t("manage.search")}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelected(new Set());
                }}
              />
            </label>
            <select
              aria-label={t("manage.filter")}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setSelected(new Set());
              }}
            >
              <option value="all">{t("manage.filterAll")}</option>
              <option value="user">{t("user.title")}</option>
              <option value="current">{t("workspace.current")}</option>
              <option value="other">{t("manage.otherWorkspaces")}</option>
            </select>
            <button
              disabled={busy || entries.length === 0}
              onClick={() => {
                setSelecting(!selecting);
                setSelected(new Set());
              }}
            >
              {t(selecting ? "manage.done" : "manage.select")}
            </button>
          </div>
          {selecting ? (
            <div className="react-memory-selection">
              <label>
                <input
                  type="checkbox"
                  aria-label={t("manage.selectVisible")}
                  checked={visible.length > 0 && visible.every((entry) => selected.has(entry.id))}
                  disabled={!visible.length || busy}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked ? new Set(visible.map((entry) => entry.id)) : new Set(),
                    )
                  }
                />
                {t("manage.selectVisible")}
              </label>
              <span>{t("manage.selected", { count: selected.size })}</span>
              <button
                className="react-memory-danger"
                disabled={busy || selected.size === 0}
                onClick={() =>
                  openDialog({
                    kind: "delete",
                    entries: entries.filter((entry) => selected.has(entry.id)),
                    revision: snapshot.revision,
                  })
                }
              >
                {t("manage.deleteSelected")}
              </button>
            </div>
          ) : null}
          <div className="react-memory-summary" aria-label={t("summary.label")}>
            <span>{t("summary.total", { count: entries.length })}</span>
            <i />
            <span>
              {t("summary.user", {
                count: entries.filter((entry) => entry.scope === "user").length,
              })}
            </span>
            <i />
            <span>
              {t("summary.workspace", {
                count: new Set(entries.flatMap((entry) => (entry.path ? [entry.path] : []))).size,
              })}
            </span>
          </div>
          {entries.length === 0 ? (
            <div className="react-memory-empty">
              <Brain size={22} />
              <strong>{t("emptyTitle")}</strong>
              <p>{t("emptyDescription")}</p>
            </div>
          ) : visible.length === 0 ? (
            <p className="react-memory-status">{t("manage.noMatches")}</p>
          ) : (
            <>
              {visible.some((entry) => entry.scope === "user") ? (
                <section className="react-memory-section" aria-labelledby="user-memory-heading">
                  <header>
                    <UserRound size={17} />
                    <div>
                      <h2 id="user-memory-heading">{t("user.title")}</h2>
                      <p>{t("user.description")}</p>
                    </div>
                  </header>
                  {renderList(visible.filter((entry) => entry.scope === "user"))}
                </section>
              ) : null}
              {groups.length ? (
                <section
                  className="react-memory-section"
                  aria-labelledby="workspace-memory-heading"
                >
                  <header>
                    <Folder size={17} />
                    <div>
                      <h2 id="workspace-memory-heading">{t("workspace.title")}</h2>
                      <p>{t("workspace.description")}</p>
                    </div>
                  </header>
                  <div className="react-memory-workspaces">
                    {groups.map((group) => (
                      <article
                        className="react-memory-workspace"
                        key={group.path}
                        data-current={group.path === snapshot.currentWorkspacePath || undefined}
                      >
                        <header>
                          <div>
                            <code title={group.path}>{group.path}</code>
                            {group.path === snapshot.currentWorkspacePath ? (
                              <span>{t("workspace.current")}</span>
                            ) : null}
                          </div>
                          <small>{t("workspace.count", { count: group.entries.length })}</small>
                        </header>
                        {renderList(group.entries)}
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}
            </>
          )}
        </>
      ) : null}
      {dialog?.kind === "edit" ? (
        <MemoryEditor
          entry={dialog.entry}
          workspacePaths={workspacePaths}
          pending={pending}
          error={saveError}
          onClose={() => setDialog(null)}
          onSave={(mutation) => void mutate(mutation)}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <MemoryDeleteDialog
          entries={dialog.entries}
          pending={pending}
          error={saveError}
          onClose={() => setDialog(null)}
          onDelete={() =>
            void mutate({ operation: "delete", ids: dialog.entries.map((entry) => entry.id) })
          }
        />
      ) : null}
    </div>
  );
}
