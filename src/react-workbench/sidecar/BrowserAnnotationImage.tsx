import { useRef, useState, type PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { clampAnnotationRect, type AnnotationRect } from "../../app-core/native/browserAnnotation";

export function BrowserAnnotationImage({ dataUrl, width, height, region, onRegion }: {
  dataUrl: string; width: number; height: number;
  region?: AnnotationRect; onRegion(region: AnnotationRect): void;
}) {
  const { t } = useTranslation("chat");
  const [draft, setDraft] = useState<AnnotationRect>();
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
    setDraft(regionBetween(start.current, end));
  }
  const selection = draft ?? region;
  return <div className="browser-annotation-image">
    <div className="browser-annotation-image__viewport">
      <svg viewBox={`0 0 ${width} ${height}`} style={{ aspectRatio: `${width} / ${height}` }} role="img" aria-label={t("annotation.regionTitle")}
        onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); start.current = point(event); }}
        onPointerMove={move}
        onPointerCancel={() => { start.current = undefined; setDraft(undefined); }}
        onPointerUp={(event) => {
          if (!start.current) return;
          const end = point(event);
          const next = regionBetween(start.current, end);
          if (next.width >= 4 && next.height >= 4) onRegion(clampAnnotationRect(next, width, height));
          start.current = undefined; setDraft(undefined);
        }}>
        <image href={dataUrl} width={width} height={height} />
        {selection ? <rect {...selection} fill="#2563eb18" stroke="#2563eb" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : null}
      </svg>
    </div>
  </div>;
}

function regionBetween(start: { x: number; y: number }, end: { x: number; y: number }): AnnotationRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export async function annotationImageFile(dataUrl: string, viewport: { width: number; height: number }, region: AnnotationRect | undefined): Promise<File> {
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
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Screenshot encoding failed.")), "image/png"));
  return new File([blob], `browser-annotation-${Date.now()}.png`, { type: "image/png" });
}
