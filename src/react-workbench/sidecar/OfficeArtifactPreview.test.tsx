// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeArtifactSource } from "../../app-core/chat/officeArtifact";
import { OfficeArtifactPreview } from "./OfficeArtifactPreview";

const parserMocks = vi.hoisted(() => ({
  destroyPresentation: vi.fn(),
  initializePresentation: vi.fn(),
  readWorkbook: vi.fn(),
  renderDocument: vi.fn(),
  renderPresentation: vi.fn(),
}));

vi.mock("read-excel-file/browser", () => ({ default: parserMocks.readWorkbook }));
vi.mock("docx-preview", () => ({ renderAsync: parserMocks.renderDocument }));
vi.mock("pptx-preview", () => ({ init: parserMocks.initializePresentation }));

function source(kind: OfficeArtifactSource["kind"]): OfficeArtifactSource {
  return { bytes: new Uint8Array([80, 75, 3, 4]), kind, title: `fixture-${kind}` };
}

afterEach(cleanup);

describe("Office artifact preview", () => {
  beforeEach(() => {
    parserMocks.destroyPresentation.mockReset();
    parserMocks.readWorkbook.mockReset();
    parserMocks.renderDocument.mockReset();
    parserMocks.renderPresentation.mockReset();
    parserMocks.initializePresentation.mockReset().mockReturnValue({
      destroy: parserMocks.destroyPresentation,
      preview: parserMocks.renderPresentation,
    });
  });

  it("renders workbook sheets as a bounded, switchable grid", async () => {
    const user = userEvent.setup();
    parserMocks.readWorkbook.mockResolvedValue([
      { sheet: "Revenue", data: [["Quarter", "Total"], ["Q1", 42]] },
      { sheet: "Costs", data: [["Category", "Total"], ["Hosting", 12]] },
    ]);

    render(<OfficeArtifactPreview source={source("spreadsheet")} />);

    expect((await screen.findByRole("tab", { name: "Revenue" })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Quarter")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Costs" }));
    expect(await screen.findByText("Hosting")).toBeTruthy();
  });

  it("selects a workbook cell and asks Chat to change that exact address", async () => {
    const user = userEvent.setup();
    const onAskForChange = vi.fn();
    parserMocks.readWorkbook.mockResolvedValue([
      { sheet: "Revenue", data: [["Quarter", "Total"], ["Q1", 42]] },
    ]);

    const view = render(<OfficeArtifactPreview onAskForChange={onAskForChange} source={source("spreadsheet")} />);
    const preview = within(view.container);

    const cell = await preview.findByRole("button", { name: "Cell B2, 42" });
    await user.click(cell);
    expect(cell.closest("td")?.getAttribute("aria-selected")).toBe("true");
    await user.click(preview.getByRole("button", { name: /Ask for change Ctrl I/ }));
    const changeInput = preview.getByRole("textbox", { name: "Change request for cell B2" });
    expect(document.activeElement).toBe(changeInput);
    await user.type(changeInput, "Increase this total to 48{Enter}");
    expect(onAskForChange).toHaveBeenCalledWith({
      address: "B2",
      instruction: "Increase this total to 48",
      sheet: "Revenue",
      value: "42",
    });
  });

  it("supports arrow-key cell navigation and the Ctrl+I change shortcut", async () => {
    const user = userEvent.setup();
    const onAskForChange = vi.fn();
    parserMocks.readWorkbook.mockResolvedValue([
      { sheet: "Revenue", data: [["Quarter", "Total"], ["Q1", 42]] },
    ]);

    const view = render(<OfficeArtifactPreview onAskForChange={onAskForChange} source={source("spreadsheet")} />);
    const preview = within(view.container);

    await user.click(await preview.findByRole("button", { name: "Cell A1, Quarter" }));
    await user.keyboard("{ArrowRight}");
    const nextCell = preview.getByRole("button", { name: "Cell B1, Total" });
    expect(document.activeElement).toBe(nextCell);
    expect(nextCell.closest("td")?.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{Control>}i{/Control}");
    const changeInput = preview.getByRole("textbox", { name: "Change request for cell B1" });
    await user.type(changeInput, "Rename this column{Escape}");
    expect(onAskForChange).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(nextCell));

    await user.keyboard("{Control>}i{/Control}");
    await user.type(preview.getByRole("textbox", { name: "Change request for cell B1" }), "Rename this column");
    await user.click(preview.getByRole("button", { name: "Add change request" }));
    expect(onAskForChange).toHaveBeenCalledWith({
      address: "B1",
      instruction: "Rename this column",
      sheet: "Revenue",
      value: "Total",
    });
  });

  it("extends a rectangular selection with Shift and sends its addresses and values", async () => {
    const user = userEvent.setup();
    const onAskForChange = vi.fn();
    parserMocks.readWorkbook.mockResolvedValue([{ sheet: "Revenue", data: [["Quarter", "Total"], ["Q1", 42]] }]);
    const view = render(<OfficeArtifactPreview onAskForChange={onAskForChange} source={source("spreadsheet")} />);
    const preview = within(view.container);
    await user.click(await preview.findByRole("button", { name: "Cell A1, Quarter" }));
    await user.keyboard("{Shift>}{ArrowRight}{ArrowDown}{/Shift}{Control>}i{/Control}");
    expect(view.container.querySelectorAll('td[aria-selected="true"]')).toHaveLength(4);
    await user.type(preview.getByRole("textbox"), "Explain this region{Enter}");
    expect(onAskForChange).toHaveBeenCalledWith({
      sheet: "Revenue", address: "A1:B2", instruction: "Explain this region",
      value: JSON.stringify([["Quarter", "Total"], ["Q1", "42"]]),
    });
  });

  it("drags a range backwards and clears it when switching worksheets", async () => {
    const user = userEvent.setup();
    const onAskForChange = vi.fn();
    parserMocks.readWorkbook.mockResolvedValue([
      { sheet: "Revenue", data: [["Quarter", "Total"], ["Q1", 42]] },
      { sheet: "Costs", data: [["Item", 12]] },
    ]);
    const view = render(<OfficeArtifactPreview onAskForChange={onAskForChange} source={source("spreadsheet")} />);
    const preview = within(view.container);
    const start = await preview.findByRole("button", { name: "Cell B2, 42" });
    const end = preview.getByRole("button", { name: "Cell A1, Quarter" });
    fireEvent.pointerDown(start, { button: 0, buttons: 1 });
    fireEvent.pointerEnter(end, { buttons: 1 });
    fireEvent.pointerUp(end, { button: 0 });
    fireEvent.click(end);
    expect(view.container.querySelectorAll('td[aria-selected="true"]')).toHaveLength(4);
    await user.click(preview.getByRole("button", { name: /Ask for change Ctrl I/ }));
    await user.type(preview.getByRole("textbox"), "Review this{Enter}");
    expect(onAskForChange.mock.calls[0][0].address).toBe("A1:B2");
    await user.click(preview.getByRole("tab", { name: "Costs" }));
    expect(view.container.querySelectorAll('td[aria-selected="true"]')).toHaveLength(0);
  });

  it("ignores a Word render that finishes after the source has refreshed", async () => {
    let finishOld: (() => void) | undefined;
    parserMocks.renderDocument.mockImplementationOnce((_bytes: ArrayBuffer, container: HTMLElement) => new Promise<void>((resolve) => {
      finishOld = () => { container.innerHTML = "<p>Obsolete version</p>"; resolve(); };
    })).mockImplementationOnce(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      container.innerHTML = "<p>Latest version</p>";
    });
    const original = source("document");
    const view = render(<OfficeArtifactPreview source={original} />);
    await waitFor(() => expect(finishOld).toBeDefined());
    view.rerender(<OfficeArtifactPreview source={{ ...original, bytes: new Uint8Array([2]) }} />);
    await within(view.container).findByText("Latest version");
    finishOld!();
    await waitFor(() => expect(within(view.container).queryByText("Obsolete version")).toBeNull());
    expect(within(view.container).getByText("Latest version")).toBeTruthy();
  });

  it("renders Word content locally and removes active or external content", async () => {
    parserMocks.renderDocument.mockImplementation(async (_bytes: ArrayBuffer, container: HTMLElement) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = "Project brief";
      const link = document.createElement("a");
      link.href = "https://example.com/tracker";
      link.textContent = "External tracker";
      const script = document.createElement("script");
      container.append(paragraph, link, script);
    });

    render(<OfficeArtifactPreview source={source("document")} />);

    expect(await screen.findByText("Project brief")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("External tracker").hasAttribute("href")).toBe(false));
    expect(document.querySelector(".react-office-document script")).toBeNull();
  });

  it("isolates a late PowerPoint renderer from the current source", async () => {
    let finishOld: (() => void) | undefined;
    let renderCount = 0;
    parserMocks.initializePresentation.mockImplementation((host: HTMLElement) => ({
      destroy: () => host.replaceChildren(),
      preview: () => {
        if (++renderCount === 1) return new Promise<void>((resolve) => {
          finishOld = () => { host.textContent = "Obsolete slide"; resolve(); };
        });
        host.textContent = "Current slide";
        return Promise.resolve();
      },
    }));
    const original = source("presentation");
    const view = render(<OfficeArtifactPreview source={original} />);
    await waitFor(() => expect(finishOld).toBeDefined());
    view.rerender(<OfficeArtifactPreview source={{ ...original, bytes: new Uint8Array([2]) }} />);
    await within(view.container).findByText("Current slide");
    finishOld!();
    await waitFor(() => expect(within(view.container).queryByText("Obsolete slide")).toBeNull());
    expect(within(view.container).getByText("Current slide")).toBeTruthy();
  });

  it("navigates PowerPoint slides inside the artifact scroller without moving the desktop shell", async () => {
    const user = userEvent.setup();
    const scrollToFirstSlide = vi.fn();
    const scrollToSecondSlide = vi.fn(() => {
      const routeSurface = document.querySelector<HTMLElement>(".react-route-surface");
      if (!routeSurface) throw new Error("PowerPoint test route surface is unavailable.");
      routeSurface.scrollTop = 42;
    });
    const artifactScrollTo = vi.fn();
    const scrollArtifact = ((optionsOrX?: ScrollToOptions | number, y?: number): void => {
      const artifact = document.querySelector<HTMLElement>(".react-sidecar__artifact");
      if (!artifact) throw new Error("PowerPoint test artifact scroller is unavailable.");
      if (typeof optionsOrX === "number") {
        artifactScrollTo(optionsOrX, y);
        artifact.scrollTop = y ?? 0;
        return;
      }
      artifactScrollTo(optionsOrX);
      artifact.scrollTop = optionsOrX?.top ?? 0;
    }) as HTMLElement["scrollTo"];
    parserMocks.renderPresentation.mockImplementation(async () => {
      const host = document.querySelector(".react-office-presentation__stage");
      const artifact = document.querySelector<HTMLElement>(".react-sidecar__artifact");
      if (!artifact) throw new Error("PowerPoint test artifact scroller is unavailable.");
      Object.defineProperty(artifact, "clientHeight", { configurable: true, value: 400 });
      artifact.getBoundingClientRect = () => ({
        bottom: 400,
        height: 400,
        left: 0,
        right: 560,
        top: 0,
        width: 560,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
      artifact.scrollTo = scrollArtifact;
      const wrapper = document.createElement("div");
      wrapper.className = "pptx-preview-wrapper";
      const firstSlide = document.createElement("div");
      firstSlide.className = "pptx-preview-slide-wrapper";
      firstSlide.style.width = "640px";
      firstSlide.style.height = "360px";
      firstSlide.textContent = "Quarterly plan";
      firstSlide.scrollIntoView = scrollToFirstSlide;
      const secondSlide = document.createElement("div");
      secondSlide.className = "pptx-preview-slide-wrapper";
      secondSlide.style.width = "640px";
      secondSlide.style.height = "360px";
      secondSlide.textContent = "Delivery plan";
      secondSlide.scrollIntoView = scrollToSecondSlide;
      secondSlide.getBoundingClientRect = () => ({
        bottom: 860,
        height: 360,
        left: 0,
        right: 560,
        top: 500,
        width: 560,
        x: 0,
        y: 500,
        toJSON: () => ({}),
      });
      wrapper.append(firstSlide, secondSlide);
      host?.append(wrapper);
    });

    const view = render(
      <div className="react-route-surface">
        <div className="react-sidecar__artifact">
          <OfficeArtifactPreview source={source("presentation")} />
        </div>
      </div>,
    );

    expect(await screen.findByText("Quarterly plan")).toBeTruthy();
    const navigation = await screen.findByRole("navigation", { name: "PowerPoint slides" });
    expect(navigation.getAttribute("data-expanded")).toBe("false");
    expect(within(navigation).getAllByRole("button")).toHaveLength(2);
    expect(within(navigation).getByRole("button", { name: "Go to slide 1" }).getAttribute("aria-current")).toBe("page");

    const slideButtons = within(navigation).getAllByRole("button");
    slideButtons[0].getBoundingClientRect = () => ({
      bottom: 28, height: 28, left: 0, right: 44, top: 0, width: 44, x: 0, y: 0, toJSON: () => ({}),
    });
    slideButtons[1].getBoundingClientRect = () => ({
      bottom: 58, height: 28, left: 0, right: 44, top: 30, width: 44, x: 0, y: 30, toJSON: () => ({}),
    });
    fireEvent.pointerMove(navigation, { clientY: 44 });
    expect(slideButtons[1].style.getPropertyValue("--presentation-navigation-proximity")).toBe("1.0000");
    expect(Number(slideButtons[0].style.getPropertyValue("--presentation-navigation-proximity"))).toBeGreaterThan(0);
    fireEvent.pointerLeave(navigation);
    expect(slideButtons[0].style.getPropertyValue("--presentation-navigation-proximity")).toBe("0");
    expect(slideButtons[1].style.getPropertyValue("--presentation-navigation-proximity")).toBe("0");

    await user.hover(navigation);
    expect(navigation.getAttribute("data-expanded")).toBe("true");
    await waitFor(() => {
      expect(navigation.querySelectorAll(".react-office-presentation__thumbnail-slide")).toHaveLength(2);
    });
    await user.unhover(navigation);
    expect(navigation.getAttribute("data-expanded")).toBe("false");

    await user.hover(navigation);
    await user.click(within(navigation).getByRole("button", { name: "Go to slide 2" }));
    expect(document.querySelector<HTMLElement>(".react-route-surface")?.scrollTop).toBe(0);
    expect(scrollToSecondSlide).not.toHaveBeenCalled();
    expect(artifactScrollTo).toHaveBeenCalledWith({ top: 480 });
    expect(within(navigation).getByRole("button", { name: "Go to slide 2" }).getAttribute("aria-current")).toBe("page");
    await user.unhover(navigation);
    expect(navigation.getAttribute("data-expanded")).toBe("false");
    expect(parserMocks.initializePresentation).toHaveBeenCalledWith(
      expect.any(HTMLElement),
      expect.objectContaining({ mode: "list" }),
    );
    view.unmount();
    expect(parserMocks.destroyPresentation).toHaveBeenCalledTimes(1);
  });
});
