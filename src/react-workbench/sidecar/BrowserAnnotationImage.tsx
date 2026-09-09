import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { clampAnnotationRect, type AnnotationRect } from "../../app-core/native/browserAnnotation";

export type AnnotationMark = { type: "rectangle" | "arrow"; x: number; y: number; endX: number; endY: number };

export function BrowserAnnotationImage({ dataUrl, width, height, region, onRegion, marks, onMarks }: {
  dataUrl: string; width: number; height: number;
  region?: AnnotationRect; onRegion(region: AnnotationRect): void;
  marks: AnnotationMark[]; onMarks(marks: AnnotationMark[]): void;
}) {
  const { t } = useTranslation("chat");
  const [mode, setMode] = useState<"crop" | AnnotationMark["type"]>("crop");
  const [draft, setDraft] = useState<AnnotationMark>();
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const matrix = event.currentTarget.getScreenCTM();
    if (!matrix) throw new Error("Screenshot coordinates are unavailable.");
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
    return { x: Math.max(0, Math.min(width, point.x)), y: Math.max(0, Math.min(height, point.y)) };
  };
  function move(event: PointerEvent<SVGSVGElement>) {
    if (!start.current) return;
    const end = point(event);
    setDraft({ type: mode === "arrow" ? "arrow" : "rectangle", ...start.current, endX: end.x, endY: end.y });
  }
  const selection = mode === "crop" && draft ? markRect(draft) : region;
  return <div className="browser-annotation-image">
    <div className="browser-annotation-tools" role="group" aria-label={t("annotation.imageTools")}>
      {(["crop", "rectangle", "arrow"] as const).map((item) => <button key={item} type="button" aria-pressed={mode === item} onClick={() => setMode(item)}>{t(`annotation.${item}`)}</button>)}
      <button type="button" disabled={!marks.length} onClick={() => onMarks(marks.slice(0, -1))}>{t("annotation.undo")}</button>
      <button type="button" onClick={() => onRegion({ x: 0, y: 0, width, height })}>{t("annotation.fullViewport")}</button>
    </div>
    <div className="browser-annotation-image__viewport">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ aspectRatio: `${width} / ${height}` }} role="img" aria-label={t("annotation.drawHint")}
        onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); }}
        onPointerMove={move}
        onPointerCancel={() => { start.current = undefined; setDraft(undefined); }}
        onPointerUp={(event) => {
          if (!start.current) return;
          const end = point(event);
          const mark: AnnotationMark = { type: mode === "arrow" ? "arrow" : "rectangle", ...start.current, endX: end.x, endY: end.y };
          if (Math.hypot(end.x - mark.x, end.y - mark.y) >= 4) {
            if (mode === "crop") onRegion(clampAnnotationRect(markRect(mark), width, height));
            else onMarks([...marks, mark]);
          }
          start.current = undefined; setDraft(undefined);
        }}>
        <image href={dataUrl} width={width} height={height} />
        {selection ? <rect {...selection} fill="#2563eb18" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null}
        {[...marks, ...(draft && mode !== "crop" ? [draft] : [])].map((mark, index) => <g key={index} stroke="#ef4444" strokeWidth={Math.max(2, width / 350)} fill="none">
          {mark.type === "rectangle" ? <rect {...markRect(mark)} /> : <path d={arrowPath(mark)} />}
        </g>)}
      </svg>
    </div>
  </div>;
}

export function markRect(mark: AnnotationMark): AnnotationRect {
  return { x: Math.min(mark.x, mark.endX), y: Math.min(mark.y, mark.endY), width: Math.abs(mark.endX - mark.x), height: Math.abs(mark.endY - mark.y) };
}

function arrowPath(mark: AnnotationMark): string {
  const angle = Math.atan2(mark.endY - mark.y, mark.endX - mark.x);
  const size = Math.min(16, Math.hypot(mark.endX - mark.x, mark.endY - mark.y) / 3);
  return `M${mark.x},${mark.y} L${mark.endX},${mark.endY} M${mark.endX - size * Math.cos(angle - 0.5)},${mark.endY - size * Math.sin(angle - 0.5)} L${mark.endX},${mark.endY} L${mark.endX - size * Math.cos(angle + 0.5)},${mark.endY - size * Math.sin(angle + 0.5)}`;
}

export async function annotationImageFile(dataUrl: string, viewport: { width: number; height: number }, region: AnnotationRect | undefined, marks: AnnotationMark[]): Promise<File> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const crop = clampAnnotationRect(region ?? { x: 0, y: 0, ...viewport }, viewport.width, viewport.height);
  if (crop.width < 1 || crop.height < 1) throw new Error("The screenshot region is empty.");
  const sx = image.naturalWidth / viewport.width;
  const sy = image.naturalHeight / viewport.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.width * sx)); canvas.height = Math.max(1, Math.round(crop.height * sy));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot annotation canvas is unavailable.");
  context.drawImage(image, crop.x * sx, crop.y * sy, crop.width * sx, crop.height * sy, 0, 0, canvas.width, canvas.height);
  context.scale(sx, sy); context.translate(-crop.x, -crop.y);
  context.strokeStyle = "#ef4444"; context.lineWidth = Math.max(2, viewport.width / 350);
  for (const mark of marks) {
    if (mark.type === "rectangle") { const r = markRect(mark); context.strokeRect(r.x, r.y, r.width, r.height); }
    else context.stroke(new Path2D(arrowPath(mark)));
  }
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Screenshot encoding failed.")), "image/png"));
  return new File([blob], `browser-annotation-${Date.now()}.png`, { type: "image/png" });
}
