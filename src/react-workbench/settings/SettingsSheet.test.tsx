// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useState } from "react";
import { SettingsSheet } from "./SettingsSheet";

afterEach(() => cleanup());

describe("SettingsSheet", () => {
  it("traps focus, closes with Escape, and restores focus to its trigger", async () => {
    const user = userEvent.setup();
    render(<SettingsSheetHarness />);

    const trigger = screen.getByRole("button", { name: "Open settings sheet" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Example settings" });
    const initialInput = screen.getByRole("textbox", { name: "Display name" });
    await waitFor(() => expect(document.activeElement).toBe(initialInput));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close example settings" }));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(dialog.getAttribute("data-state")).toBe("closing"));
    fireEvent.transitionEnd(dialog, { propertyName: "transform" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Example settings" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

function SettingsSheetHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open settings sheet</button>
      {open ? (
        <SettingsSheet
          ariaLabel="Example settings"
          closeLabel="Close example settings"
          description="A short explanation."
          onClose={() => setOpen(false)}
          title="Example"
        >
          {(requestClose) => (
            <div className="react-settings-sheet__content">
              <label>
                Display name
                <input data-settings-sheet-focus />
              </label>
              <button type="button">Secondary action</button>
              <button type="button" onClick={requestClose}>Cancel</button>
            </div>
          )}
        </SettingsSheet>
      ) : null}
    </>
  );
}
