import { AddWorkspaceButton } from "../lib/AddWorkspaceButton";
import { SettingsChoiceList } from "../settings/SettingsChoiceList";
import { SessionSidebarResizeHandle } from "../chat/SessionSidebarResizeHandle";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronLeft,
  ChevronDown,
  PanelLeftOpen,
  Clock,
  Folder,
  MessageSquare,
  Settings,
  Users,
  FileText,
  Plus,
} from "lucide-react";
import type { TeamMember } from "../../app-core/native/desktopNativeTeams";
import type { AppServices, WorkspaceRegistryEntry } from "../services";
import type { AppRoute } from "../shell/appRoutes";
import { TeamDetail } from "./TeamDetail";
import { useTeamRuns } from "./useTeamRuns";
import { TeamRunningIndicator } from "./TeamTaskStatus";
import "./teams.css";

export default function TeamsRoute({
  services,
  onOpenThread,
  onNavigate,
}: {
  services: Pick<AppServices, "teamStore" | "workspaceRegistryStore" | "workspaceStore"> & Partial<Pick<AppServices, "chatStore">>;
  onOpenThread: (id: string) => Promise<void>;
  onNavigate: (route: AppRoute) => void;
}) {
  const { t } = useTranslation("common");
  const state = useTeamRuns(services.teamStore);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const [workspaces, setWorkspaces] = useState<WorkspaceRegistryEntry[]>([]);
  const [workspace, setWorkspace] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [goal, setGoal] = useState("");
  const [members, setMembers] = useState<TeamMember[]>(() => [
    {
      id: "research",
      displayName: t("teams.research"),
      instructions: t("teams.researchInstructions"),
    },
    {
      id: "analysis",
      displayName: t("teams.analyst"),
      instructions: t("teams.analystInstructions"),
    },
    {
      id: "editor",
      displayName: t("teams.editor"),
      instructions: t("teams.editorInstructions"),
    },
  ]);
  useEffect(() => {
    let active = true;
    setWorkspaceError(null);
    void services.workspaceRegistryStore
      .list()
      .then((values) => {
        if (active) {
          setWorkspaces(values);
          setWorkspace((previous) =>
            values.some((w) => w.exists && w.path === previous)
              ? previous
              : (values.find((w) => w.exists)?.path ?? ""),
          );
        }
      })
      .catch((e) => {
        if (active) setWorkspaceError(String(e));
      });
    return () => {
      active = false;
    };
  }, [services.workspaceRegistryStore, workspaceEpoch]);
  function home() {
    state.setSelectedId(null);
  }
  const visibleRuns = state.runs.filter((run) => !workspace || run.spec.workspacePath === workspace);
  return (
    <div className="team-layout">
      <aside
        className="react-session-list team-sidebar"
        data-collapsed={sidebarCollapsed}
        aria-label={t("routes.teams")}
      >
        <SessionSidebarResizeHandle
          collapsed={sidebarCollapsed}
          onCollapsedChange={setSidebarCollapsed}
        />
        <div className="react-session-list__header team-sidebar-heading">
          <h2 hidden={sidebarCollapsed}>Tinybot</h2>
          <button
            className="react-session-list__collapse"
            aria-label={t(
              sidebarCollapsed
                ? "shell.expandSidebar"
                : "shell.collapseSidebar",
              { ns: "chat" },
            )}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        </div>
        <nav>
          <button
            className="react-session-list__scheduled"
            disabled={editing || state.busy}
            aria-label={t("routes.chat")}
            onClick={() => onNavigate("chat")}
          >
            <MessageSquare size={16} />
            <span>{t("routes.chat")}</span>
          </button>
          <button
            className="react-session-list__scheduled"
            disabled={editing || state.busy}
            aria-current="page"
            aria-label={t("routes.teams")}
            onClick={home}
          >
            <Users size={16} />
            <span>{t("routes.teams")}</span>
          </button>
          <button
            className="react-session-list__scheduled"
            disabled={editing || state.busy}
            aria-label={t("routes.automations")}
            onClick={() => onNavigate("automations")}
          >
            <Clock size={16} />
            <span>{t("routes.automations")}</span>
          </button>
        </nav>
        <div className="team-projects">
          <p>{t("teams.workspace")}</p>
          {workspaces.map((w) => (
            <button
              className="react-session-list__scheduled"
              key={w.path}
              disabled={!w.exists || state.busy || editing}
              title={w.path}
              aria-current={(state.run?.spec.workspacePath ?? workspace) === w.path ? "true" : undefined}
              onClick={() => {
                setWorkspace(w.path);
                home();
              }}
            >
              <Folder size={18} />
              <span>{w.name}</span>
            </button>
          ))}
        </div>
        <button
          className="react-session-list__scheduled team-settings"
          disabled={editing || state.busy}
          aria-label={t("routes.settings")}
          onClick={() => onNavigate("settings")}
        >
          <Settings size={16} />
          <span>{t("routes.settings")}</span>
        </button>
      </aside>
      <main className="team-main">
        <div className="team-tabbar">
          <div className="react-session-tabs">
            <div className="react-session-tab" data-active="true">
              <div className="react-session-tab__select">
                <span>{t("routes.teams")}</span>
              </div>
            </div>
          </div>
          {state.run && (
            <button disabled={state.busy || editing} onClick={home}>
              <Plus size={16} />
              {t("teams.newTeam")}
            </button>
          )}
        </div>
        <div className="react-workbench-page react-form-controls team-page" data-detail={!!state.run}>
          {(state.error || workspaceError) && (
            <div className="team-error" role="alert">
              {state.error || workspaceError}
              <button
                onClick={() => {
                  setWorkspaceEpoch((value) => value + 1);
                  void state.refresh();
                }}
              >
                {t("teams.refresh")}
              </button>
            </div>
          )}
          {state.run ? (
            <TeamDetail
              workspaceStore={services.workspaceStore}
              activitySource={services.chatStore}
              loadUsageDetails={services.teamStore.loadUsageDetails}
              key={state.run.id}
              run={state.run}
              busy={state.busy}
              pending={state.pending}
              onEditingChange={setEditing}
              onBack={home}
              onExecute={() => state.execute(state.run!)}
              onControl={state.control}
              onRevise={(plan) =>
                state.action(() =>
                  services.teamStore.revise({
                    runId: state.run!.id,
                    expectedRevision: state.run!.revision,
                    plan,
                  }),
                )
              }
              onOpenThread={onOpenThread}
            />
          ) : (
            <>
              <header className="team-home-heading">
                <h1>{t("routes.teams")}</h1>
                <p>{t("teams.subtitle")}</p>
              </header>
              <form
                className="team-composer-area"
                onSubmit={(e) => {
                  e.preventDefault();
                  void state.action(
                    () =>
                      services.teamStore.prepare({
                        spec: {
                          goal: goal.trim(),
                          workspacePath: workspace,
                          members,
                          maxConcurrency: members.length,
                        },
                      }),
                    true,
                  );
                }}
              >
                <h2>{t("teams.hero")}</h2>
                <p>{t("teams.intro")}</p>
                <div className="team-composer">
                  <textarea
                    className="react-form-input"
                    required
                    aria-label={t("teams.goal")}
                    placeholder={t("teams.placeholder")}
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    disabled={state.busy}
                  />
                </div>
                <div className="team-composer-options">
                  <SettingsChoiceList
                    menuPosition="fixed"
                    label={t("teams.workspace")}
                    value={workspace}
                    disabled={state.busy}
                    onChange={setWorkspace}
                    options={[
                      {
                        value: "",
                        label: t("teams.chooseWorkspace"),
                        disabled: true,
                      },
                      ...workspaces.map((w) => ({
                        value: w.path,
                        label: w.name,
                        disabled: !w.exists,
                      })),
                    ]}
                  />
                  <AddWorkspaceButton store={services.workspaceRegistryStore} disabled={state.busy} onAdded={(entry) => { setWorkspaces((current) => [...current.filter((item) => item.path !== entry.path), entry]); setWorkspace(entry.path); }} />
                  <div className="team-roster-control">
                    <span className="react-settings-choice__label">{t("teams.members")}</span>
                    <button
                      type="button"
                      aria-expanded={membersOpen}
                      aria-controls="team-member-editor"
                      disabled={state.busy}
                      onClick={() => setMembersOpen(!membersOpen)}
                    >
                      <Users size={18} aria-hidden="true" />
                      <span>{t("teams.configureMembers")} · {members.length}</span>
                      <ChevronDown size={16} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {membersOpen && <div id="team-member-editor" className="team-member-editor">
                      <p>{t("teams.defaultModel")}</p>
                      {members.map((member, index) => (
                        <fieldset key={member.id} disabled={state.busy}>
                          <legend>{index + 1}</legend>
                          <label className="react-settings-choice__label">
                            {t("teams.memberName")}
                            <input
                              className="react-form-input"
                              required
                              value={member.displayName}
                              onChange={(e) =>
                                setMembers((previous) =>
                                  previous.map((m) =>
                                    m.id === member.id
                                      ? { ...m, displayName: e.target.value }
                                      : m,
                                  ),
                                )
                              }
                            />
                          </label>
                          <label className="react-settings-choice__label">
                            {t("teams.instructions")}
                            <textarea
                              className="react-form-input"
                              required
                              value={member.instructions}
                              onChange={(e) =>
                                setMembers((previous) =>
                                  previous.map((m) =>
                                    m.id === member.id
                                      ? { ...m, instructions: e.target.value }
                                      : m,
                                  ),
                                )
                              }
                            />
                          </label>
                        </fieldset>
                      ))}
                </div>}
                <div className="team-composer-submit">
                  <p role="status">{state.busy ? t("teams.generating") : ""}</p>
                  <button
                    className="react-form-primary"
                    disabled={state.busy || !goal.trim() || !workspace || members.some((m) => !m.displayName.trim() || !m.instructions.trim())}
                  >
                    {state.busy ? <TeamRunningIndicator /> : <ArrowRight size={18} />}
                    {state.busy ? t("teams.generating") : t("teams.generate")}
                  </button>
                </div>
              </form>
              <section className="team-recent">
                <div className="team-section-heading">
                  <h2>{t("teams.recent")}</h2>
                  <button
                    disabled={state.loading}
                    onClick={() => void state.refresh()}
                  >
                    {t("teams.refresh")}
                  </button>
                </div>
                {state.loading && <p role="status">{t("teams.loading")}</p>}
                {!state.loading && !visibleRuns.length && (
                  <p>{t(workspace ? "teams.workspaceEmpty" : "teams.empty")}</p>
                )}
                {visibleRuns.map((run) => (
                  <button
                    className="team-recent-row"
                    key={run.id}
                    disabled={state.busy}
                    onClick={() => {
                      state.setSelectedId(run.id);
                      void state.action(() => services.teamStore.get(run.id));
                    }}
                  >
                    <FileText size={21} />
                    <span className="team-recent-copy">
                      <strong title={run.spec.goal}>{run.spec.goal}</strong>
                      <small title={run.spec.workspacePath}>{run.spec.workspacePath.split(/[\\/]/).filter(Boolean).slice(-1)[0]}</small>
                    </span>
                    <span className={`team-status is-${run.status}`}>
                      {t(`teams.status.${run.status}`)}
                    </span>
                    <ArrowRight size={18} />
                  </button>
                ))}
              </section>
            </>
          )}
        </div>
      </main>
    </div>
  );
}
