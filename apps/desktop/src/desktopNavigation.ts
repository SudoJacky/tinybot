export type DesktopNavigationKind =
  | "internal-docs"
  | "workbench-route"
  | "gateway-action"
  | "external-url"
  | "invalid";

export interface DesktopNavigationTarget {
  kind: DesktopNavigationKind;
  href: string;
}

export interface DesktopNavigationOptions {
  desktopOrigin?: string;
  gatewayOrigin: string;
  openExternal: (href: string) => Promise<void>;
  navigateInternal?: (target: DesktopNavigationTarget) => void | Promise<void>;
  routeGatewayAction?: (target: DesktopNavigationTarget) => void | Promise<void>;
  targetWindow?: Window;
}

interface AnchorLike {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

interface ClickLike {
  button?: number;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target: unknown;
  preventDefault(): void;
}

interface InstallDesktopNavigationOptions extends DesktopNavigationOptions {
  targetDocument?: Document;
}

const GATEWAY_PATH_PREFIXES = ["/webui/", "/api/", "/v1/knowledge/"];

export function installDesktopNavigation({
  targetDocument = document,
  ...options
}: InstallDesktopNavigationOptions): void {
  targetDocument.addEventListener(
    "click",
    (event) => {
      void handleDesktopNavigationClick(event, options).catch((error) => {
        console.warn("Tinybot desktop navigation failed", error);
      });
    },
    true,
  );
}

export async function handleDesktopNavigationClick(
  event: ClickLike,
  options: DesktopNavigationOptions,
): Promise<boolean> {
  if (shouldIgnoreClick(event)) {
    return false;
  }

  const anchor = anchorFromTarget(event.target);
  const href = anchor?.getAttribute("href");
  if (!anchor || !href || anchor.hasAttribute("download")) {
    return false;
  }

  const target = resolveDesktopNavigationTarget(href, options);
  if (target.kind === "external-url") {
    event.preventDefault();
    await options.openExternal(target.href);
    return true;
  }

  if (target.kind === "internal-docs" || target.kind === "workbench-route") {
    event.preventDefault();
    await routeInternalNavigation(target, options);
    return true;
  }

  if (target.kind === "gateway-action") {
    event.preventDefault();
    await routeGatewayAction(target, options);
    return true;
  }

  return false;
}

function anchorFromTarget(target: unknown): AnchorLike | null {
  if (!target || typeof target !== "object" || !("closest" in target)) {
    return null;
  }
  const closest = (target as { closest?: unknown }).closest;
  if (typeof closest !== "function") {
    return null;
  }
  return closest.call(target, "a[href]") as AnchorLike | null;
}

export function resolveDesktopNavigationTarget(
  href: string,
  { desktopOrigin = window.location.origin, gatewayOrigin }: Pick<DesktopNavigationOptions, "desktopOrigin" | "gatewayOrigin">,
): DesktopNavigationTarget {
  let url: URL;
  try {
    url = new URL(href, desktopOrigin);
  } catch {
    return { kind: "invalid", href };
  }

  const gatewayUrl = new URL(gatewayOrigin);
  if (url.origin === gatewayUrl.origin || isGatewayPath(url.pathname)) {
    const gatewayTarget = new URL(`${url.pathname}${url.search}${url.hash}`, gatewayUrl.origin);
    return { kind: "gateway-action", href: gatewayTarget.href };
  }

  if (url.origin !== desktopOrigin || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return { kind: "external-url", href: url.href };
  }

  if (url.pathname === "/docs" || url.pathname.startsWith("/docs/")) {
    return { kind: "internal-docs", href: url.href };
  }

  return { kind: "workbench-route", href: url.href };
}

function shouldIgnoreClick(event: ClickLike): boolean {
  return (
    event.button !== undefined && event.button !== 0
  ) || event.metaKey === true || event.ctrlKey === true || event.shiftKey === true || event.altKey === true;
}

function isGatewayPath(pathname: string): boolean {
  return GATEWAY_PATH_PREFIXES.some((prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix));
}

async function routeInternalNavigation(target: DesktopNavigationTarget, options: DesktopNavigationOptions): Promise<void> {
  if (options.navigateInternal) {
    await options.navigateInternal(target);
    return;
  }

  const targetWindow = options.targetWindow ?? window;
  if (target.kind === "internal-docs") {
    targetWindow.location.assign(target.href);
    return;
  }

  targetWindow.history.pushState({ tinybotDesktopRoute: target.href }, "", target.href);
  targetWindow.document.documentElement.dataset.desktopNavigationKind = target.kind;
  targetWindow.document.documentElement.dataset.desktopNavigationHref = target.href;
  const routeStatus = targetWindow.document.querySelector("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = `Route ${new URL(target.href).pathname}`;
  }
  targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-route", { detail: target }));
}

async function routeGatewayAction(target: DesktopNavigationTarget, options: DesktopNavigationOptions): Promise<void> {
  if (options.routeGatewayAction) {
    await options.routeGatewayAction(target);
    return;
  }

  const targetWindow = options.targetWindow ?? window;
  targetWindow.document.documentElement.dataset.desktopNavigationKind = target.kind;
  targetWindow.document.documentElement.dataset.desktopNavigationHref = target.href;
  const routeStatus = targetWindow.document.querySelector("[data-desktop-route-status]");
  if (routeStatus) {
    routeStatus.textContent = `Gateway action ${new URL(target.href).pathname}`;
  }
  targetWindow.dispatchEvent(new CustomEvent("tinybot:desktop-gateway-action", { detail: target }));
}
