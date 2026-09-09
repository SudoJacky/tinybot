export interface ComposerContextReference {
  presentation?: "compact-annotation";
  mimeType?: string;
  imageUrl?: string;
  annotation?: {
    label: string;
    text: string;
    onChange?: (text: string) => void;
  };
  body?: string;
  detail: string;
  id: string;
  kind: "file" | "terminal" | "reference";
  label: string;
}
