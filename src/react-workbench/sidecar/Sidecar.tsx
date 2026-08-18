import {
  FileChartColumn,
  Globe2,
  Maximize2,
  Minimize2,
  MoreHorizontal,
  PanelRightClose,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  MIN_SIDECAR_WIDTH,
  type SidecarArtifactTab,
  type SidecarPresentation,
  type SidecarTab,
} from "./sidecarModel";
import "./Sidecar.css";

export type SidecarProps = {
  activeTabId: string;
  canCreateBrowser: boolean;
  canCreateTerminal: boolean;
  presentation: Exclude<SidecarPresentation, "closed">;
  tabs: readonly SidecarTab[];
  width: number;
  workspaceLabel: string;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tab: SidecarTab) => void;
  onCreateBrowser: () => void;
  onCreateTerminal: () => void;
  onHide: () => void;
  onResize: (width: number, maxWidth: number) => void;
  onToggleExpanded: () => void;
  renderArtifact: (tab: SidecarArtifactTab) => ReactNode;
};

export function Sidecar({
  activeTabId,
  canCreateBrowser,
  canCreateTerminal,
  onActivateTab,
  onCloseTab,
  onCreateBrowser,
  onCreateTerminal,
  onHide,
  onResize,
  onToggleExpanded,
  presentation,
  renderArtifact,
  tabs,
  width,
  workspaceLabel,
}: SidecarProps) {
  const { t } = useTranslation("chat");
  const [newTabMenuOpen, setNewTabMenuOpen] = useState(false);
  const newTabTriggerRef = useRef<HTMLButtonElement>(null);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const expanded = presentation === "expanded";

  useEffect(() => {
    setNewTabMenuOpen(false);
  }, [activeTabId]);

  useEffect(() => {
    if (!newTabMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!newTabMenuRef.current?.contains(event.target as Node)
        && !newTabTriggerRef.current?.contains(event.target as Node)) {
        setNewTabMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [newTabMenuOpen]);

  useLayoutEffect(() => {
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeTabId]);

  function openNewTabMenu() {
    setNewTabMenuOpen(true);
    window.requestAnimationFrame(() => {
      newTabMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    });
  }

  function createResource(kind: "browser" | "terminal") {
    setNewTabMenuOpen(false);
    if (kind === "browser") {
      onCreateBrowser();
    } else {
      onCreateTerminal();
    }
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = Array.from(newTabMenuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (direction && items.length) {
      event.preventDefault();
      items[(currentIndex + direction + items.length) % items.length]?.focus();
      return;
    }
    if (event.key === "Escape" || event.key === "Tab") {
      if (event.key === "Escape") {
        event.preventDefault();
        newTabTriggerRef.current?.focus();
      }
      setNewTabMenuOpen(false);
    }
  }

  function focusTab(tabId: string) {
    onActivateTab(tabId);
    window.requestAnimationFrame(() => tabRefs.current.get(tabId)?.focus());
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, tab: SidecarTab) {
    const index = tabs.findIndex((candidate) => candidate.id === tab.id);
    if (index < 0) return;
    let target: SidecarTab | undefined;
    if (event.key === "ArrowRight") {
      target = tabs[(index + 1) % tabs.length];
    } else if (event.key === "ArrowLeft") {
      target = tabs[(index - 1 + tabs.length) % tabs.length];
    } else if (event.key === "Home") {
      target = tabs[0];
    } else if (event.key === "End") {
      target = tabs[tabs.length - 1];
    } else if (event.key === "Delete") {
      event.preventDefault();
      onCloseTab(tab);
      return;
    }
    if (!target) return;
    event.preventDefault();
    focusTab(target.id);
  }

  function handleResizePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (expanded || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const resize = (pointerEvent: PointerEvent) => {
      onResize(startWidth + startX - pointerEvent.clientX, sidecarMaxWidth());
    };
    const stop = () => {
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (expanded) return;
    const increment = event.shiftKey ? 64 : 24;
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") {
      nextWidth = width + increment;
    } else if (event.key === "ArrowRight") {
      nextWidth = width - increment;
    } else if (event.key === "Home") {
      nextWidth = MIN_SIDECAR_WIDTH;
    } else if (event.key === "End") {
      nextWidth = sidecarMaxWidth();
    }
    if (nextWidth === undefined) return;
    event.preventDefault();
    onResize(nextWidth, sidecarMaxWidth());
  }

  return (
    <aside
      aria-label={t("sidecar.label")}
      className="react-sidecar"
      data-presentation={presentation}
      style={{ "--react-sidecar-width": `${width}px` } as CSSProperties}
    >
      <div
        aria-disabled={expanded || undefined}
        aria-label={t("sidecar.resize")}
        aria-orientation="vertical"
        aria-valuemax={sidecarMaxWidth()}
        aria-valuemin={MIN_SIDECAR_WIDTH}
        aria-valuenow={width}
        className="react-sidecar__resize"
        role="separator"
        tabIndex={expanded ? -1 : 0}
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        <span aria-hidden="true" />
      </div>

      <header className="react-sidecar__header">
        <div aria-label={t("sidecar.openTabs")} className="react-sidecar-tabs" role="tablist">
          {tabs.map((tab) => {
            const active = tab.id === activeTabId;
            const Icon = sidecarTabIcon(tab);
            const tabDomId = sidecarTabDomId(tab.id);
            return (
              <div className="react-sidecar-tab" data-active={active || undefined} key={tab.id}>
                <button
                  aria-controls="tinybot-sidecar-panel"
                  aria-selected={active}
                  className="react-sidecar-tab__select"
                  id={tabDomId}
                  ref={(element) => {
                    if (element) tabRefs.current.set(tab.id, element);
                    else tabRefs.current.delete(tab.id);
                  }}
                  role="tab"
                  tabIndex={active ? 0 : -1}
                  title={tab.title}
                  type="button"
                  onClick={() => onActivateTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, tab)}
                >
                  <Icon aria-hidden="true" size={15} />
                  <span>{tab.title}</span>
                </button>
                <button
                  aria-label={t("sidecar.closeTab", { name: tab.title })}
                  className="react-sidecar-tab__close"
                  title={t("sidecar.closeTab", { name: tab.title })}
                  type="button"
                  onClick={() => onCloseTab(tab)}
                >
                  <X aria-hidden="true" size={13} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="react-sidecar__controls">
          <div className="react-sidecar-new-tab">
            <button
              aria-expanded={newTabMenuOpen}
              aria-haspopup="menu"
              aria-label={t("sidecar.newTab")}
              ref={newTabTriggerRef}
              title={t("sidecar.newTab")}
              type="button"
              onClick={() => newTabMenuOpen ? setNewTabMenuOpen(false) : openNewTabMenu()}
            >
              <Plus aria-hidden="true" size={16} />
            </button>
            {newTabMenuOpen ? (
              <div
                aria-label={t("sidecar.newTabMenu")}
                className="react-sidecar-new-tab__menu"
                ref={newTabMenuRef}
                role="menu"
                onKeyDown={handleMenuKeyDown}
              >
                <button disabled={!canCreateBrowser} role="menuitem" type="button" onClick={() => createResource("browser")}>
                  <Globe2 aria-hidden="true" size={18} />
                  <span><strong>{t("sidecar.browser")}</strong><small>{t("sidecar.browserShared")}</small></span>
                </button>
                <button disabled={!canCreateTerminal} role="menuitem" type="button" onClick={() => createResource("terminal")}>
                  <SquareTerminal aria-hidden="true" size={18} />
                  <span><strong>{t("sidecar.terminal")}</strong><small>{t("sidecar.terminalPrivate")}</small></span>
                </button>
              </div>
            ) : null}
          </div>
          <button aria-label={t("sidecar.more")} disabled title={t("sidecar.more")} type="button">
            <MoreHorizontal aria-hidden="true" size={17} />
          </button>
          <span aria-hidden="true" className="react-sidecar__control-divider" />
          <button
            aria-label={expanded ? t("sidecar.restore") : t("sidecar.expand")}
            title={expanded ? t("sidecar.restore") : t("sidecar.expand")}
            type="button"
            onClick={onToggleExpanded}
          >
            {expanded ? <Minimize2 aria-hidden="true" size={15} /> : <Maximize2 aria-hidden="true" size={15} />}
          </button>
          <button aria-label={t("sidecar.hide")} title={t("sidecar.hide")} type="button" onClick={onHide}>
            <PanelRightClose aria-hidden="true" size={16} />
          </button>
        </div>
      </header>

      <div
        aria-labelledby={activeTab ? sidecarTabDomId(activeTab.id) : undefined}
        className="react-sidecar__panel"
        id="tinybot-sidecar-panel"
        role="tabpanel"
      >
        {activeTab?.kind === "browser" ? <BrowserPlaceholder /> : null}
        {activeTab?.kind === "terminal" ? (
          <TerminalPlaceholder shell={activeTab.shell} workspaceLabel={workspaceLabel} />
        ) : null}
        {activeTab?.kind === "artifact" ? (
          <div className="react-sidecar__artifact">{renderArtifact(activeTab)}</div>
        ) : null}
        {!activeTab ? (
          <SidecarEmptyState
            canCreateBrowser={canCreateBrowser}
            canCreateTerminal={canCreateTerminal}
            onOpenMenu={openNewTabMenu}
          />
        ) : null}
      </div>
    </aside>
  );
}

function BrowserPlaceholder() {
  const { t } = useTranslation("chat");
  return (
    <section className="react-sidecar-placeholder react-sidecar-browser" role="status">
      <Globe2 aria-hidden="true" size={24} />
      <h2>{t("sidecar.browserUnavailableTitle")}</h2>
      <p>{t("sidecar.browserUnavailableDescription")}</p>
      <small>{t("sidecar.browserShared")}</small>
    </section>
  );
}

function TerminalPlaceholder({ shell, workspaceLabel }: {
  shell: "powershell" | "cmd";
  workspaceLabel: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <section className="react-sidecar-terminal">
      <div className="react-sidecar-terminal__toolbar">
        <strong>{workspaceLabel || t("sidecar.workspace")}</strong>
        <span>{shell === "cmd" ? t("sidecar.commandPrompt") : t("sidecar.powerShell")}</span>
      </div>
      <div className="react-sidecar-terminal__viewport" role="status">
        <SquareTerminal aria-hidden="true" size={24} />
        <h2>{t("sidecar.terminalUnavailableTitle")}</h2>
        <p>{t("sidecar.terminalUnavailableDescription")}</p>
      </div>
      <footer>{t("sidecar.terminalStatus")}</footer>
    </section>
  );
}

function SidecarEmptyState({
  canCreateBrowser,
  canCreateTerminal,
  onOpenMenu,
}: {
  canCreateBrowser: boolean;
  canCreateTerminal: boolean;
  onOpenMenu: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <section className="react-sidecar-placeholder react-sidecar-empty">
      <div aria-hidden="true" className="react-sidecar-empty__icons">
        <Globe2 size={20} />
        <SquareTerminal size={20} />
      </div>
      <h2>{t("sidecar.emptyTitle")}</h2>
      <p>{t("sidecar.emptyDescription")}</p>
      <button disabled={!canCreateBrowser && !canCreateTerminal} type="button" onClick={onOpenMenu}>
        <Plus aria-hidden="true" size={15} />
        {t("sidecar.newTab")}
      </button>
    </section>
  );
}

function sidecarTabIcon(tab: SidecarTab) {
  if (tab.kind === "browser") return Globe2;
  if (tab.kind === "terminal") return SquareTerminal;
  return FileChartColumn;
}

function sidecarTabDomId(tabId: string): string {
  return `tinybot-sidecar-tab-${tabId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function sidecarMaxWidth(): number {
  return Math.max(MIN_SIDECAR_WIDTH, window.innerWidth - 420);
}
