// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { LiquidToggle } from "./LiquidToggle";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

test("supports label clicks and native keyboard operation without submitting a form", async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  render(<form onSubmit={submit}><label>Enable tools<LiquidToggle role="switch" /></label></form>);
  const toggle = screen.getByRole<HTMLInputElement>("switch", { name: "Enable tools" });
  await user.click(screen.getByText("Enable tools"));
  expect(toggle.checked).toBe(true);
  toggle.focus();
  await user.keyboard(" ");
  expect(toggle.checked).toBe(false);
  await user.keyboard("{Enter}");
  expect(toggle.checked).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});

test("waits for controlled state and preserves the confirmed value when a save is rejected", async () => {
  const user = userEvent.setup();
  const changes: boolean[] = [];
  const onChange = (event: React.ChangeEvent<HTMLInputElement>) => changes.push(event.currentTarget.checked);
  const view = render(<LiquidToggle aria-label="Tools" checked={false} onChange={onChange} />);
  const toggle = screen.getByRole<HTMLInputElement>("checkbox", { name: "Tools" });
  await user.click(toggle);
  expect(changes).toEqual([true]);
  expect(toggle.checked).toBe(false);
  expect(toggle.parentElement?.dataset.checked).toBe("false");
  view.rerender(<LiquidToggle aria-label="Tools" checked disabled onChange={onChange} />);
  expect(toggle.checked).toBe(true);
  await user.click(toggle);
  expect(changes).toEqual([true]);
  view.rerender(<LiquidToggle aria-label="Tools" checked={false} onChange={onChange} />);
  expect(toggle.checked).toBe(false);
});

test("keeps disabled switches inert even when their surrounding label is clicked", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<label>Unavailable<LiquidToggle defaultChecked disabled onChange={onChange} /></label>);
  await user.click(screen.getByText("Unavailable"));
  expect(screen.getByRole<HTMLInputElement>("checkbox").checked).toBe(true);
  expect(onChange).not.toHaveBeenCalled();
});

test("settles an interrupted animation when reduced motion is enabled and removes its listener", async () => {
  const preference = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(window, "matchMedia").mockReturnValue(preference as MediaQueryList);
  const remove = vi.spyOn(preference, "removeEventListener");
  const view = render(<LiquidToggle aria-label="Tools" speed={0} />);
  fireEvent.click(screen.getByRole("checkbox"), { detail: 1 });
  act(() => { preference.matches = true; preference.dispatchEvent(new Event("change")); });
  const thumb = view.container.querySelector<HTMLElement>(".liquid-toggle__thumb")!;
  await waitFor(() => expect(thumb.style.transform).toBe("translateX(16px)"));
  fireEvent.click(screen.getByRole("checkbox"), { detail: 1 });
  await waitFor(() => expect(thumb.style.transform).toBe("none"));
  view.unmount();
  expect(remove).toHaveBeenCalledWith("change", expect.any(Function));
});
