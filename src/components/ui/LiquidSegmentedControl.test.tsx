// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { LiquidSegmentedControl } from "./LiquidSegmentedControl";

afterEach(cleanup);
const options = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium", disabled: true },
  { value: "large", label: "Large" },
];

test("uses native arrow keys, skips disabled choices and keeps groups independent", async () => {
  const user = userEvent.setup();
  const submit = vi.fn((event) => event.preventDefault());
  function Choices({ name }: { name: string }) {
    const [value, setValue] = useState("small");
    return <LiquidSegmentedControl aria-label={name} options={options} value={value} onChange={setValue} />;
  }
  render(<form onSubmit={submit}><Choices name="First" /><Choices name="Second" /></form>);
  const first = within(screen.getByRole("radiogroup", { name: "First" }));
  const second = within(screen.getByRole("radiogroup", { name: "Second" }));
  await user.tab();
  expect(document.activeElement).toBe(first.getByRole("radio", { name: "Small" }));
  await user.keyboard("{ArrowRight}");
  expect(first.getByRole<HTMLInputElement>("radio", { name: "Large" }).checked).toBe(true);
  expect(second.getByRole<HTMLInputElement>("radio", { name: "Small" }).checked).toBe(true);
  await user.tab();
  expect(document.activeElement).toBe(second.getByRole("radio", { name: "Small" }));
  await user.click(first.getByText("Medium"));
  expect(first.getByRole<HTMLInputElement>("radio", { name: "Large" }).checked).toBe(true);
  expect(submit).not.toHaveBeenCalled();
});

test("waits for the controlled value and stays inert when disabled", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  const view = render(<LiquidSegmentedControl aria-label="Size" value="small" options={options} onChange={onChange} />);
  await user.click(screen.getByText("Large"));
  expect(onChange).toHaveBeenCalledExactlyOnceWith("large");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Small" }).checked).toBe(true);
  view.rerender(<LiquidSegmentedControl aria-label="Size" value="large" options={options} onChange={onChange} disabled />);
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "Large" }).checked).toBe(true);
  await user.click(screen.getByText("Small"));
  expect(onChange).toHaveBeenCalledTimes(1);
});
