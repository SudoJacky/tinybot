import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ComposerContextReference } from "./claude-style-ai-input";
import "./ComposerAnnotations.css";

export function ComposerAnnotations({ references, onRemove }: {
  references: ComposerContextReference[];
  onRemove(id: string): void;
}) {
  const { t } = useTranslation("chat");
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 320 });
  const visible = open && references.length > 0;
  const label = t("annotation.count", { count: references.length });

  function enter() { clearTimeout(timer.current); setOpen(true); }
  function leave() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!pinned && !panel.current?.contains(document.activeElement) && !anchor.current?.contains(document.activeElement)) setOpen(false);
    }, 160);
  }
  function close() { clearTimeout(timer.current); setOpen(false); setPinned(false); }
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!visible) return;
    const dismiss = (event: globalThis.PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [visible]);
  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const rect = anchor.current.getBoundingClientRect();
      const above = Math.max(0, rect.top - 16);
      const below = Math.max(0, window.innerHeight - rect.bottom - 16);
      const useAbove = above >= Math.min(320, below);
      const maxHeight = Math.min(320, useAbove ? above : below);
      const height = Math.min(panel.current.scrollHeight, maxHeight);
      setPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - panel.current.offsetWidth - 8)),
        top: useAbove ? Math.max(8, rect.top - height - 8) : rect.bottom + 8,
        maxHeight,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(anchor.current!); observer.observe(panel.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [visible, references.length]);
  useLayoutEffect(() => {
    if (!visible) return;
    panel.current?.querySelectorAll("textarea").forEach((input) => {
      input.style.height = "auto";
      input.style.height = `${Math.min(160, Math.max(26, input.scrollHeight + 2))}px`;
    });
  }, [visible, references]);

  if (!references.length) return null;
  return <>
    <div ref={anchor} className="composer-annotations" onPointerEnter={enter} onPointerLeave={leave} onBlur={leave}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault(); setOpen(true); setPinned(true);
          requestAnimationFrame(() => panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus());
        }
      }}>
      <button ref={trigger} type="button" className="composer-annotations-trigger" aria-expanded={visible} aria-controls={visible ? id : undefined} aria-haspopup="dialog"
        onFocus={enter} onClick={() => { if (pinned) close(); else { enter(); setPinned(true); } }}>
        <SlidersHorizontal size={13} aria-hidden="true" /><span>{label}</span>
      </button>
      <button type="button" className="composer-annotations-remove" aria-label={t("annotation.removeAll")} onClick={() => { close(); references.forEach((reference) => onRemove(reference.id)); }}><X size={12} aria-hidden="true" /></button>
    </div>
    {visible ? createPortal(<div id={id} ref={panel} role="dialog" aria-label={label} className="composer-annotations-popover react-popover-surface" data-native-overlay="local"
      style={position} onPointerEnter={enter} onPointerLeave={leave} onBlur={leave}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") { event.preventDefault(); trigger.current?.focus(); close(); }
      }}>
      {references.map((reference) => <article key={reference.id} className="composer-annotation-detail">
        <header>
          {reference.imageUrl ? <a href={reference.imageUrl} target="_blank" rel="noreferrer"><img src={reference.imageUrl} alt={reference.label} /></a> : null}
          <strong>{reference.label}</strong>
          <button type="button" className="composer-annotations-remove" aria-label={t("composer.remove", { name: reference.label })} onClick={() => { if (references.length === 1) close(); onRemove(reference.id); }}><X size={13} aria-hidden="true" /></button>
        </header>
        {reference.annotation ? <textarea aria-label={`${reference.annotation.label} · ${reference.label}`} value={reference.annotation.text} readOnly={!reference.annotation.onChange}
          onChange={(event) => reference.annotation?.onChange?.(event.currentTarget.value)} maxLength={8000} rows={1} /> : null}
        {reference.detail ? <p>{reference.detail}</p> : null}
      </article>)}
    </div>, document.body) : null}
  </>;
}
