export function bindStartupRetry(targetDocument: Document, retry: () => void): void {
  targetDocument.querySelector("#desktop-startup-retry")?.addEventListener("click", retry);
}

export function setStartupState(
  targetDocument: Document,
  message: string,
  diagnostics: string | null,
  recoverable: boolean,
): void {
  const status = targetDocument.querySelector<HTMLElement>("#desktop-startup-status");
  const detail = targetDocument.querySelector<HTMLElement>("#desktop-startup-diagnostics");
  const retry = targetDocument.querySelector<HTMLButtonElement>("#desktop-startup-retry");
  if (status) {
    status.textContent = message;
  }
  if (detail) {
    detail.textContent = diagnostics ?? "";
    detail.hidden = !diagnostics;
  }
  if (retry) {
    retry.hidden = !recoverable;
  }
}
