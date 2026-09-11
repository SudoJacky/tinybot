import { Node as EditorNode, type Editor } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import { Slice } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "@tiptap/markdown";
import { TableKit } from "@tiptap/extension-table";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import Image from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect, useImperativeHandle, useRef, type KeyboardEvent, type Ref } from "react";
import type { ComposerSkillOption } from "./composerContracts";
import "./MarkdownComposerEditor.css";

export interface MarkdownComposerCursor {
  text: string;
  offset: number;
}

export interface MarkdownComposerHandle {
  focusEnd(): void;
  replaceTrigger(from: number, to: number, skill?: ComposerSkillOption): void;
}

interface MarkdownComposerEditorProps {
  ref?: Ref<MarkdownComposerHandle>;
  value: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  skills: readonly ComposerSkillOption[];
  removeSkillLabel: (skill: ComposerSkillOption) => string;
  onChange: (markdown: string) => void;
  onCursorChange: (cursor: MarkdownComposerCursor) => void;
  onSkillsChange: (ids: string[]) => void;
  onImportFiles: (files: File[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  activeDescendant?: string;
  controls?: string;
}

const SkillToken = EditorNode.create({
  name: "composerSkill",
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  addAttributes: () => ({ id: { default: "" }, label: { default: "" }, removeLabel: { default: "" } }),
  renderHTML: ({ node }) => ["span", {
    class: "claude-ai-input__inline-skill",
    "data-composer-skill-id": node.attrs.id,
    contenteditable: "false",
  }, ["span", {}, node.attrs.label], ["button", {
    type: "button",
    "data-remove-skill-id": node.attrs.id,
    "aria-label": node.attrs.removeLabel,
  }, "×"]],
  // Skills travel through the existing structured turn options, never the prompt.
  renderMarkdown: () => "",
});

// Keep Markdown image references editable without fetching remote content while drafting.
const ImageReference = Image.extend({
  renderHTML: ({ node }) => ["span", {
    class: "markdown-composer__image-reference",
    title: node.attrs.src,
    contenteditable: "false",
  }, `▧ ${node.attrs.alt || node.attrs.src}`],
}).configure({ inline: true });

function skillIds(editor: Editor): string[] {
  const ids: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "composerSkill") ids.push(node.attrs.id as string);
  });
  return ids;
}

function cursor(editor: Editor): MarkdownComposerCursor {
  const { $from } = editor.state.selection;
  if ($from.parent.type.spec.code) return { text: "", offset: 0 };
  return {
    // Menus match the current text block, not serialized Markdown punctuation.
    text: $from.parent.textBetween(0, $from.parent.content.size, "", "\uFFFC"),
    offset: $from.parentOffset,
  };
}

export function MarkdownComposerEditor(props: MarkdownComposerEditorProps) {
  const { value, skills, removeSkillLabel } = props;
  const latest = useRef(props);
  latest.current = props;
  const lastValue = useRef(value);
  const synchronizing = useRef(false);
  const editorRef = useRef<Editor | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false }, underline: false }),
      Markdown.configure({ markedOptions: { gfm: true, breaks: true } }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      ImageReference,
      SkillToken,
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
    ],
    content: value,
    contentType: "markdown",
    editable: !props.disabled,
    editorProps: {
      attributes: {
        class: "claude-ai-input__textarea markdown-composer",
        role: "textbox",
        "aria-label": props.label,
        "aria-multiline": "true",
        "aria-disabled": String(props.disabled),
        "aria-autocomplete": "list",
        "aria-haspopup": "listbox",
        "aria-expanded": String(Boolean(props.controls)),
        ...(props.controls ? { "aria-controls": props.controls } : {}),
        ...(props.activeDescendant ? { "aria-activedescendant": props.activeDescendant } : {}),
      },
      handlePaste: (_view, event) => {
        const active = editorRef.current;
        if (!active || latest.current.disabled) return false;
        const files = Array.from(event.clipboardData?.files ?? []);
        event.preventDefault();
        if (files.length) latest.current.onImportFiles(files);
        else {
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (active.isActive("codeBlock")) active.view.dispatch(active.state.tr.insertText(text));
          else if (text) {
            if (!active.markdown) throw new Error("Composer Markdown parser is unavailable");
            const document = active.schema.nodeFromJSON(active.markdown.parse(text));
            // An open slice joins the first/last pasted blocks to the selection,
            // preserving ordinary mid-sentence paste and structured tables/lists.
            active.view.dispatch(active.state.tr.replaceSelection(Slice.maxOpen(document.content, false)).scrollIntoView());
          }
        }
        return true;
      },
      handleDrop: (_view, event) => (event.dataTransfer?.files.length ?? 0) > 0,
      clipboardTextSerializer: (slice) => {
        const active = editorRef.current;
        if (!active?.markdown) throw new Error("Composer Markdown serializer is unavailable");
        return active.markdown.serialize(slice.content.toJSON());
      },
    },
    onUpdate: ({ editor: active }) => {
      if (synchronizing.current) return;
      const markdown = active.getMarkdown();
      lastValue.current = markdown;
      latest.current.onChange(markdown);
      latest.current.onCursorChange(cursor(active));
      latest.current.onSkillsChange(skillIds(active));
    },
    onSelectionUpdate: ({ editor: active }) => {
      if (!synchronizing.current) latest.current.onCursorChange(cursor(active));
    },
  });
  editorRef.current = editor;

  useEffect(() => {
    if (!editor) return;
    editor.setEditable(!props.disabled, false);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (!editor) return;
    synchronizing.current = true;
    try {
      if (lastValue.current !== value) {
        editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false });
        lastValue.current = value;
      }
      const desired = new Set(skills.map((skill) => skill.id));
      const transaction = editor.state.tr;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "composerSkill" && !desired.has(node.attrs.id as string)) {
          const from = transaction.mapping.map(position);
          transaction.delete(from, from + node.nodeSize);
        }
      });
      if (transaction.docChanged) editor.view.dispatch(transaction);
      const existing = new Set(skillIds(editor));
      for (const skill of skills) {
        if (existing.has(skill.id)) continue;
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
          type: "composerSkill",
          attrs: { id: skill.id, label: skill.label, removeLabel: removeSkillLabel(skill) },
        });
      }
    } finally {
      synchronizing.current = false;
    }
  }, [editor, value, skills, removeSkillLabel]);

  useImperativeHandle(props.ref, () => ({
    focusEnd: () => { editor?.commands.focus("end"); },
    replaceTrigger: (from, to, skill) => {
      if (!editor) return;
      const start = editor.state.selection.$from.start();
      const chain = editor.chain().focus().deleteRange({ from: start + from, to: start + to });
      if (skill) chain.insertContent({
        type: "composerSkill",
        attrs: { id: skill.id, label: skill.label, removeLabel: latest.current.removeSkillLabel(skill) },
      });
      chain.run();
    },
  }), [editor]);

  return <EditorContent
    className="markdown-composer-container"
    editor={editor}
    onKeyDownCapture={(event) => {
      if ((event.target as Element).closest("button")) return;
      if (event.nativeEvent.isComposing || editor?.view.composing || event.keyCode === 229) return;
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        // Use the editor's structural Enter: continue lists and split paragraphs.
        editor?.commands.enter();
        return;
      }
      props.onKeyDown(event);
    }}
    onClick={(event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-remove-skill-id]");
      const id = button?.dataset.removeSkillId;
      if (!id || !editor || props.disabled) return;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === "composerSkill" && node.attrs.id === id) {
          editor.chain().focus().deleteRange({ from: position, to: position + node.nodeSize }).run();
          return false;
        }
      });
    }}
  />;
}
