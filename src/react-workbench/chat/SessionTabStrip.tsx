import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type WheelEvent } from "react";
import { AlertTriangle, Circle, List, Loader2, Plus, X } from "lucide-react";
import type { SessionSummary } from "../services";

export type SessionTabItem = Pick<SessionSummary, "id" | "status"> & {
  title: string;
  unread: boolean;
};

export type SessionTabStripProps = {
  activeSessionId: string;
  tabs: SessionTabItem[];
  onActivate: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onCreate: () => void;
};

export function SessionTabStrip({
  activeSessionId,
  onActivate,
  onClose,
  onCreate,
  tabs,
}: SessionTabStripProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    setMenuOpen(false);
  }, [activeSessionId]);

  useLayoutEffect(() => {
    tabRefs.current.get(activeSessionId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeSessionId]);

  const focusTab = (sessionId: string) => {
    onActivate(sessionId);
    window.requestAnimationFrame(() => tabRefs.current.get(sessionId)?.focus());
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, sessionId: string) => {
    const index = tabs.findIndex((tab) => tab.id === sessionId);
    if (index < 0) {
      return;
    }
    let target: SessionTabItem | undefined;
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
      onClose(sessionId);
      return;
    }
    if (!target) {
      return;
    }
    event.preventDefault();
    focusTab(target.id);
  };

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    const scroller = event.currentTarget;
    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth;
    if (maxScrollLeft <= 0) {
      return;
    }

    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    const nextScrollLeft = Math.max(0, Math.min(maxScrollLeft, scroller.scrollLeft + delta));
    if (nextScrollLeft === scroller.scrollLeft) {
      return;
    }

    event.preventDefault();
    scroller.scrollLeft = nextScrollLeft;
  };

  return (
    <div className="react-session-tabs">
      <div
        className="react-session-tabs__scroller"
        aria-label="Open conversations"
        role="tablist"
        onWheel={handleWheel}
      >
        {tabs.length ? tabs.map((tab) => {
          const active = tab.id === activeSessionId;
          const statusLabel = sessionTabStatusLabel(tab);
          return (
            <div
              className="react-session-tab"
              data-active={active ? "true" : undefined}
              data-status={tab.status ?? "idle"}
              data-unread={tab.unread ? "true" : undefined}
              key={tab.id}
            >
              <button
                aria-controls="tinybot-chat-conversation"
                aria-label={`${tab.title}${statusLabel ? `, ${statusLabel}` : ""}`}
                aria-selected={active}
                className="react-session-tab__select"
                id={`tinybot-session-tab-${tab.id}`}
                ref={(element) => {
                  if (element) {
                    tabRefs.current.set(tab.id, element);
                  } else {
                    tabRefs.current.delete(tab.id);
                  }
                }}
                role="tab"
                tabIndex={active ? 0 : -1}
                title={tab.title}
                type="button"
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, tab.id)}
              >
                <SessionTabStatus tab={tab} />
                <span>{tab.title}</span>
              </button>
              <button
                aria-label={`Close ${tab.title} tab`}
                className="react-session-tab__close"
                title={`Close ${tab.title}`}
                type="button"
                onClick={() => onClose(tab.id)}
              >
                <X aria-hidden="true" size={13} strokeWidth={2} />
              </button>
            </div>
          );
        }) : (
          <div className="react-session-tab react-session-tab--draft" data-active="true">
            <button
              aria-controls="tinybot-chat-conversation"
              aria-label="新会话"
              aria-selected="true"
              className="react-session-tab__select"
              role="tab"
              tabIndex={0}
              type="button"
            >
              <span>新会话</span>
            </button>
          </div>
        )}
      </div>
      <div className="react-session-tabs__controls">
        <button aria-label="New conversation tab" title="New conversation" type="button" onClick={onCreate}>
          <Plus aria-hidden="true" size={16} />
        </button>
        {tabs.length > 1 ? (
          <div className="react-session-tabs__overflow">
            <button
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Open tabs menu"
              title="Open tabs"
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <List aria-hidden="true" size={15} />
            </button>
            {menuOpen ? (
              <div className="react-session-tabs__menu" role="menu">
                {tabs.map((tab) => (
                  <button
                    aria-current={tab.id === activeSessionId ? "page" : undefined}
                    key={tab.id}
                    role="menuitem"
                    type="button"
                    onClick={() => onActivate(tab.id)}
                  >
                    <SessionTabStatus tab={tab} />
                    <span className="react-session-tabs__menu-title">{tab.title}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SessionTabStatus({ tab }: { tab: SessionTabItem }) {
  if (tab.status === "running") {
    return <Loader2 aria-hidden="true" className="react-session-tab__status" data-kind="running" size={11} />;
  }
  if (tab.status === "failed") {
    return <AlertTriangle aria-hidden="true" className="react-session-tab__status" data-kind="failed" size={11} />;
  }
  if (tab.unread) {
    return <Circle aria-hidden="true" className="react-session-tab__status" data-kind="unread" fill="currentColor" size={8} />;
  }
  return null;
}

function sessionTabStatusLabel(tab: SessionTabItem): string {
  if (tab.status === "running") return "running";
  if (tab.status === "failed") return "failed";
  if (tab.unread) return "unread activity";
  return "";
}
