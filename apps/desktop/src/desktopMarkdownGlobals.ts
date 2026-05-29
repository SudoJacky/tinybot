import hljs from "highlight.js";
import githubDarkThemeUrl from "highlight.js/styles/github-dark.css?url";
import githubThemeUrl from "highlight.js/styles/github.css?url";
import { marked } from "marked";

declare global {
  interface Window {
    marked: typeof marked;
    hljs: typeof hljs;
  }
}

export function installWebUiRenderGlobals(documentRef: Document = document): void {
  window.marked = marked;
  window.hljs = hljs;
  ensureThemeLink(documentRef, "hljs-light-theme", githubThemeUrl, false);
  ensureThemeLink(documentRef, "hljs-dark-theme", githubDarkThemeUrl, true);
}

function ensureThemeLink(documentRef: Document, id: string, href: string, disabled: boolean): void {
  let link = documentRef.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = documentRef.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    documentRef.head.append(link);
  }
  link.href = href;
  link.disabled = disabled;
}
