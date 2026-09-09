// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { ComposerAnnotations } from "./ComposerAnnotations";
import { ClaudeStyleAiInput, type ComposerContextReference } from "./claude-style-ai-input";

afterEach(cleanup);
const reference: ComposerContextReference = { id: "annotation", presentation: "compact-annotation", kind: "file", label: "button · Buy", detail: "opacity: 1 → 0.94", imageUrl: "data:image/png;base64,AAAA", annotation: { label: "Requested change", text: "Make it quieter" } };

it("keeps composer attachments compact and opens bounded details outside the composer", async () => {
  const user = userEvent.setup();
  const { container } = render(<ClaudeStyleAiInput contextReferences={[reference]} />);
  const trigger = screen.getByRole("button", { name: "1 annotation" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText(reference.detail)).toBeNull();
  await user.hover(trigger);
  expect(screen.getByText(reference.detail)).toBeTruthy();
  expect(container.contains(screen.getByRole("dialog"))).toBe(false);
  expect(screen.getByRole("dialog").style.maxHeight).toBe("320px");
  await user.unhover(trigger);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("pins on click, edits the comment, dismisses on Escape, and removes the group", async () => {
  const user = userEvent.setup();
  function Demo() {
    const [refs, setRefs] = useState([reference]);
    return <ComposerAnnotations references={refs.map((item) => ({ ...item, annotation: { ...item.annotation!, onChange: (text) => setRefs((current) => current.map((entry) => ({ ...entry, annotation: { ...entry.annotation!, text } }))) } }))} onRemove={(id) => setRefs((current) => current.filter((item) => item.id !== id))} />;
  }
  render(<Demo />);
  await user.click(screen.getByRole("button", { name: "1 annotation" }));
  await user.type(screen.getByRole("textbox"), " please");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Make it quieter please");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "1 annotation" }));
  await user.click(screen.getByRole("button", { name: "Remove all annotations" }));
  expect(screen.queryByRole("button", { name: "1 annotation" })).toBeNull();
});

it("supports keyboard access, individual removal, and outside dismissal", async () => {
  const user = userEvent.setup();
  const remove = vi.fn();
  render(<ComposerAnnotations references={[reference, { ...reference, id: "second", label: "a · About" }]} onRemove={remove} />);
  const trigger = screen.getByRole("button", { name: "2 annotations" });
  fireEvent.focus(trigger);
  expect(screen.getByRole("dialog")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "Remove a · About" }));
  expect(remove).toHaveBeenCalledWith("second");
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
