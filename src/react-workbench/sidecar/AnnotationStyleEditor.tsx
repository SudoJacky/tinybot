import { useEffect, useMemo, useRef, useState } from "react";
import { Link, Unlink } from "lucide-react";
import { useTranslation } from "react-i18next";

const sides = ["top", "right", "bottom", "left"] as const;
const units = ["px", "%", "em", "rem", "vw", "vh"];
const numberValue = (value: string) => /^(-?(?:\d+\.?\d*|\.\d+))(px|%|em|rem|vw|vh)?$/.exec(value.trim());
const rounded = (value: number) => String(Math.round(value * 1000) / 1000);

type FieldProps = { property: string; label: string; value: string; disabled: boolean; onChange(value: string, immediate?: boolean): void; onCommit(): void };

function ValueField({ property, label, value, disabled, onChange, onCommit }: FieldProps) {
  const { t } = useTranslation("chat");
  const parsed = property === "text" ? null : numberValue(value);
  const opacity = property === "opacity";
  const unitless = opacity || property === "font-weight";
  const lastUnit = useRef(parsed?.[2] || (unitless || property === "text" ? "" : "px"));
  if (parsed?.[2]) lastUnit.current = parsed[2];
  const unit = parsed?.[2] || lastUnit.current;
  const numeric = parsed ? Number(parsed[1]) : undefined;
  const percent = unit === "%" || opacity;
  const display = opacity && numeric !== undefined && unit !== "%" ? rounded(numeric * 100) : parsed?.[1] ?? value;
  const drag = useRef<{ id: number; y: number; value: number; moved: boolean } | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  function changeNumber(next: number) {
    const min = property.startsWith("margin-") ? -Infinity : 0;
    const max = opacity ? 100 : property === "font-weight" ? 1000 : Infinity;
    const bounded = Math.max(property === "font-weight" ? 1 : min, Math.min(max, next));
    onChange(opacity ? rounded(bounded / 100) : rounded(bounded) + unit, true);
  }
  return <div className="annotation-value-control">
    <div className="annotation-number">
      <input ref={inputRef} aria-label={label} disabled={disabled} value={display}
        className={parsed ? "annotation-scrubbable" : undefined}
        title={parsed ? t("annotation.scrubHint") : undefined}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          const nextNumber = numberValue(raw);
          onChange(opacity && nextNumber && !nextNumber[2] ? rounded(Number(raw) / 100) : nextNumber && !nextNumber[2] ? raw + unit : raw);
        }}
        onBlur={onCommit}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0 || numeric === undefined) return;
          drag.current = { id: event.pointerId, y: event.clientY, value: Number(display), moved: false };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          const delta = start.y - event.clientY;
          if (!start.moved && Math.abs(delta) < 4) return;
          start.moved = true; event.preventDefault();
          changeNumber(start.value + delta * (event.shiftKey ? 10 : 1));
        }}
        onPointerUp={(event) => {
          if (drag.current?.moved) { event.preventDefault(); onCommit(); inputRef.current?.select(); }
          drag.current = undefined;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { drag.current = undefined; onCommit(); }}
        onLostPointerCapture={() => { drag.current = undefined; }}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
          if (numeric !== undefined && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault(); changeNumber(Number(display) + (event.key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 10 : 1));
          }
        }} />
      {parsed && !unitless ? <select aria-label={t("annotation.unitFor", { property: label })} disabled={disabled} value={unit}
        onChange={(event) => onChange(parsed[1] + event.currentTarget.value, true)}>
        {!unit ? <option value="">—</option> : null}{units.map((item) => <option key={item}>{item}</option>)}
      </select> : opacity ? <span>%</span> : null}
    </div>
    {percent && numeric !== undefined ? <input type="range" aria-label={t("annotation.sliderFor", { property: label })} disabled={disabled}
      min={0} max={opacity ? 100 : Math.max(100, Math.ceil(numeric / 100) * 100)} step={1} value={opacity ? Number(display) : numeric}
      onChange={(event) => changeNumber(Number(event.currentTarget.value))} onPointerUp={onCommit} onKeyUp={onCommit} onBlur={onCommit} /> : null}
  </div>;
}

// Canvas resolves browser-supported CSS colors, including named colors and alpha.
function colorChannels(value: string) {
  if (!CSS.supports("color", value)) return null;
  const context = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Color editor requires a canvas 2D context");
  context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  return { hex: "#" + [r, g, b].map((part) => part.toString(16).padStart(2, "0")).join(""), alpha: a / 255 };
}

function ColorField({ label, value, disabled, onChange, onCommit }: FieldProps) {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const channels = useMemo(() => colorChannels(value), [value]);
  return <div className="annotation-color-control">
    <div className="annotation-color-row">
      <input type="color" className="annotation-color-swatch" aria-label={t("annotation.colorFor", { property: label })}
        disabled={disabled || !channels} value={channels?.hex ?? "#000000"} onClick={() => setOpen(true)}
        onChange={(event) => {
          const hex = event.currentTarget.value;
          onChange(channels && channels.alpha < 1 ? hex + Math.round(channels.alpha * 255).toString(16).padStart(2, "0") : hex, true);
        }} onBlur={onCommit} />
      <input aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} onBlur={onCommit}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } }} />
    </div>
    {open ? <div className="annotation-color-picker">
      <span>{t("annotation.properties.opacity")}</span>
      {channels ? <ValueField property="opacity" label={t("annotation.alphaFor", { property: label })} value={rounded(channels.alpha)} disabled={disabled}
        onChange={(alpha, immediate) => onChange(channels.hex + Math.round(Math.max(0, Math.min(1, Number(alpha))) * 255).toString(16).padStart(2, "0"), immediate)} onCommit={onCommit} /> : null}
    </div> : null}
  </div>;
}

type Props = { values: Record<string, string>; disabled: boolean; onPreview(property: string, value: string): void; onValidityChange(valid: boolean): void };
export function AnnotationStyleEditor({ values, disabled, onPreview, onValidityChange }: Props) {
  const { t } = useTranslation("chat");
  const [draft, setDraft] = useState(values);
  const draftRef = useRef(draft);
  const [linked, setLinked] = useState<Record<string, boolean>>({});
  const [invalid, setInvalid] = useState<Record<string, boolean>>({});
  const timers = useRef<Record<string, number>>({});
  const sent = useRef({ ...values });
  const preview = useRef(onPreview); preview.current = onPreview;
  useEffect(() => () => Object.values(timers.current).forEach(window.clearTimeout), []);
  useEffect(() => { onValidityChange(!Object.values(invalid).some(Boolean)); }, [invalid, onValidityChange]);
  function commit(property: string) {
    window.clearTimeout(timers.current[property]); delete timers.current[property];
    const value = draftRef.current[property];
    if (property !== "text" && !CSS.supports(property, value)) {
      setInvalid((current) => ({ ...current, [property]: true })); return;
    }
    setInvalid((current) => ({ ...current, [property]: false }));
    if (sent.current[property] !== value) { sent.current[property] = value; preview.current(property, value); }
  }
  function edit(property: string, value: string, immediate = false) {
    const group = property.startsWith("padding-") ? "padding" : property.startsWith("margin-") ? "margin" : "";
    const properties = group && linked[group] ? sides.map((side) => `${group}-${side}`) : [property];
    const next = { ...draftRef.current, ...Object.fromEntries(properties.map((key) => [key, value])) };
    draftRef.current = next; setDraft(next);
    for (const key of properties) {
      if (immediate && timers.current[key]) continue;
      window.clearTimeout(timers.current[key]);
      timers.current[key] = window.setTimeout(() => commit(key), immediate ? 40 : 300);
    }
  }
  function flush(property: string) {
    const group = property.split("-")[0];
    (linked[group] ? sides.map((side) => `${group}-${side}`) : [property]).forEach(commit);
  }
  const labelFor = (property: string) => t("annotation.properties." + property, { defaultValue: property });
  function field(property: string, label = labelFor(property)) {
    const Control = property === "color" || property === "background-color" ? ColorField : ValueField;
    return <div className="annotation-field" key={property}>
      <Control property={property} label={label} value={draft[property]} disabled={disabled} onChange={(value, immediate) => edit(property, value, immediate)} onCommit={() => flush(property)} />
      {invalid[property] ? <span role="alert" className="annotation-invalid">{t("annotation.invalidValue")}</span> : null}
    </div>;
  }
  return <div className="browser-annotation-properties">
    {Object.keys(draft).filter((property) => !/^(padding|margin)-/.test(property)).map((property) => <div className="annotation-property" key={property}>
      <span>{labelFor(property)}</span>{field(property)}
    </div>)}
    {["padding", "margin"].filter((group) => `${group}-top` in draft).map((group) => <fieldset className="annotation-spacing" key={group}>
      <legend>{labelFor(group)}</legend>
      <button type="button" className="annotation-link" disabled={disabled} aria-pressed={Boolean(linked[group])} aria-label={t("annotation.linkFor", { property: labelFor(group) })}
        onClick={() => setLinked((current) => ({ ...current, [group]: !current[group] }))}>{linked[group] ? <Link size={14} /> : <Unlink size={14} />}</button>
      <div className="annotation-spacing-grid">{sides.map((side) => <div key={side}><span>{t(`annotation.sides.${side}`)}</span>{field(`${group}-${side}`, `${labelFor(group)} · ${t(`annotation.sides.${side}`)}`)}</div>)}</div>
    </fieldset>)}
  </div>;
}
