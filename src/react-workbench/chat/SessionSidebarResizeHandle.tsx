import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";

const STORAGE_KEY = "tinybot.session-sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 420;
const MIN_CHAT_WIDTH = 480;
const COLLAPSE_DISTANCE = 48;

function readWidth(): number {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === null) return DEFAULT_WIDTH;
  const width = Number(stored);
  if (!Number.isFinite(width) || width < MIN_WIDTH || width > MAX_WIDTH) {
    console.warn("[session-sidebar] Invalid saved width", { width: stored });
    return DEFAULT_WIDTH;
  }
  return width;
}

type Drag = {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  moved: boolean;
  collapsed: boolean;
  handle: HTMLElement;
  cursor: string;
  userSelect: string;
};

/** Updates sidebar geometry directly so pointer movement never rerenders Chat content. */
export function SessionSidebarResizeHandle({ collapsed, onCollapsedChange }: {
  collapsed: boolean;
  onCollapsedChange(collapsed: boolean): void;
}) {
  const { t } = useTranslation("chat");
  const sidebarRef = useRef<HTMLElement | null>(null);
  // The handle is a direct child of the sidebar; bind before layout effects run.
  const attachHandle = useCallback((element: HTMLDivElement | null) => {
    sidebarRef.current = element?.parentElement ?? null;
  }, []);
  const [geometry, setGeometry] = useState(() => ({ width: readWidth(), maximum: MAX_WIDTH }));
  const preferenceRef = useRef(geometry.width);
  const maximum = useRef(MAX_WIDTH);
  const drag = useRef<Drag | null>(null);
  const [dragging, setDragging] = useState(false);

  const applyWidth = useCallback((width: number) => {
    const clamped = Math.round(Math.max(MIN_WIDTH, Math.min(maximum.current, width)));
    sidebarRef.current?.style.setProperty("--session-sidebar-width", `${clamped}px`);
    setGeometry((current) => current.width === clamped && current.maximum === maximum.current
      ? current : { width: clamped, maximum: maximum.current });
    return clamped;
  }, [sidebarRef]);

  function saveWidth(width: number) {
    const value = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, width));
    window.localStorage.setItem(STORAGE_KEY, String(value));
    preferenceRef.current = value;
    applyWidth(value);
  }

  const releaseDrag = useCallback(() => {
    const current = drag.current;
    if (!current) return null;
    drag.current = null;
    setDragging(false);
    if (current.collapsed) sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    sidebarRef.current?.removeAttribute("data-resizing");
    current.handle.style.removeProperty("--collapse-progress");
    document.body.style.cursor = current.cursor;
    document.body.style.userSelect = current.userSelect;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    return current;
  }, [sidebarRef]);

  const cancelDrag = useCallback(() => {
    if (!drag.current) return;
    applyWidth(preferenceRef.current);
    releaseDrag();
  }, [applyWidth, releaseDrag]);

  useLayoutEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const container = sidebar.parentElement!;
    function updateMaximum() {
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (container.clientWidth || window.innerWidth) - MIN_CHAT_WIDTH));
      if (drag.current && next === maximum.current) return;
      // A window resize cancels an unfinished gesture without changing the saved preference.
      if (next !== maximum.current) cancelDrag();
      maximum.current = next;
      applyWidth(preferenceRef.current);
    }
    updateMaximum();
    const observer = new ResizeObserver(updateMaximum);
    observer.observe(container);
    window.addEventListener("blur", cancelDrag);
    return () => {
      observer.disconnect();
      window.removeEventListener("blur", cancelDrag);
      releaseDrag();
    };
  }, [applyWidth, cancelDrag, releaseDrag, sidebarRef]);

  useLayoutEffect(() => {
    // A collapse/expand produced by this gesture must retain capture and focus.
    if (drag.current?.collapsed === collapsed) return;
    if (drag.current) cancelDrag();
    if (collapsed) {
      if (document.activeElement === sidebarRef.current?.querySelector(".react-session-sidebar-resize")) {
        sidebarRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      }
    }
    applyWidth(preferenceRef.current);
  }, [applyWidth, cancelDrag, collapsed, sidebarRef]);

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || collapsed || drag.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    const sidebar = sidebarRef.current!;
    const width = sidebar.getBoundingClientRect().width;
    drag.current = {
      pointerId: event.pointerId, startX: event.clientX, startWidth: width,
      width, moved: false, collapsed: false, handle: event.currentTarget,
      cursor: document.body.style.cursor, userSelect: document.body.style.userSelect,
    };
    sidebar.setAttribute("data-resizing", "true");
    setDragging(true);
    applyWidth(width);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const rawWidth = current.startWidth + event.clientX - current.startX;
    current.moved ||= event.clientX !== current.startX;
    current.width = applyWidth(rawWidth);
    current.handle.style.setProperty("--collapse-progress", String(Math.min(1, Math.max(0, (MIN_WIDTH - rawWidth) / COLLAPSE_DISTANCE))));
    if (!current.collapsed && rawWidth <= MIN_WIDTH - COLLAPSE_DISTANCE) {
      current.collapsed = true;
      onCollapsedChange(true);
    } else if (current.collapsed && rawWidth >= MIN_WIDTH) {
      current.collapsed = false;
      onCollapsedChange(false);
    }
  }

  return <div
    ref={attachHandle}
    className="react-session-sidebar-resize"
    role="separator"
    aria-label={t("shell.resizeSidebar")}
    aria-orientation="vertical"
    aria-valuemin={MIN_WIDTH}
    aria-valuemax={geometry.maximum}
    aria-valuenow={geometry.width}
    aria-valuetext={t("shell.sidebarWidth", { width: geometry.width })}
    title={t("shell.resizeSidebarHint")}
    tabIndex={collapsed && !dragging ? -1 : 0}
    aria-hidden={(collapsed && !dragging) || undefined}
    onPointerDown={startDrag}
    onPointerMove={moveDrag}
    onPointerUp={(event) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      const completed = releaseDrag();
      if (completed?.collapsed) applyWidth(preferenceRef.current);
      else if (completed?.moved) saveWidth(completed.width);
    }}
    onPointerCancel={cancelDrag}
    onLostPointerCapture={cancelDrag}
    onDoubleClick={() => saveWidth(DEFAULT_WIDTH)}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); cancelDrag(); return; }
      if (drag.current) return;
      const step = event.shiftKey ? 32 : 8;
      const width = event.key === "ArrowLeft" ? geometry.width - step
        : event.key === "ArrowRight" ? geometry.width + step
        : event.key === "Home" ? MIN_WIDTH
        : event.key === "End" ? geometry.maximum : undefined;
      if (width === undefined) return;
      event.preventDefault();
      saveWidth(Math.max(MIN_WIDTH, Math.min(geometry.maximum, width)));
    }}
  />;
}
