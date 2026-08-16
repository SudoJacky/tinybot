// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { useModalDialog } from "./useModalDialog";

afterEach(() => {
  cleanup();
  document.body.style.overflow = "";
});

describe("useModalDialog", () => {
  it("owns focus, keyboard navigation, body scroll locking, and focus restoration", async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);

    const trigger = screen.getByRole("button", { name: "Open dialog" });
    await user.click(trigger);
    const initialInput = screen.getByRole("textbox", { name: "Name" });
    await waitFor(() => expect(document.activeElement).toBe(initialInput));
    expect(document.body.style.overflow).toBe("hidden");

    const lastButton = screen.getByRole("button", { name: "Last action" });
    lastButton.focus();
    await user.tab();
    expect(document.activeElement).toBe(initialInput);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(document.body.style.overflow).toBe("");
  });

  it("blocks Escape and backdrop closing while closing is disabled", async () => {
    const onClose = vi.fn();
    render(<ControlledDialog closeEnabled={false} onClose={onClose} />);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" })));
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerDown(screen.getByTestId("backdrop"));

    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the page locked and closes only the topmost nested dialog", async () => {
    const user = userEvent.setup();
    render(<NestedDialogHarness />);

    await user.click(screen.getByRole("button", { name: "Open first dialog" }));
    await user.click(await screen.findByRole("button", { name: "Open second dialog" }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(document.body.style.overflow).toBe("hidden");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
      {open ? <ControlledDialog closeEnabled onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function ControlledDialog({
  closeEnabled,
  onClose,
}: {
  closeEnabled: boolean;
  onClose: () => void;
}) {
  const { dialogRef, onBackdropPointerDown } = useModalDialog<HTMLDivElement>({
    closeEnabled,
    onClose,
  });
  return (
    <div data-testid="backdrop" onPointerDown={onBackdropPointerDown}>
      <div aria-label="Example" aria-modal="true" ref={dialogRef} role="dialog">
        <input aria-label="Name" data-dialog-initial-focus />
        <button type="button">Last action</button>
      </div>
    </div>
  );
}

function NestedDialogHarness() {
  const [firstOpen, setFirstOpen] = useState(false);
  const [secondOpen, setSecondOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setFirstOpen(true)}>Open first dialog</button>
      {firstOpen ? (
        <NestedDialog label="First" onClose={() => setFirstOpen(false)}>
          <button type="button" onClick={() => setSecondOpen(true)}>Open second dialog</button>
        </NestedDialog>
      ) : null}
      {secondOpen ? (
        <NestedDialog label="Second" onClose={() => setSecondOpen(false)}>
          <button type="button">Second action</button>
        </NestedDialog>
      ) : null}
    </>
  );
}

function NestedDialog({
  children,
  label,
  onClose,
}: {
  children: ReactNode;
  label: string;
  onClose: () => void;
}) {
  const { dialogRef } = useModalDialog<HTMLDivElement>({ onClose });
  return (
    <div aria-label={label} aria-modal="true" ref={dialogRef} role="dialog">
      {children}
    </div>
  );
}
