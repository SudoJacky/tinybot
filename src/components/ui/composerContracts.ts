import type { KeyboardEvent, Ref } from "react";

export interface ComposerSkillOption {
  description: string;
  id: string;
  label: string;
  sourceLabel: string;
}

export interface ComposerCursor {
  text: string;
  offset: number;
}

export interface ComposerEditorHandle {
  focusEnd(): void;
  replaceTrigger(from: number, to: number, skill?: ComposerSkillOption, text?: string): void;
}

export interface ComposerEditorProps {
  ref?: Ref<ComposerEditorHandle>;
  value: string;
  disabled: boolean;
  label: string;
  placeholder: string;
  skills: readonly ComposerSkillOption[];
  removeSkillLabel: (skill: ComposerSkillOption) => string;
  onChange: (text: string) => void;
  onCursorChange: (cursor: ComposerCursor) => void;
  onSkillsChange: (ids: string[]) => void;
  onImportFiles: (files: File[]) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement | HTMLTextAreaElement>) => void;
  activeDescendant?: string;
  controls?: string;
}
