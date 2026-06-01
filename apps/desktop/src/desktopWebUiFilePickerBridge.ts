import {
  buildDesktopUploadFile,
  desktopUploadPickerOptions,
  type DesktopPickedUploadFile,
  type DesktopUploadKind,
  type DesktopUploadPickerOptions,
} from "./desktopFileUpload";

export interface DesktopWebUiFilePickerBridgeOptions {
  targetDocument?: Document;
  pickFile: (
    kind: DesktopUploadKind,
    options: DesktopUploadPickerOptions,
  ) => Promise<DesktopPickedUploadFile | null>;
  createDataTransfer?: () => DataTransfer;
}

interface DesktopFileInputSelectionOptions extends DesktopWebUiFilePickerBridgeOptions {
  input: HTMLInputElement;
  kind: DesktopUploadKind;
}

const WEBUI_FILE_TARGETS: Array<{
  buttonSelector: string;
  inputSelector: string;
  kind: DesktopUploadKind;
}> = [
  {
    buttonSelector: "#temporary-file-button",
    inputSelector: "#temporary-file-upload",
    kind: "session-temporary-file",
  },
  {
    buttonSelector: "#upload-doc-button",
    inputSelector: "#doc-file-upload",
    kind: "knowledge-document",
  },
];

export function installDesktopWebUiFilePickerBridge({
  targetDocument = document,
  pickFile,
  createDataTransfer,
}: DesktopWebUiFilePickerBridgeOptions): void {
  for (const target of WEBUI_FILE_TARGETS) {
    const button = targetDocument.querySelector<HTMLButtonElement>(target.buttonSelector);
    const input = targetDocument.querySelector<HTMLInputElement>(target.inputSelector);
    if (!button || !input) {
      continue;
    }

    button.addEventListener(
      "click",
      async (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        await selectDesktopFileForWebUiInput({
          input,
          kind: target.kind,
          pickFile,
          createDataTransfer,
        });
      },
      true,
    );
  }
}

export async function selectDesktopFileForWebUiInput({
  input,
  kind,
  pickFile,
  createDataTransfer = () => new DataTransfer(),
}: DesktopFileInputSelectionOptions): Promise<boolean> {
  const picked = await pickFile(kind, desktopUploadPickerOptions(kind));
  if (!picked) {
    return false;
  }

  const transfer = createDataTransfer();
  transfer.items.add(buildDesktopUploadFile(picked));
  input.files = transfer.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}
