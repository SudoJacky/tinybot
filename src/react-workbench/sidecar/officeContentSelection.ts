import type { OfficeContentSelection } from "../../app-core/chat/officeContentReference";

export function officeSelectionFromRange(container: HTMLElement, kind: OfficeContentSelection["kind"], range: Range): OfficeContentSelection | undefined {
  if (range.collapsed || !container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
  const text = range.toString();
  if (!text.trim()) return;
  const blocks = officeContentBlocks(container, kind);
  const selected = blocks.map((block, index) => ({ block, index })).filter(({ block }) => range.intersectsNode(block));
  if (!selected.length) return;
  const start = selected[0].index;
  const end = selected[selected.length - 1].index;
  return { kind, start: start + 1, end: end + 1, text,
    context: blocks.slice(Math.max(0, start - 1), end + 2).map((block) => block.textContent ?? "").join("\n\n"),
  };
}

export function officeContentBlocks(container: HTMLElement, kind: OfficeContentSelection["kind"]): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(kind === "document" ? "p" : ".pptx-preview-wrapper > .pptx-preview-slide-wrapper"));
}
