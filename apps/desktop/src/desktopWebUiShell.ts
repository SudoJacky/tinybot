export function installWebUiShell(
  html: string,
  targetDocument: Document = document,
  parser: DOMParser = new DOMParser(),
): void {
  const parsed = parser.parseFromString(html, "text/html");
  targetDocument.documentElement.lang = parsed.documentElement.lang || "zh-CN";
  targetDocument.documentElement.dataset.theme = parsed.documentElement.dataset.theme || "light";
  installWebUiHeadAssets(parsed, targetDocument);
  targetDocument.body.replaceChildren(...withoutScripts(parsed.body.childNodes));
}

function withoutScripts(nodes: NodeListOf<ChildNode>): ChildNode[] {
  return [...nodes].filter((node) => !(node instanceof HTMLScriptElement));
}

function installWebUiHeadAssets(source: Document, targetDocument: Document): void {
  for (const link of source.head.querySelectorAll<HTMLLinkElement>("link[rel='stylesheet'], link[rel='icon']")) {
    if (link.id.startsWith("hljs-") || link.href.startsWith("http")) {
      continue;
    }
    const href = link.getAttribute("href");
    if (href && targetDocument.head.querySelector(`link[href='${href}']`)) {
      continue;
    }
    targetDocument.head.append(link.cloneNode(true));
  }
}
