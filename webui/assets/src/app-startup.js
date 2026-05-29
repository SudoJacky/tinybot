export function runWhenDocumentReady(documentRef, callback) {
  if (documentRef.readyState === "loading") {
    documentRef.addEventListener("DOMContentLoaded", callback, { once: true });
    return;
  }
  callback();
}
