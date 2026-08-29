import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp } from "lucide-react";
import type {
  OfficeArtifactSource,
  OfficeArtifactKind,
  SpreadsheetCellChangeRequest,
} from "../../app-core/chat/officeArtifact";
import { logRendererEvent } from "../../app-core/native/rendererLogger";

const MAX_SPREADSHEET_ROWS = 200;
const MAX_SPREADSHEET_COLUMNS = 50;
const DEFAULT_PRESENTATION_WIDTH = 640;
const PRESENTATION_NAVIGATION_PROXIMITY_RADIUS = 120;
const PRESENTATION_THUMBNAIL_WIDTH = 120;

type SpreadsheetCell = boolean | Date | number | string | null;
type SpreadsheetSheet = { data: SpreadsheetCell[][]; sheet: string };
type SpreadsheetCellPosition = { columnIndex: number; rowIndex: number };
type SpreadsheetSelectionActionPosition = { left: number; top: number };
type PreviewState = "loading" | "ready";

function updatePresentationNavigationProximity(event: ReactPointerEvent<HTMLElement>): void {
  const pointerY = event.clientY;
  event.currentTarget.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    const bounds = button.getBoundingClientRect();
    const distance = Math.abs(pointerY - (bounds.top + (bounds.height / 2)));
    const proximity = Math.max(0, 1 - (distance / PRESENTATION_NAVIGATION_PROXIMITY_RADIUS));
    const smoothProximity = proximity * proximity * (3 - (2 * proximity));
    button.style.setProperty("--presentation-navigation-proximity", smoothProximity.toFixed(4));
  });
}

function clearPresentationNavigationProximity(event: ReactPointerEvent<HTMLElement>): void {
  event.currentTarget.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.style.setProperty("--presentation-navigation-proximity", "0");
  });
}

export function OfficeArtifactPreview({
  onAskForChange,
  source,
}: {
  onAskForChange?: (request: SpreadsheetCellChangeRequest) => void;
  source: OfficeArtifactSource;
}) {
  if (source.kind === "spreadsheet") {
    return <SpreadsheetPreview onAskForChange={onAskForChange} source={source} />;
  }
  if (source.kind === "document") return <DocumentPreview source={source} />;
  return <PresentationPreview source={source} />;
}

function SpreadsheetPreview({
  onAskForChange,
  source,
}: {
  onAskForChange?: (request: SpreadsheetCellChangeRequest) => void;
  source: OfficeArtifactSource;
}) {
  const { t } = useTranslation("chat");
  const changeInputId = useId();
  const changeInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [changeDraft, setChangeDraft] = useState("");
  const [changeEditorOpen, setChangeEditorOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [selectedCell, setSelectedCell] = useState<SpreadsheetCellPosition>();
  const [selectionActionPosition, setSelectionActionPosition] = useState<SpreadsheetSelectionActionPosition>();
  const [sheets, setSheets] = useState<SpreadsheetSheet[]>();

  useEffect(() => {
    let cancelled = false;
    const startedAt = performance.now();
    setActiveSheetIndex(0);
    setChangeDraft("");
    setChangeEditorOpen(false);
    setError(undefined);
    setSelectedCell(undefined);
    setSelectionActionPosition(undefined);
    setSheets(undefined);
    logRendererEvent("info", "artifact.office.parse.started", {
      format: source.kind,
      sizeBytes: source.bytes.byteLength,
    });
    void import("read-excel-file/browser")
      .then(({ default: readWorkbook }) => readWorkbook(toArrayBuffer(source.bytes)))
      .then((parsed) => {
        if (cancelled) return;
        const nextSheets = parsed.map((sheet) => ({
          data: sheet.data as SpreadsheetCell[][],
          sheet: sheet.sheet,
        }));
        setSheets(nextSheets);
        logOfficeParseComplete(source.kind, source.bytes.byteLength, startedAt, {
          sheetCount: nextSheets.length,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(logOfficeParseFailure(source.kind, source.bytes.byteLength, startedAt, cause));
      });
    return () => {
      cancelled = true;
    };
  }, [source.bytes, source.kind]);

  const activeSheet = sheets?.[activeSheetIndex];
  const rows = activeSheet?.data.slice(0, MAX_SPREADSHEET_ROWS) ?? [];
  const columnCount = Math.min(
    MAX_SPREADSHEET_COLUMNS,
    rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
  );

  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || !selectedCell) {
      setSelectionActionPosition(undefined);
      return;
    }
    const update = () => {
      const cell = grid.querySelector<HTMLElement>(spreadsheetCellSelector(selectedCell));
      if (!cell) {
        setSelectionActionPosition(undefined);
        return;
      }
      const cellBounds = cell.getBoundingClientRect();
      const gridBounds = grid.getBoundingClientRect();
      const rawLeft = cellBounds.left - gridBounds.left + grid.scrollLeft + (cellBounds.width / 2);
      const actionHalfWidth = changeEditorOpen
        ? Math.min(180, Math.max(0, grid.clientWidth - 16) / 2)
        : 88;
      const minimumLeft = grid.scrollLeft + 8 + actionHalfWidth;
      const maximumLeft = grid.scrollLeft + grid.clientWidth - 8 - actionHalfWidth;
      const next = {
        left: minimumLeft <= maximumLeft
          ? Math.max(minimumLeft, Math.min(maximumLeft, rawLeft))
          : grid.scrollLeft + (grid.clientWidth / 2),
        top: cellBounds.bottom - gridBounds.top + grid.scrollTop + 8,
      };
      setSelectionActionPosition((current) => (
        current?.left === next.left && current.top === next.top ? current : next
      ));
    };
    update();
    grid.addEventListener("scroll", update, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(grid);
    return () => {
      grid.removeEventListener("scroll", update);
      observer?.disconnect();
    };
  }, [activeSheetIndex, changeEditorOpen, columnCount, selectedCell]);

  useLayoutEffect(() => {
    if (!changeEditorOpen) return;
    changeInputRef.current?.focus();
  }, [changeEditorOpen]);

  function selectCell(position: SpreadsheetCellPosition, focus = false): void {
    setSelectedCell(position);
    setChangeDraft("");
    setChangeEditorOpen(false);
    if (!focus) return;
    window.requestAnimationFrame(() => {
      gridRef.current?.querySelector<HTMLButtonElement>(spreadsheetCellSelector(position))?.focus();
    });
  }

  function openChangeEditor(position: SpreadsheetCellPosition): void {
    if (!activeSheet || !onAskForChange) return;
    const address = spreadsheetCellAddress(position.rowIndex, position.columnIndex);
    setSelectedCell(position);
    setChangeDraft("");
    setChangeEditorOpen(true);
    logRendererEvent("info", "artifact.office.selection.change_editor_opened", {
      address,
      format: source.kind,
      sheet: activeSheet.sheet,
    });
  }

  function confirmChangeRequest(position: SpreadsheetCellPosition): void {
    if (!activeSheet || !onAskForChange) return;
    const instruction = changeDraft.trim();
    if (!instruction) return;
    const address = spreadsheetCellAddress(position.rowIndex, position.columnIndex);
    onAskForChange({
      address,
      instruction,
      sheet: activeSheet.sheet,
      value: formatSpreadsheetCell(activeSheet.data[position.rowIndex]?.[position.columnIndex]),
    });
    setChangeDraft("");
    setChangeEditorOpen(false);
    logRendererEvent("info", "artifact.office.selection.change_confirmed", {
      address,
      format: source.kind,
      sheet: activeSheet.sheet,
    });
  }

  function handleCellKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    position: SpreadsheetCellPosition,
  ): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      selectCell(position);
      openChangeEditor(position);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSelectedCell(undefined);
      return;
    }
    const delta = spreadsheetArrowDelta(event.key);
    if (!delta) return;
    event.preventDefault();
    selectCell({
      columnIndex: Math.max(0, Math.min(columnCount - 1, position.columnIndex + delta.columnIndex)),
      rowIndex: Math.max(0, Math.min(rows.length - 1, position.rowIndex + delta.rowIndex)),
    }, true);
  }

  return (
    <OfficePreviewFrame error={error} format="Excel" loading={!error && !sheets} title={source.title}>
      {sheets?.length && activeSheet ? (
        <>
          <div aria-label={t("details.officeSheets")} className="react-office-preview__tabs" role="tablist">
            {sheets.map((sheet, index) => (
              <button
                aria-selected={activeSheetIndex === index}
                className="react-office-preview__tab"
                key={`${sheet.sheet}-${index}`}
                onClick={() => {
                  setActiveSheetIndex(index);
                  setChangeDraft("");
                  setChangeEditorOpen(false);
                  setSelectedCell(undefined);
                }}
                role="tab"
                type="button"
              >
                {sheet.sheet}
              </button>
            ))}
          </div>
          {activeSheet.data.length > MAX_SPREADSHEET_ROWS || activeSheet.data.some((row) => row.length > MAX_SPREADSHEET_COLUMNS) ? (
            <p className="react-artifact-detail__notice">
              {t("details.officeSpreadsheetTruncated", {
                columns: MAX_SPREADSHEET_COLUMNS,
                rows: MAX_SPREADSHEET_ROWS,
              })}
            </p>
          ) : null}
          <div
            aria-label={activeSheet.sheet}
            className="react-office-spreadsheet"
            data-change-editor={changeEditorOpen ? "true" : undefined}
            data-has-selection={selectedCell ? "true" : undefined}
            ref={gridRef}
            role="region"
          >
            <table role="grid">
              <thead>
                <tr>
                  <th aria-hidden="true" className="react-office-spreadsheet__row-number" />
                  {Array.from({ length: columnCount }, (_, index) => (
                    <th data-selected={selectedCell?.columnIndex === index ? "true" : undefined} key={index} scope="col">
                      {spreadsheetColumnName(index)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    <th
                      className="react-office-spreadsheet__row-number"
                      data-selected={selectedCell?.rowIndex === rowIndex ? "true" : undefined}
                      scope="row"
                    >
                      {rowIndex + 1}
                    </th>
                    {Array.from({ length: columnCount }, (_, columnIndex) => {
                      const position = { columnIndex, rowIndex };
                      const address = spreadsheetCellAddress(rowIndex, columnIndex);
                      const value = formatSpreadsheetCell(row[columnIndex]);
                      const selected = selectedCell?.rowIndex === rowIndex && selectedCell.columnIndex === columnIndex;
                      return (
                        <td aria-selected={selected} data-selected={selected ? "true" : undefined} key={columnIndex} role="gridcell">
                          <button
                            aria-keyshortcuts="Control+I Meta+I"
                            aria-label={t("details.officeCellLabel", {
                              cell: address,
                              value: value || t("details.officeCellEmpty"),
                            })}
                            className="react-office-spreadsheet__cell"
                            data-cell-column={columnIndex}
                            data-cell-row={rowIndex}
                            tabIndex={selected || (!selectedCell && rowIndex === 0 && columnIndex === 0) ? 0 : -1}
                            type="button"
                            onClick={() => selectCell(position)}
                            onKeyDown={(event) => handleCellKeyDown(event, position)}
                          >
                            {value}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
            {selectedCell && selectionActionPosition && onAskForChange ? (
              <div
                className="react-office-spreadsheet__selection-action"
                data-mode={changeEditorOpen ? "editor" : "action"}
                style={{ left: selectionActionPosition.left, top: selectionActionPosition.top }}
              >
                {changeEditorOpen ? (
                  <form
                    aria-label={t("details.officeChangeEditorLabel", {
                      cell: spreadsheetCellAddress(selectedCell.rowIndex, selectedCell.columnIndex),
                    })}
                    onSubmit={(event) => {
                      event.preventDefault();
                      confirmChangeRequest(selectedCell);
                    }}
                  >
                    <label className="react-sr-only" htmlFor={changeInputId}>
                      {t("details.officeChangeEditorLabel", {
                        cell: spreadsheetCellAddress(selectedCell.rowIndex, selectedCell.columnIndex),
                      })}
                    </label>
                    <input
                      id={changeInputId}
                      onChange={(event) => setChangeDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        setChangeDraft("");
                        setChangeEditorOpen(false);
                        gridRef.current?.querySelector<HTMLButtonElement>(spreadsheetCellSelector(selectedCell))?.focus();
                      }}
                      placeholder={t("details.officeChangeEditorPlaceholder")}
                      ref={changeInputRef}
                      value={changeDraft}
                    />
                    <button
                      aria-label={t("details.officeChangeEditorConfirm")}
                      disabled={!changeDraft.trim()}
                      type="submit"
                    >
                      <ArrowUp aria-hidden="true" size={17} />
                    </button>
                  </form>
                ) : (
                  <button
                    aria-keyshortcuts="Control+I Meta+I"
                    type="button"
                    onClick={() => openChangeEditor(selectedCell)}
                  >
                    <span>{t("details.officeAskForChange")}</span>
                    <kbd>{t("details.officeAskForChangeShortcut")}</kbd>
                  </button>
                )}
              </div>
            ) : null}
            <p aria-live="polite" className="react-sr-only">
              {selectedCell ? t("details.officeCellSelected", {
                cell: spreadsheetCellAddress(selectedCell.rowIndex, selectedCell.columnIndex),
                sheet: activeSheet.sheet,
              }) : ""}
            </p>
          </div>
        </>
      ) : sheets ? <p>{t("details.noPreview")}</p> : null}
    </OfficePreviewFrame>
  );
}

function DocumentPreview({ source }: { source: OfficeArtifactSource }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [state, setState] = useState<PreviewState>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    const startedAt = performance.now();
    setError(undefined);
    setState("loading");
    container.replaceChildren();
    logRendererEvent("info", "artifact.office.parse.started", {
      format: source.kind,
      sizeBytes: source.bytes.byteLength,
    });
    void import("docx-preview")
      .then(({ renderAsync }) => renderAsync(toArrayBuffer(source.bytes), container, undefined, {
        breakPages: false,
        debug: false,
        experimental: false,
        ignoreHeight: true,
        ignoreWidth: true,
        inWrapper: false,
        renderAltChunks: false,
        renderComments: false,
        renderEndnotes: true,
        renderFooters: false,
        renderFootnotes: true,
        renderHeaders: false,
        renderChanges: false,
        useBase64URL: true,
      }))
      .then(() => {
        if (cancelled) return;
        sanitizeRenderedOfficeDom(container);
        setState("ready");
        logOfficeParseComplete(source.kind, source.bytes.byteLength, startedAt);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(logOfficeParseFailure(source.kind, source.bytes.byteLength, startedAt, cause));
      });
    return () => {
      cancelled = true;
      container.replaceChildren();
    };
  }, [source.bytes, source.kind]);

  return (
    <OfficePreviewFrame error={error} format="Word" loading={!error && state === "loading"} title={source.title}>
      <div className="react-office-document" onClickCapture={blockRenderedOfficeNavigation} ref={containerRef} />
    </OfficePreviewFrame>
  );
}

function PresentationPreview({ source }: { source: OfficeArtifactSource }) {
  const { t } = useTranslation("chat");
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbnailHostRefs = useRef<Array<HTMLElement | null>>([]);
  const width = usePreviewWidth(containerRef);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [error, setError] = useState<string>();
  const [navigationExpanded, setNavigationExpanded] = useState(false);
  const [slideCount, setSlideCount] = useState(0);
  const [state, setState] = useState<PreviewState>("loading");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let dispose: (() => void) | undefined;
    const startedAt = performance.now();
    setActiveSlideIndex(0);
    setError(undefined);
    setNavigationExpanded(false);
    setSlideCount(0);
    setState("loading");
    container.replaceChildren();
    logRendererEvent("info", "artifact.office.parse.started", {
      format: source.kind,
      sizeBytes: source.bytes.byteLength,
    });
    void import("pptx-preview")
      .then(({ init }) => {
        if (cancelled) return;
        const previewer = init(container, { mode: "list", width });
        dispose = () => previewer.destroy();
        return previewer.preview(toArrayBuffer(source.bytes));
      })
      .then(() => {
        if (cancelled) return;
        sanitizeRenderedOfficeDom(container);
        const nextSlideCount = presentationSlides(container).length;
        setSlideCount(nextSlideCount);
        setState("ready");
        logOfficeParseComplete(source.kind, source.bytes.byteLength, startedAt, {
          slideCount: nextSlideCount,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(logOfficeParseFailure(source.kind, source.bytes.byteLength, startedAt, cause));
      });
    return () => {
      cancelled = true;
      dispose?.();
      container.replaceChildren();
    };
  }, [source.bytes, source.kind, width]);

  useLayoutEffect(() => {
    if (state !== "ready" || !navigationExpanded) {
      thumbnailHostRefs.current.forEach((host) => host?.replaceChildren());
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const frame = window.requestAnimationFrame(() => {
      syncPresentationThumbnails(
        presentationSlides(container),
        thumbnailHostRefs.current,
      );
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationExpanded, slideCount, state, width]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || state !== "ready" || typeof IntersectionObserver === "undefined") return;
    const slides = presentationSlides(container);
    const visibility = new Map<Element, number>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        visibility.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      });
      const visible = slides
        .map((slide, index) => ({ index, ratio: visibility.get(slide) ?? 0 }))
        .filter((candidate) => candidate.ratio > 0)
        .sort((left, right) => right.ratio - left.ratio || left.index - right.index)[0];
      if (visible) setActiveSlideIndex(visible.index);
    }, {
      root: container.closest(".react-sidecar__artifact"),
      threshold: [0.25, 0.5, 0.75],
    });
    slides.forEach((slide) => observer.observe(slide));
    return () => observer.disconnect();
  }, [slideCount, state, width]);

  function navigateToSlide(index: number): void {
    const container = containerRef.current;
    const slide = container ? presentationSlides(container)[index] : undefined;
    if (!container || !slide) {
      logRendererEvent("error", "artifact.office.presentation.slide_navigation_failed", {
        reason: container ? "slide_unavailable" : "renderer_unavailable",
        requestedIndex: index,
        slideCount,
      });
      throw new Error(`PowerPoint slide ${index + 1} is unavailable.`);
    }
    const artifactScroller = container.closest<HTMLElement>(".react-sidecar__artifact");
    if (!artifactScroller) {
      logRendererEvent("error", "artifact.office.presentation.slide_navigation_failed", {
        reason: "artifact_scroller_unavailable",
        requestedIndex: index,
        slideCount,
      });
      throw new Error("PowerPoint artifact scroller is unavailable.");
    }
    setActiveSlideIndex(index);
    const artifactBounds = artifactScroller.getBoundingClientRect();
    const slideBounds = slide.getBoundingClientRect();
    artifactScroller.scrollTo({
      top: artifactScroller.scrollTop
        + slideBounds.top
        - artifactBounds.top
        - ((artifactScroller.clientHeight - slideBounds.height) / 2),
    });
    logRendererEvent("info", "artifact.office.presentation.slide_selected", {
      slideCount,
      slideNumber: index + 1,
    });
  }

  return (
    <OfficePreviewFrame error={error} format="PowerPoint" loading={!error && state === "loading"} title={source.title}>
      <div className="react-office-presentation">
        {state === "ready" && slideCount > 0 ? (
          <nav
            aria-label={t("details.officePresentationNavigation")}
            className="react-office-presentation__navigation"
            data-expanded={navigationExpanded ? "true" : "false"}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setNavigationExpanded(false);
            }}
            onFocus={() => setNavigationExpanded(true)}
            onPointerEnter={() => setNavigationExpanded(true)}
            onPointerMove={updatePresentationNavigationProximity}
            onPointerLeave={(event) => {
              clearPresentationNavigationProximity(event);
              setNavigationExpanded(false);
            }}
          >
            <ol>
              {Array.from({ length: slideCount }, (_, index) => (
                <li key={index}>
                  <button
                    aria-current={activeSlideIndex === index ? "page" : undefined}
                    aria-label={t("details.officePresentationSlide", { slide: index + 1 })}
                    type="button"
                    onClick={() => navigateToSlide(index)}
                  >
                    <span aria-hidden="true" className="react-office-presentation__navigation-bar" />
                    <span aria-hidden="true" className="react-office-presentation__slide-number">{index + 1}</span>
                    <span
                      aria-hidden="true"
                      className="react-office-presentation__thumbnail"
                      ref={(element) => { thumbnailHostRefs.current[index] = element; }}
                    />
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}
        <div
          className="react-office-presentation__stage"
          onClickCapture={blockRenderedOfficeNavigation}
          ref={containerRef}
        />
      </div>
    </OfficePreviewFrame>
  );
}

function OfficePreviewFrame({
  children,
  error,
  format,
  loading,
  title,
}: {
  children: ReactNode;
  error?: string;
  format: string;
  loading: boolean;
  title: string;
}) {
  const { t } = useTranslation("chat");
  return (
    <section aria-label={`${title} — ${format}`} className="react-office-preview" data-format={format.toLowerCase()}>
      {loading ? <p aria-live="polite">{t("details.officePreviewLoading", { format })}</p> : null}
      {error ? <p role="alert">{t("details.officePreviewFailed", { format, message: error })}</p> : null}
      {!error ? children : null}
    </section>
  );
}

function usePreviewWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_PRESENTATION_WIDTH);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (nextWidth: number) => {
      const bounded = Math.max(320, Math.min(960, Math.floor(nextWidth)));
      setWidth((current) => Math.abs(current - bounded) >= 16 ? bounded : current);
    };
    if (element.clientWidth > 0) update(element.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      clearTimeout(timer);
      timer = setTimeout(() => update(entry.contentRect.width), 120);
    });
    observer.observe(element);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function presentationSlides(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    ".pptx-preview-wrapper > .pptx-preview-slide-wrapper",
  ));
}

function syncPresentationThumbnails(
  slides: readonly HTMLElement[],
  hosts: readonly (HTMLElement | null)[],
): void {
  hosts.forEach((host, index) => {
    if (!host) return;
    host.replaceChildren();
    const slide = slides[index];
    if (!slide) return;
    const slideWidth = Number.parseFloat(slide.style.width) || slide.getBoundingClientRect().width;
    const slideHeight = Number.parseFloat(slide.style.height) || slide.getBoundingClientRect().height;
    if (!(slideWidth > 0) || !(slideHeight > 0)) {
      throw new Error(`PowerPoint slide ${index + 1} has invalid preview dimensions.`);
    }
    const clone = slide.cloneNode(true) as HTMLElement;
    clone.setAttribute("aria-hidden", "true");
    clone.classList.add("react-office-presentation__thumbnail-slide");
    clone.style.margin = "0";
    clone.style.pointerEvents = "none";
    clone.style.transform = `scale(${PRESENTATION_THUMBNAIL_WIDTH / slideWidth})`;
    clone.style.transformOrigin = "top left";
    host.style.aspectRatio = `${slideWidth} / ${slideHeight}`;
    host.replaceChildren(clone);
  });
}

function formatSpreadsheetCell(value: SpreadsheetCell | undefined): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toLocaleString();
  return String(value);
}

function spreadsheetColumnName(index: number): string {
  let value = index + 1;
  let result = "";
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function spreadsheetCellAddress(rowIndex: number, columnIndex: number): string {
  return `${spreadsheetColumnName(columnIndex)}${rowIndex + 1}`;
}

function spreadsheetCellSelector(position: SpreadsheetCellPosition): string {
  return `[data-cell-row="${position.rowIndex}"][data-cell-column="${position.columnIndex}"]`;
}

function spreadsheetArrowDelta(key: string): SpreadsheetCellPosition | undefined {
  if (key === "ArrowUp") return { columnIndex: 0, rowIndex: -1 };
  if (key === "ArrowDown") return { columnIndex: 0, rowIndex: 1 };
  if (key === "ArrowLeft") return { columnIndex: -1, rowIndex: 0 };
  if (key === "ArrowRight") return { columnIndex: 1, rowIndex: 0 };
  return undefined;
}

function sanitizeRenderedOfficeDom(container: HTMLElement): void {
  container.querySelectorAll("script, iframe, object, embed").forEach((element) => element.remove());
  container.querySelectorAll<HTMLElement>("[src], [href], [xlink\\:href]").forEach((element) => {
    for (const attribute of ["src", "href", "xlink:href"]) {
      const value = element.getAttribute(attribute);
      if (value && !/^(?:#|blob:|data:image\/)/i.test(value)) element.removeAttribute(attribute);
    }
  });
}

function blockRenderedOfficeNavigation(event: MouseEvent<HTMLElement>): void {
  if ((event.target as Element | null)?.closest("a")) event.preventDefault();
}

function logOfficeParseComplete(
  kind: OfficeArtifactKind,
  sizeBytes: number,
  startedAt: number,
  details: Record<string, unknown> = {},
): void {
  logRendererEvent("info", "artifact.office.parse.completed", {
    ...details,
    durationMs: Math.round(performance.now() - startedAt),
    format: kind,
    sizeBytes,
  });
}

function logOfficeParseFailure(
  kind: OfficeArtifactKind,
  sizeBytes: number,
  startedAt: number,
  cause: unknown,
): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  logRendererEvent("error", "artifact.office.parse.failed", {
    durationMs: Math.round(performance.now() - startedAt),
    error: message.slice(0, 512),
    format: kind,
    sizeBytes,
  });
  return message;
}
