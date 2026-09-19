/** Native drag transport, with a live row and a reversible, uncommitted slot preview. */
export interface SessionReorderMotion {
  finish: (commit: boolean) => void;
  dispose: () => void;
}

export function startSessionReorderMotion(
  source: HTMLElement,
  transfer: DataTransfer,
  pointer: { clientX: number; clientY: number },
  onCommit: (targetId: string, placement: "before" | "after") => void,
  onEnd: () => void,
): SessionReorderMotion | undefined {
  const scroller = source.closest<HTMLElement>(".react-session-list__rows")!;
  const rows = [...scroller.querySelectorAll<HTMLElement>(".react-session-row")]
    .filter((row) => row.dataset.reorderContainer === source.dataset.reorderContainer);
  const bounds = rows.map((row) => row.getBoundingClientRect());
  const origin = rows.indexOf(source);
  const box = bounds[origin];
  // Hidden/unlaid-out rows have no visual drag surface.
  if (!box.height) return undefined;
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const scrollStart = scroller.scrollTop;
  const gap = bounds.length > 1 ? bounds[1].top - bounds[0].bottom : 0;
  const ghost = document.createElement("div");
  ghost.className = "react-session-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, { left: box.left + "px", top: box.top + "px", width: box.width + "px", height: box.height + "px" });
  const skin = source.cloneNode(true) as HTMLElement;
  for (const node of [skin, ...skin.querySelectorAll<HTMLElement>("*")]) node.removeAttribute("id");
  for (const attribute of [...skin.attributes]) {
    if (attribute.name.startsWith("data-")) skin.removeAttribute(attribute.name);
  }
  skin.className = "react-session-row react-session-drag-ghost__skin";
  ghost.append(skin);
  source.closest(".react-session-list")!.append(ghost);
  const blank = document.createElement("canvas");
  blank.width = blank.height = 1;
  transfer.setDragImage(blank, 0, 0);
  source.dataset.reorderLifted = "true";
  rows.forEach((row) => { row.dataset.reorderPreview = "true"; });

  let active = true;
  let frame = 0;
  const settling: Animation[] = [];
  let calmTimer = 0;
  let destination = origin;
  let valid = false;
  let x = pointer.clientX;
  let y = pointer.clientY;
  let lastX = x;
  let lastY = y;
  let lastMove = performance.now();
  let lastFrame = lastMove;
  let landing: Animation | undefined;

  function resetWarp(): void { skin.style.transform = "none"; }

  function preview(): void {
    const scroll = scroller.scrollTop - scrollStart;
    const viewport = scroller.getBoundingClientRect();
    valid = x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom
      && y >= bounds[0].top - scroll && y <= bounds[bounds.length - 1].bottom - scroll;
    const center = box.top + box.height / 2 + y - pointer.clientY + scroll;
    destination = valid ? bounds.filter((rect, index) => index !== origin && center > rect.top + rect.height / 2).length : origin;
    const order = rows.filter((row) => row !== source);
    order.splice(destination, 0, source);
    let top = bounds[0].top;
    for (const row of order) {
      const index = rows.indexOf(row);
      const offset = top - bounds[index].top;
      if (row !== source) row.style.transform = "translateY(" + offset + "px)";
      top += bounds[index].height + gap;
    }
    ghost.style.transform = "translate(" + (x - pointer.clientX) + "px," + (y - pointer.clientY) + "px)";
  }

  function tick(time: number): void {
    if (!active) return;
    if (!source.isConnected || rows.some((row) => !row.isConnected)) { finish(false); return; }
    const viewport = scroller.getBoundingClientRect();
    const elapsed = Math.min(time - lastFrame, 32);
    lastFrame = time;
    if (x >= viewport.left && x <= viewport.right && y >= viewport.top && y <= viewport.bottom) {
      const edge = 28;
      const speed = y < viewport.top + edge ? -1 : y > viewport.bottom - edge ? 1 : 0;
      scroller.scrollTop += speed * elapsed * 0.4;
    }
    preview();
    frame = requestAnimationFrame(tick);
  }

  function move(event: DragEvent): void {
    event.stopPropagation();
    const time = performance.now();
    const elapsed = Math.max(time - lastMove, 8);
    x = event.clientX;
    y = event.clientY;
    if (!preference.matches) {
      const vx = (x - lastX) / elapsed;
      const vy = (y - lastY) / elapsed;
      const stretchX = Math.min(Math.abs(vx) * 0.035, 0.07);
      const stretchY = Math.min(Math.abs(vy) * 0.035, 0.07);
      const tilt = Math.max(-2.5, Math.min(2.5, vx * 1.2));
      skin.style.transform = "rotate(" + tilt + "deg) scale(" + (1 + stretchX - stretchY * 0.5) + "," + (1 + stretchY - stretchX * 0.5) + ")";
      clearTimeout(calmTimer);
      calmTimer = window.setTimeout(resetWarp, 90);
    }
    lastX = x; lastY = y; lastMove = time;
    preview();
    if (valid) { event.preventDefault(); event.dataTransfer!.dropEffect = "move"; }
  }

  function drop(event: DragEvent): void {
    x = event.clientX; y = event.clientY;
    preview();
    event.stopPropagation();
    if (valid) event.preventDefault();
    finish(valid);
  }

  function cancel(): void { finish(false); }
  function escape(event: KeyboardEvent): void { if (event.key === "Escape") finish(false); }
  function clearVisuals(): void {
    if (landing) {
      landing.onfinish = null;
      landing.oncancel = null;
      landing.cancel();
    }
    ghost.remove();
    delete source.dataset.reorderLifted;
  }

  function finish(commit: boolean): void {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    clearTimeout(calmTimer);
    window.removeEventListener("dragover", move, true);
    window.removeEventListener("dragenter", move, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("dragend", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", escape, true);
    preference.removeEventListener("change", resetWarp);
    const from = ghost.getBoundingClientRect();
    const ordered = rows.filter((row) => row !== source);
    ordered.splice(commit ? destination : origin, 0, source);
    const top = bounds[0].top + ordered.slice(0, ordered.indexOf(source)).reduce((sum, row) => sum + bounds[rows.indexOf(row)].height + gap, 0) - (scroller.scrollTop - scrollStart);
    const visualTops = rows.map((row) => row.getBoundingClientRect().top);
    let nextTop = bounds[0].top - (scroller.scrollTop - scrollStart);
    // Commit and remove preview styles together; retain each row's current visual position.
    ordered.forEach((row) => {
      const index = rows.indexOf(row);
      const delta = visualTops[index] - nextTop;
      row.style.removeProperty("transform");
      delete row.dataset.reorderPreview;
      if (row !== source && !preference.matches && Math.abs(delta) > 0.5) {
        settling.push(row.animate([
          { transform: "translateY(" + delta + "px)" }, { transform: "translateY(0)" },
        ], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }));
      }
      nextTop += bounds[index].height + gap;
    });
    if (commit && destination !== origin) {
      onCommit(rows[destination].dataset.sessionId!, destination > origin ? "after" : "before");
    }
    onEnd();
    resetWarp();
    if (preference.matches || !source.isConnected) { clearVisuals(); return; }
    landing = ghost.animate([
      { transform: "translate(" + (from.left - box.left) + "px," + (from.top - box.top) + "px)" },
      { transform: "translate(0px," + (top - box.top) + "px)" },
    ], { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
    landing.onfinish = clearVisuals;
    landing.oncancel = clearVisuals;
  }

  window.addEventListener("dragover", move, true);
  window.addEventListener("dragenter", move, true);
  window.addEventListener("drop", drop, true);
  window.addEventListener("dragend", cancel);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", escape, true);
  preference.addEventListener("change", resetWarp);
  frame = requestAnimationFrame(tick);
  return { finish, dispose: () => { finish(false); clearVisuals(); settling.forEach((animation) => animation.cancel()); } };
}
