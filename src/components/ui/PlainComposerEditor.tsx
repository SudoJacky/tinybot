import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import type { ComposerEditorProps, ComposerSkillOption } from "./composerContracts";

interface InlineComposerCaret {
  offset: number;
  skillsBefore: number;
}

interface InlineSkillPlacement {
  id: string;
  offset: number;
}

/** Keeps DOM selection and atomic Skill positions inside the plain-text editor. */
export function PlainComposerEditor({
  ref, inlineSkills, value, disabled, label, placeholder, skills, removeSkillLabel,
  onChange, onCursorChange, onSkillsChange, onImportFiles, onKeyDown, activeDescendant, controls,
}: ComposerEditorProps & { inlineSkills: boolean }) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineRef = useRef<HTMLDivElement | null>(null);
  const composing = useRef(false);
  const pendingCaret = useRef<InlineComposerCaret | null>(null);
  const [placements, setPlacements] = useState<InlineSkillPlacement[]>([]);
  useEffect(() => {
    const selected = new Set(skills.map((skill) => skill.id));
    setPlacements((current) => {
      const next = current.filter((placement) => selected.has(placement.id));
      return next.length === current.length ? current : next;
    });
  }, [skills]);
  const visiblePlacements = useMemo(() => {
    const selected = new Set(skills.map((skill) => skill.id));
    const next = placements.filter((placement) => selected.has(placement.id))
      .map((placement) => ({ ...placement, offset: clampOffset(placement.offset, value) }));
    for (const skill of skills) {
      if (!next.some((placement) => placement.id === skill.id)) next.push({ id: skill.id, offset: value.length });
    }
    return next;
  }, [placements, skills, value]);

  useLayoutEffect(() => {
    const editor = inlineRef.current;
    if (editor) renderInlineComposerDom(editor, value, visiblePlacements, skills, removeSkillLabel);
    const caret = pendingCaret.current;
    if (!caret) return;
    pendingCaret.current = null;
    if (editor) {
      editor.focus();
      restoreInlineComposerCaret(editor, caret);
    } else if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(caret.offset, caret.offset);
    }
  }, [inlineSkills, removeSkillLabel, skills, value, visiblePlacements]);

  useImperativeHandle(ref, () => ({
    focusEnd() {
      if (inlineRef.current) {
        inlineRef.current.focus();
        restoreInlineComposerCaret(inlineRef.current, {
          offset: value.length, skillsBefore: visiblePlacements.filter((placement) => placement.offset === value.length).length,
        });
      } else if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(value.length, value.length);
      }
      onCursorChange({ text: value, offset: value.length });
    },
    replaceTrigger(from, to, skill, text = "") {
      const nextValue = value.slice(0, from) + text + value.slice(to);
      const nextPlacements = rebaseInlineSkillPlacements(
        visiblePlacements.filter((placement) => placement.id !== skill?.id), from, to, text.length,
      );
      if (skill) nextPlacements.push({ id: skill.id, offset: from });
      const offset = from + text.length;
      pendingCaret.current = { offset, skillsBefore: nextPlacements.filter((placement) => placement.offset === offset).length };
      setPlacements(nextPlacements);
      onChange(nextValue);
      onCursorChange({ text: nextValue, offset });
      if (skill) {
        onSkillsChange([...skills.filter((selected) => selected.id !== skill.id).map((selected) => selected.id), skill.id]);
      }
    },
  }));

  function syncInlineInput() {
    const editor = inlineRef.current;
    if (!editor) return;
    const content = readInlineComposerContent(editor);
    const caret = readInlineComposerCaret(editor) ?? {
      offset: content.message.length,
      skillsBefore: content.placements.filter((placement) => placement.offset === content.message.length).length,
    };
    pendingCaret.current = caret;
    setPlacements(content.placements);
    onSkillsChange(content.placements.map((placement) => placement.id));
    onChange(content.message);
    onCursorChange({ text: content.message, offset: caret.offset });
  }

  function removeSkill(id: string) {
    const index = visiblePlacements.findIndex((placement) => placement.id === id);
    const placement = visiblePlacements[index];
    if (!placement) return;
    pendingCaret.current = {
      offset: placement.offset,
      skillsBefore: visiblePlacements.slice(0, index).filter((candidate) => candidate.offset === placement.offset).length,
    };
    setPlacements(visiblePlacements.filter((candidate) => candidate.id !== id));
    onSkillsChange(skills.filter((skill) => skill.id !== id).map((skill) => skill.id));
    onCursorChange({ text: value, offset: placement.offset });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement | HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.currentTarget instanceof HTMLDivElement) {
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        insertPlainTextAtSelection(event.currentTarget, "\n");
        syncInlineInput();
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        const caret = readInlineComposerCaret(event.currentTarget);
        if (caret) {
          const adjacent = visiblePlacements.filter((placement) => placement.offset === caret.offset);
          const skill = adjacent[event.key === "Backspace" ? caret.skillsBefore - 1 : caret.skillsBefore];
          if (skill) {
            event.preventDefault();
            removeSkill(skill.id);
            return;
          }
        }
      }
    }
    onKeyDown(event);
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement | HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (files.length) {
      event.preventDefault();
      onImportFiles(files);
      return;
    }
    if (event.currentTarget instanceof HTMLDivElement) {
      event.preventDefault();
      insertPlainTextAtSelection(event.currentTarget, event.clipboardData.getData("text/plain"));
      syncInlineInput();
    }
  }

  function reportSelection() {
    const editor = inlineRef.current;
    if (!editor) return;
    const caret = readInlineComposerCaret(editor);
    if (caret) onCursorChange({ text: value, offset: caret.offset });
  }

  const aria = {
    "aria-activedescendant": activeDescendant,
    "aria-autocomplete": "list" as const,
    "aria-controls": controls,
    "aria-expanded": Boolean(controls),
    "aria-haspopup": "listbox" as const,
    "aria-label": label,
  };
  return inlineSkills ? (
    <div
      {...aria}
      aria-disabled={disabled}
      aria-multiline="true"
      className="claude-ai-input__textarea claude-ai-input__inline-editor"
      contentEditable={!disabled}
      data-empty={!value && !skills.length}
      data-placeholder={placeholder}
      ref={inlineRef}
      role="textbox"
      spellCheck="true"
      suppressContentEditableWarning
      tabIndex={disabled ? -1 : 0}
      onCompositionEnd={() => { composing.current = false; syncInlineInput(); }}
      onCompositionStart={() => { composing.current = true; }}
      onInput={() => { if (!composing.current) syncInlineInput(); }}
      onKeyDown={handleKeyDown}
      onKeyUp={reportSelection}
      onPaste={handlePaste}
      onPointerUp={reportSelection}
      onClick={(event) => {
        const button = (event.target as Element).closest<HTMLElement>("[data-remove-skill-id]");
        if (button?.dataset.removeSkillId) removeSkill(button.dataset.removeSkillId);
      }}
    />
  ) : (
    <textarea
      {...aria}
      className="claude-ai-input__textarea"
      disabled={disabled}
      placeholder={placeholder}
      ref={textareaRef}
      rows={2}
      value={value}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onChange={(event) => {
        onCursorChange({ text: event.currentTarget.value, offset: event.currentTarget.selectionStart });
        onChange(event.currentTarget.value);
      }}
      onSelect={(event) => onCursorChange({ text: event.currentTarget.value, offset: event.currentTarget.selectionStart })}
    />
  );
}

function clampOffset(offset: number, message: string): number {
  return Math.max(0, Math.min(message.length, offset));
}

function rebaseInlineSkillPlacements(
  placements: readonly InlineSkillPlacement[],
  start: number,
  end: number,
  insertedLength: number,
): InlineSkillPlacement[] {
  const removedLength = end - start - insertedLength;
  return placements.map((placement) => {
    if (placement.offset <= start) return placement;
    if (placement.offset >= end) return { ...placement, offset: placement.offset - removedLength };
    return { ...placement, offset: start };
  });
}

function renderInlineComposerDom(
  editor: HTMLDivElement,
  message: string,
  placements: readonly InlineSkillPlacement[],
  skills: readonly ComposerSkillOption[],
  removeLabel: (skill: ComposerSkillOption) => string,
): void {
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const sortedPlacements = placements
    .map((placement, index) => ({ ...placement, index }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index);
  const fragment = document.createDocumentFragment();
  let textOffset = 0;

  for (const placement of sortedPlacements) {
    const skill = skillsById.get(placement.id);
    if (!skill) continue;
    if (placement.offset > textOffset) {
      fragment.append(document.createTextNode(message.slice(textOffset, placement.offset)));
    }

    const token = document.createElement("span");
    token.className = "claude-ai-input__inline-skill";
    token.contentEditable = "false";
    token.dataset.composerSkillId = skill.id;
    token.title = `${skill.label} · ${skill.description} · ${skill.sourceLabel}`;
    token.append(createInlineSkillIcon());

    const label = document.createElement("span");
    label.textContent = skill.label;
    token.append(label);

    const remove = document.createElement("button");
    remove.setAttribute("aria-label", removeLabel(skill));
    remove.dataset.removeSkillId = skill.id;
    remove.type = "button";
    remove.append(createInlineSkillRemoveIcon());
    token.append(remove);
    fragment.append(token);
    textOffset = placement.offset;
  }

  if (textOffset < message.length) fragment.append(document.createTextNode(message.slice(textOffset)));
  if (fragment.lastChild?.nodeType === Node.TEXT_NODE && fragment.lastChild.textContent?.endsWith("\n")) {
    // A terminal newline needs a following line box for the editable caret.
    const trailingBreak = document.createElement("br");
    trailingBreak.dataset.composerTrailingBreak = "true";
    fragment.append(trailingBreak);
  }
  editor.replaceChildren(fragment);
}

function createInlineSkillIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("height", "13");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "13");
  for (const points of ["21 16 21 8 12 3 3 8 3 16 12 21 21 16", "3.3 7 12 12 20.7 7", "12 22 12 12"]) {
    const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    polyline.setAttribute("points", points);
    icon.append(polyline);
  }
  return icon;
}

function createInlineSkillRemoveIcon(): SVGSVGElement {
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("fill", "none");
  icon.setAttribute("height", "11");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "11");
  for (const [x1, y1, x2, y2] of [[6, 6, 18, 18], [18, 6, 6, 18]]) {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(x1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y1", String(y1));
    line.setAttribute("y2", String(y2));
    icon.append(line);
  }
  return icon;
}

function readInlineComposerContent(root: Node): {
  message: string;
  placements: InlineSkillPlacement[];
} {
  let message = "";
  const placements: InlineSkillPlacement[] = [];

  function visit(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
      message += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    const element = node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : undefined;
    if (element?.dataset.composerTrailingBreak) return;
    const skillId = element?.dataset.composerSkillId;
    if (skillId) {
      placements.push({ id: skillId, offset: message.length });
      return;
    }
    if (element?.tagName === "BR") {
      message += "\n";
      return;
    }
    for (const child of node.childNodes) visit(child);
  }

  visit(root);
  return { message, placements };
}

function readInlineComposerCaret(editor: HTMLDivElement): InlineComposerCaret | undefined {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return undefined;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !editor.contains(range.endContainer)) return undefined;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(editor);
  prefix.setEnd(range.endContainer, range.endOffset);
  const content = readInlineComposerContent(prefix.cloneContents());
  return {
    offset: content.message.length,
    skillsBefore: content.placements.filter((placement) => placement.offset === content.message.length).length,
  };
}

function restoreInlineComposerCaret(editor: HTMLDivElement, caret: InlineComposerCaret): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  let textOffset = 0;
  let skillsAtOffset = 0;

  function placeAtEditorBoundary(index: number): void {
    range.setStart(editor, index);
    range.collapse(true);
  }

  function placeInText(node: Node, offset: number): boolean {
    if (node.nodeType === Node.TEXT_NODE) {
      range.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
      range.collapse(true);
      return true;
    }
    let remaining = offset;
    for (const child of node.childNodes) {
      const length = readInlineComposerContent(child).message.length;
      if (remaining <= length && placeInText(child, remaining)) return true;
      remaining -= length;
    }
    return false;
  }

  let placed = false;
  for (const [index, child] of [...editor.childNodes].entries()) {
    const element = child.nodeType === Node.ELEMENT_NODE ? child as HTMLElement : undefined;
    if (element?.dataset.composerSkillId) {
      if (textOffset === caret.offset && skillsAtOffset === caret.skillsBefore) {
        placeAtEditorBoundary(index);
        placed = true;
        break;
      }
      if (textOffset === caret.offset) skillsAtOffset += 1;
      if (textOffset === caret.offset && skillsAtOffset === caret.skillsBefore) {
        placeAtEditorBoundary(index + 1);
        placed = true;
        break;
      }
      continue;
    }

    const textLength = readInlineComposerContent(child).message.length;
    const textEnd = textOffset + textLength;
    const atTextStart = caret.offset === textOffset && caret.skillsBefore === skillsAtOffset;
    const insideText = caret.offset > textOffset && caret.offset < textEnd;
    const atTextEnd = caret.offset === textEnd && caret.skillsBefore === 0;
    if ((atTextStart || insideText || atTextEnd) && placeInText(child, caret.offset - textOffset)) {
      placed = true;
      break;
    }
    textOffset = textEnd;
    skillsAtOffset = 0;
  }
  if (!placed) placeAtEditorBoundary(editor.childNodes.length);
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertPlainTextAtSelection(editor: HTMLDivElement, text: string): void {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined;
  if (!selection || !range || !editor.contains(range.commonAncestorContainer)) {
    editor.append(document.createTextNode(text));
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
