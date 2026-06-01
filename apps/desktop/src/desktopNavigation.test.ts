import { describe, expect, test, vi } from "vitest";
import {
  handleDesktopNavigationClick,
  resolveDesktopNavigationTarget,
} from "./desktopNavigation";

const desktopOrigin = "http://tauri.localhost";
const gatewayOrigin = "http://127.0.0.1:18790";

describe("desktop navigation", () => {
  test("classifies docs, workbench, gateway, and external targets", () => {
    expect(resolveDesktopNavigationTarget("/docs/quickstart", { desktopOrigin, gatewayOrigin })).toMatchObject({
      kind: "internal-docs",
      href: "http://tauri.localhost/docs/quickstart",
    });
    expect(resolveDesktopNavigationTarget("/cowork", { desktopOrigin, gatewayOrigin })).toMatchObject({
      kind: "workbench-route",
      href: "http://tauri.localhost/cowork",
    });
    expect(resolveDesktopNavigationTarget("/api/sessions", { desktopOrigin, gatewayOrigin })).toMatchObject({
      kind: "gateway-action",
      href: "http://127.0.0.1:18790/api/sessions",
    });
    expect(resolveDesktopNavigationTarget("https://github.com/SudoJacky/tinybot", { desktopOrigin, gatewayOrigin })).toMatchObject({
      kind: "external-url",
      href: "https://github.com/SudoJacky/tinybot",
    });
  });

  test("opens external links through the OS opener without navigating the workbench", async () => {
    const preventDefault = vi.fn();
    const openExternal = vi.fn(async () => undefined);

    const handled = await handleDesktopNavigationClick(
      {
        button: 0,
        preventDefault,
        target: {
          closest: () => ({
            getAttribute: (name: string) => (name === "href" ? "https://github.com/SudoJacky/tinybot" : null),
            hasAttribute: () => false,
          }),
        },
      },
      { desktopOrigin, gatewayOrigin, openExternal },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/SudoJacky/tinybot");
  });

  test("routes internal docs navigation inside the desktop webview", async () => {
    const preventDefault = vi.fn();
    const openExternal = vi.fn(async () => undefined);
    const navigateInternal = vi.fn();

    const handled = await handleDesktopNavigationClick(
      {
        button: 0,
        preventDefault,
        target: {
          closest: () => ({
            getAttribute: (name: string) => (name === "href" ? "/docs" : null),
            hasAttribute: () => false,
          }),
        },
      },
      { desktopOrigin, gatewayOrigin, openExternal, navigateInternal },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(openExternal).not.toHaveBeenCalled();
    expect(navigateInternal).toHaveBeenCalledWith({
      kind: "internal-docs",
      href: "http://tauri.localhost/docs",
    });
  });

  test("routes workbench links without leaving the current webview", async () => {
    const preventDefault = vi.fn();
    const navigateInternal = vi.fn();

    const handled = await handleDesktopNavigationClick(
      {
        button: 0,
        preventDefault,
        target: {
          closest: () => ({
            getAttribute: (name: string) => (name === "href" ? "/workspace" : null),
            hasAttribute: () => false,
          }),
        },
      },
      { desktopOrigin, gatewayOrigin, openExternal: vi.fn(), navigateInternal },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(navigateInternal).toHaveBeenCalledWith({
      kind: "workbench-route",
      href: "http://tauri.localhost/workspace",
    });
  });

  test("blocks accidental gateway API navigation from anchor clicks", async () => {
    const preventDefault = vi.fn();
    const routeGatewayAction = vi.fn();

    const handled = await handleDesktopNavigationClick(
      {
        button: 0,
        preventDefault,
        target: {
          closest: () => ({
            getAttribute: (name: string) => (name === "href" ? "/api/sessions" : null),
            hasAttribute: () => false,
          }),
        },
      },
      { desktopOrigin, gatewayOrigin, openExternal: vi.fn(), routeGatewayAction },
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(routeGatewayAction).toHaveBeenCalledWith({
      kind: "gateway-action",
      href: "http://127.0.0.1:18790/api/sessions",
    });
  });
});
