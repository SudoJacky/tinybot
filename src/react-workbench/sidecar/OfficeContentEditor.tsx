import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { OfficeContentChangeRequest, OfficeContentSelection } from "../../app-core/chat/officeContentReference";
import { officeContentBlocks, officeSelectionFromRange } from "./officeContentSelection";
import "./OfficeContentEditor.css";

export function OfficeContentEditor({ containerRef, kind, sourceBytes, ready, activeSlide = 0, onChange }: {
  containerRef: RefObject<HTMLDivElement | null>;
  kind: OfficeContentSelection["kind"];
  sourceBytes: Uint8Array;
  ready: boolean;
  activeSlide?: number;
  onChange: (request: OfficeContentChangeRequest) => void;
}) {
  const { t } = useTranslation("chat");
  const editorRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ value: OfficeContentSelection; bytes: Uint8Array }>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const current = ready && selection?.bytes === sourceBytes ? selection.value : undefined;
  useEffect(() => {
    setSelection(undefined);
    setDraft("");
    setEditing(false);
    if (!ready) return;
    function update() {
      if (editorRef.current?.contains(document.activeElement)) return;
      const container = containerRef.current;
      const selected = window.getSelection();
      if (!container || !selected?.rangeCount) return;
      const value = officeSelectionFromRange(container, kind, selected.getRangeAt(0));
      setSelection(value ? { value, bytes: sourceBytes } : undefined);
      setEditing(false);
      setDraft("");
    }
    function shortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "i" || editorRef.current?.contains(document.activeElement)) return;
      const container = containerRef.current;
      const selected = window.getSelection();
      if (!container || !selected?.rangeCount) return;
      const value = officeSelectionFromRange(container, kind, selected.getRangeAt(0));
      if (!value) return;
      event.preventDefault();
      event.stopPropagation();
      setSelection({ value, bytes: sourceBytes });
      setEditing(true);
    }
    document.addEventListener("selectionchange", update);
    document.addEventListener("keydown", shortcut);
    return () => { document.removeEventListener("selectionchange", update); document.removeEventListener("keydown", shortcut); };
  }, [containerRef, kind, sourceBytes, ready]);

  function selectSlide() {
    const container = containerRef.current;
    const slide = container && officeContentBlocks(container, "presentation")[activeSlide];
    if (!slide) throw new Error("The selected PowerPoint slide is unavailable.");
    setSelection({ bytes: sourceBytes, value: { kind, start: activeSlide + 1, end: activeSlide + 1, text: slide.textContent ?? "", context: slide.textContent ?? "", wholeSlide: true } });
    setDraft("");
    setEditing(true);
  }
  const position = current ? (current.start === current.end ? String(current.start) : `${current.start}–${current.end}`) : "";
  const label = current ? t(current.kind === "document" ? "details.officeParagraphSelection" : "details.officeSlideSelection", { position }) : "";
  if (!ready) return null;
  return <div className="react-office-content-editor" ref={editorRef}>
    <div className="react-office-content-editor__actions">
      <span>{current ? label : t("details.officeSelectTextHint")}</span>
      {current && !editing ? <button aria-keyshortcuts="Control+I Meta+I" type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => setEditing(true)}>{t("details.officeAskForChange")}</button> : null}
      {kind === "presentation" ? <button type="button" onClick={selectSlide}>{t("details.officeChangeSlide", { slide: activeSlide + 1 })}</button> : null}
    </div>
    {current && editing ? <form aria-label={label} onKeyDown={(event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setSelection(undefined);
      setEditing(false);
      setDraft("");
    }} onSubmit={(event) => {
      event.preventDefault();
      if (!draft.trim()) return;
      onChange({ ...current, instruction: draft.trim() });
      setSelection(undefined);
      setDraft("");
      setEditing(false);
    }}>
      {current.text ? <blockquote>{current.text.slice(0, 500)}{current.text.length > 500 ? "…" : ""}</blockquote> : null}
      <textarea autoFocus aria-label={t("details.officeContentInstruction")} placeholder={t("details.officeChangeEditorPlaceholder")} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="react-office-content-editor__actions">
        <button type="submit" disabled={!draft.trim()}>{t("details.officeChangeEditorConfirm")}</button>
        <button type="button" onClick={() => { setSelection(undefined); setEditing(false); setDraft(""); }}>{t("details.officeCancelSelection")}</button>
      </div>
    </form> : null}
  </div>;
}
