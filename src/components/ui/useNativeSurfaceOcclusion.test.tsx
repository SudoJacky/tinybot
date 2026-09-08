// @vitest-environment happy-dom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNativeSurfaceOcclusion } from "./useNativeSurfaceOcclusion";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const left = this.dataset.outside === "true" ? 10 : 700;
    return { x: left, y: 100, left, top: 100, right: left + 200, bottom: 300, width: 200, height: 200, toJSON: () => ({}) };
  });
});

function Surface({ enabled = true }: { enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const occlusion = useNativeSurfaceOcclusion(ref, enabled);
  return <div ref={ref} data-testid="surface" data-occlusion={occlusion ?? "clear"} />;
}

function Harness({ children, enabled = true }: { children?: ReactNode; enabled?: boolean }) {
  return <><Surface enabled={enabled} />{createPortal(children, document.body)}</>;
}

const status = () => screen.getByTestId("surface").getAttribute("data-occlusion");

describe("native surface overlay coordination", () => {
  it("blocks for every nested global modal, including portals outside the native rectangle", async () => {
    const view = render(<Harness />);
    view.rerender(<Harness><div role="dialog" aria-modal="true" data-outside="true" /><div role="alertdialog" aria-modal="true" /></Harness>);
    await waitFor(() => expect(status()).toBe("modal"));
    view.rerender(<Harness><div role="dialog" aria-modal="true" data-outside="true" /></Harness>);
    expect(status()).toBe("modal");
    view.rerender(<Harness />);
    await waitFor(() => expect(status()).toBe("clear"));
  });

  it("keeps retained closing overlays blocking until they leave, and supports reversal", async () => {
    const view = render(<Harness><aside data-native-overlay="modal" data-state="open" /></Harness>);
    expect(status()).toBe("modal");
    view.rerender(<Harness><aside data-native-overlay="modal" data-state="closing" aria-hidden inert /></Harness>);
    await act(async () => undefined);
    expect(status()).toBe("modal");
    view.rerender(<Harness><aside data-native-overlay="modal" data-state="open" /></Harness>);
    expect(status()).toBe("modal");
    view.rerender(<Harness />);
    await waitFor(() => expect(status()).toBe("clear"));
  });

  it("only blocks local menus that overlap and remeasures after repositioning", async () => {
    const view = render(<Harness><div className="react-popover-surface" data-outside="true" /></Harness>);
    expect(status()).toBe("clear");
    view.rerender(<Harness><div className="react-popover-surface" style={{ left: 700 }} /></Harness>);
    await waitFor(() => expect(status()).toBe("overlap"));
    view.rerender(<Harness><div className="react-popover-surface" data-outside="true" style={{ left: 10 }} /></Harness>);
    await waitFor(() => expect(status()).toBe("clear"));
  });

  it("ignores closed search/dialog layers and overlays hidden by an ancestor", async () => {
    const view = render(<Harness><div aria-hidden><div role="dialog" aria-modal="true" /></div></Harness>);
    expect(status()).toBe("clear");
    view.rerender(<Harness><div style={{ display: "none" }}><div role="dialog" aria-modal="true" /></div></Harness>);
    await act(async () => undefined);
    expect(status()).toBe("clear");
    view.rerender(<Harness><div><div role="dialog" aria-modal="true" /></div></Harness>);
    await waitFor(() => expect(status()).toBe("modal"));
  });

  it("does not restore a disabled surface when a modal closes", async () => {
    const view = render(<Harness><div role="dialog" aria-modal="true" /></Harness>);
    expect(status()).toBe("modal");
    view.rerender(<Harness enabled={false}><div role="dialog" aria-modal="true" /></Harness>);
    expect(status()).toBe("clear");
    view.rerender(<Harness enabled={false} />);
    await act(async () => undefined);
    expect(status()).toBe("clear");
    view.rerender(<Harness><div role="dialog" aria-modal="true" /></Harness>);
    expect(status()).toBe("modal");
  });

  it("does not measure the native surface for unrelated streaming text", async () => {
    const view = render(<Harness><p>Initial text</p></Harness>);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    const measure = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    measure.mockClear();
    view.rerender(<Harness><p>More streamed text</p></Harness>);
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(measure).not.toHaveBeenCalled();
  });
});
