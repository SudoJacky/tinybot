import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NativeBrowserRuntimeApi } from "../../app-core/native/desktopNativeBrowser";
import { annotationElementRect, annotationSourceText, type AnnotationRect, type BrowserAnnotationAction, type BrowserAnnotationState } from "../../app-core/native/browserAnnotation";
import type { AgentInputReference } from "../../app-core/chat/agentInputReference";
import { importDesktopChatFiles } from "../../app-core/native/desktopNativeFilePicker";
import { BrowserAnnotationImage, annotationImageFile, type AnnotationMark } from "./BrowserAnnotationImage";
import "./BrowserAnnotationWorkspace.css";

type Props = {
  active: boolean;
  browserSessionId: string;
  tabId: string;
  runtime: NativeBrowserRuntimeApi;
  onClose(): void;
  onReference(reference: AgentInputReference & { id: string }): void;
  onError(message: string): void;
  renderSurface(frozen: boolean): ReactNode;
};

export function BrowserAnnotationWorkspace({ active, browserSessionId, tabId, runtime, onClose, onReference, onError, renderSurface }: Props) {
  const { t } = useTranslation("chat");
  const [state, setState] = useState<BrowserAnnotationState>({ active: false });
  const [capture, setCapture] = useState<BrowserAnnotationState>();
  const [region, setRegion] = useState<AnnotationRect>();
  const [marks, setMarks] = useState<AnnotationMark[]>([]);
  const [instruction, setInstruction] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const [resetEpoch, setResetEpoch] = useState(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const current = useRef({ onClose, onReference, onError });
  current.current = { onClose, onReference, onError };
  const live = useRef(false);
  const generation = useRef(0);
  const busyRef = useRef(false);
  const draftTarget = useRef("");
  const acceptState = useCallback((next: BrowserAnnotationState, retainDraft = false) => {
    const identity = next.documentId + ":" + (next.selection?.id ?? (next.region ? next.selectionId : ""));
    if (identity !== draftTarget.current && !retainDraft) { setInstruction(""); setExpanded(false); }
    draftTarget.current = identity;
    setState(next);
  }, []);
  const command = useCallback((action: BrowserAnnotationAction) => {
    const result = queue.current.then(() => runtime.annotate({ browserSessionId, tabId, action }));
    // Keep subsequent cleanup possible; callers still receive and report the rejection.
    queue.current = result.then(() => undefined, () => undefined);
    return result;
  }, [browserSessionId, runtime, tabId]);

  const report = useCallback((reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    setError(message);
    console.error("[browser-annotation] operation.failed", { browserSessionId, tabId, error: message });
  }, [browserSessionId, tabId]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer = 0;
    let lastPollError = "";
    live.current = true;
    generation.current += 1; busyRef.current = false;
    setError(""); setBusy(false); setState({ active: false }); setCapture(undefined); setRegion(undefined); setMarks([]); setInstruction(""); setExpanded(false); handledRegion.current = undefined;
    const poll = async () => {
      if (cancelled) return;
      try {
        if (!busyRef.current) {
          const next = await command({ type: "poll" });
          if (cancelled) return;
          acceptState(next); lastPollError = "";
          if (next.exitRequested) { current.current.onClose(); return; }
        }
        timer = window.setTimeout(() => void poll(), 250);
      } catch (reason) {
        if (!cancelled) {
          const message = String(reason);
          if (message !== lastPollError) { report(reason); lastPollError = message; }
          timer = window.setTimeout(() => void poll(), 1000);
        }
      }
    };
    void command({ type: "start" }).then((next) => {
      if (cancelled) return;
      acceptState(next);
      timer = window.setTimeout(() => void poll(), 250);
    }).catch((reason) => { if (!cancelled) report(reason); });
    return () => {
      cancelled = true; live.current = false; generation.current += 1; window.clearTimeout(timer);
      void command({ type: "stop" }).catch((reason) => {
        const message = reason instanceof Error ? reason.message : String(reason);
        console.error("[browser-annotation] cleanup.failed", { browserSessionId, tabId, error: message });
        current.current.onError(message);
      });
    };
  }, [active, acceptState, browserSessionId, command, report, tabId]);

  const execute = useCallback(async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    const epoch = generation.current;
    busyRef.current = true; setBusy(true); setError("");
    try { await operation(); }
    catch (reason) { if (live.current && generation.current === epoch) report(reason); }
    finally { if (generation.current === epoch) { busyRef.current = false; if (live.current) setBusy(false); } }
  }, [report]);

  const freeze = useCallback(async (initialRegion?: AnnotationRect) => {
    const epoch = generation.current;
    const next = await command({ type: "capture" });
    if (!next.dataUrl || !next.viewport) throw new Error(t("annotation.captureFailed"));
    if (!live.current || generation.current !== epoch) return;
    setCapture(next); setRegion(initialRegion); setMarks([]);
  }, [command, t]);

  const handledRegion = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active || capture || !state.region || state.selectionId === handledRegion.current) return;
    handledRegion.current = state.selectionId;
    void execute(() => freeze(state.region ?? undefined));
  }, [active, capture, execute, freeze, state.region, state.selectionId]);

  async function apply(action: BrowserAnnotationAction) {
    const epoch = generation.current;
    const next = await command(action);
    if (live.current && generation.current === epoch) acceptState(next, action.type === "parent");
  }
  const selected = state.selection;
  const target = state.documentId && selected ? { documentId: state.documentId, selectionId: selected.id } : undefined;
  const changes = selected ? Object.keys(selected.changes).length : 0;

  async function attach() {
    const epoch = generation.current;
    const evidence = capture ?? await command({ type: "capture" });
    if (!capture && (!selected || evidence.documentId !== state.documentId || evidence.selection?.id !== selected.id)) {
      throw new Error(t("annotation.selectionChanged"));
    }
    if (!evidence.dataUrl || !evidence.viewport) throw new Error(t("annotation.captureFailed"));
    const file = await annotationImageFile(evidence.dataUrl, evidence.viewport, capture ? region : annotationElementRect(evidence), marks);
    const [image] = await importDesktopChatFiles([file]);
    if (!image?.contentHash) throw new Error(t("annotation.importFailed"));
    if (!live.current || generation.current !== epoch) return;
    // Restore previews before attaching, keeping annotation mode ready for another element.
    await command({ type: "clear" });
    if (!live.current || generation.current !== epoch) return;
    const label = capture ? t("annotation.regionTitle") : `${evidence.selection!.tag}${evidence.selection!.text ? ` · ${evidence.selection!.text.slice(0, 60)}` : ""}`;
    current.current.onReference({
      id: `browser-annotation:${crypto.randomUUID()}`, kind: "reference", referenceKind: "image",
      title: label, detail: capture ? "" : Object.entries(evidence.selection!.changes).map(([property, change]) => `${property}: ${change.before} → ${change.after}`).join("\n"),
      rawPath: image.path, contentHash: image.contentHash, mimeType: image.mimeType, sizeBytes: image.sizeBytes,
      sourceText: annotationSourceText(evidence, capture ? region : undefined),
      userAnnotation: instruction.trim() || t("annotation.applyProperties"),
      revision: evidence.documentId,
    });
    setState({ ...evidence, selection: null, region: null });
    setCapture(undefined); setRegion(undefined); setMarks([]); setInstruction(""); setExpanded(false);
  }


  const selectionRect = selected?.rect ?? region;
  const hasEditor = active && Boolean(selected || capture);
  useLayoutEffect(() => {
    if (!active || !state.active) return;
    let disposed = false;
    let previous = "";
    const place = () => {
      if (disposed) return;
      const page = pageRef.current;
      const card = cardRef.current;
      if (!page) return;
      if (!hasEditor || !card || capture) {
        if (previous !== "none") { previous = "none"; void command({ type: "overlay", rect: null }).catch(report); }
        if (!card) return;
      }
      const bounds = page.getBoundingClientRect();
      const width = card.offsetWidth;
      const height = card.offsetHeight;
      const left = Math.max(8, Math.min(selectionRect?.x ?? 12, bounds.width - width - 8));
      const bottom = (selectionRect?.y ?? 0) + (selectionRect?.height ?? 0) + 8;
      const top = Math.max(8, Math.min(bottom + height <= bounds.height - 8 ? bottom : (selectionRect?.y ?? bounds.height) - height - 8, bounds.height - height - 8));
      setPosition((current) => current.left === left && current.top === top ? current : { left, top });
      if (capture) return;
      const rect = { x: left, y: top, width, height, deviceScale: window.devicePixelRatio || 1 };
      const key = JSON.stringify(rect);
      if (key !== previous) { previous = key; void command({ type: "overlay", rect }).catch(report); }
    };
    place();
    const observer = new ResizeObserver(place);
    if (pageRef.current) observer.observe(pageRef.current);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener("resize", place);
    return () => { disposed = true; observer.disconnect(); window.removeEventListener("resize", place); };
  }, [active, state.active, hasEditor, capture, expanded, selectionRect?.x, selectionRect?.y, selectionRect?.width, selectionRect?.height, command, report]);

  async function clearSelection() {
    await apply({ type: "clear" });
    setCapture(undefined); setRegion(undefined); setMarks([]); setInstruction(""); setExpanded(false);
  }

  return <div className="browser-annotation-workspace" data-annotating={active} onKeyDown={(event) => {
    if (!active || event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    if (expanded) { setExpanded(false); return; }
    void execute(async () => {
      if (capture || selected) await clearSelection();
      else { await command({ type: "stop" }); current.current.onClose(); }
    });
  }}>
    {active ? <div className="browser-annotation-toolbar">
      <span>{t(capture ? "annotation.drawHint" : "annotation.selectHint")}</span>
      <button type="button" disabled={busy || !state.active} onClick={() => void execute(async () => { await clearSelection(); if (!capture) await freeze(); })}>{t(capture ? "annotation.selectElement" : "annotation.selectRegion")}</button>
      <button type="button" disabled={busy} onClick={() => void execute(async () => { await command({ type: "stop" }); current.current.onClose(); })}>{t("annotation.done")}</button>
    </div> : null}
    <div ref={pageRef} className="browser-annotation-page">
      {renderSurface(Boolean(active && capture))}
      {active && capture?.dataUrl && capture.viewport ? <BrowserAnnotationImage dataUrl={capture.dataUrl} width={capture.viewport.width} height={capture.viewport.height} region={region} onRegion={setRegion} marks={marks} onMarks={setMarks} /> : null}
      {hasEditor ? <div ref={cardRef} className="browser-annotation-editor" role="group" aria-label={t("annotation.title")} data-expanded={expanded && !capture} style={position}>
        <div className="browser-annotation-comment-row">
          {!capture ? <button type="button" className="browser-annotation-round" aria-label={t("annotation.editProperties")} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><SlidersHorizontal size={16} /></button> : null}
          <textarea aria-label={t("annotation.instruction")} value={instruction} maxLength={8000} rows={1} disabled={busy} placeholder={t("annotation.commentPlaceholder")}
            onChange={(event) => setInstruction(event.currentTarget.value)} onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (instruction.trim() || changes) && !error && !busy && (selected || region)) {
                event.preventDefault(); void execute(attach);
              }
            }} />
          <button type="button" className="browser-annotation-send browser-annotation-round" aria-label={t("annotation.attach")} title={t("annotation.attach")} disabled={busy || Boolean(error) || (!selected && !region) || (!instruction.trim() && !changes)} onClick={() => void execute(attach)}><ArrowUp size={17} /></button>
          <button type="button" className="browser-annotation-round" aria-label={t("annotation.cancel")} disabled={busy} onClick={() => void execute(clearSelection)}><X size={15} /></button>
        </div>
        {expanded && !capture && selected && target ? <>
          <div className="browser-annotation-element"><strong>{selected.tag}</strong>
            <select aria-label={t("annotation.parents")} value="" disabled={busy} onChange={(event) => { if (event.currentTarget.value) void execute(() => apply({ type: "parent", ...target, index: Number(event.currentTarget.value) - 1 })); }}>
              <option value="">{selected.selector}</option>
              {selected.ancestors.map((ancestor, index) => <option value={index + 1} key={index}>{ancestor.tag} · {ancestor.selector}</option>)}
            </select>
          </div>
          <div className="browser-annotation-properties">
            {[...(selected.editableText ? ["text"] : []), ...Object.keys(selected.styles)].map((property) => <label key={[state.documentId,selected.id,resetEpoch,property].join(":")}>
              <span>{t("annotation.properties." + property, { defaultValue: property })}</span>
              <AnnotationPropertyInput disabled={busy} value={selected.changes[property]?.after ?? (property === "text" ? selected.text : selected.styles[property])}
                onPreview={(value) => { setError(""); void apply({ type: "preview", ...target, property, value }).catch(report); }} />
            </label>)}
          </div>
          <footer><span>{t("annotation.livePreview")}</span><button type="button" disabled={busy || !changes} onClick={() => void execute(async () => { await apply({ type: "reset", ...target }); setResetEpoch((value) => value + 1); })}>{t("annotation.reset")}</button></footer>
        </> : null}
      </div> : null}
    </div>
    {active && error ? <div role="alert" className="browser-annotation-error">{error}<button type="button" onClick={() => void execute(clearSelection)}>{t("annotation.cancel")}</button></div> : null}
  </div>;
}

function AnnotationPropertyInput({ value, disabled, onPreview }: { value: string; disabled: boolean; onPreview(value: string): void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef(0);
  const latest = useRef(onPreview); latest.current = onPreview;
  const submitted = useRef(value);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  function submit(next: string) {
    window.clearTimeout(timer.current);
    if (next !== submitted.current) { submitted.current = next; latest.current(next); }
  }
  return <input disabled={disabled} value={draft} onChange={(event) => {
    const next = event.currentTarget.value; setDraft(next); window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => submit(next), 300);
  }} onBlur={() => submit(draft)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />;
}
