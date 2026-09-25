// @vitest-environment happy-dom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { TeamMemberPicker } from "./TeamMemberPicker";

afterEach(cleanup);

function Picker({ disabled = false }: { disabled?: boolean }) {
  const [members, setMembers] = useState([
    { id: "research", displayName: "Researcher", instructions: "Find evidence" },
    { id: "analysis", displayName: "Analyst", instructions: "Compare findings" },
    { id: "editor", displayName: "Editor", instructions: "Write report" },
  ]);
  const [selectedIds, setSelectedIds] = useState(members.map(member => member.id));
  return <TeamMemberPicker members={members} selectedIds={selectedIds} disabled={disabled}
    onSelectionChange={setSelectedIds} onChange={setMembers} />;
}

it("searches with the keyboard, preserves selection, and restores trigger focus on Escape", async () => {
  const user = userEvent.setup();
  render(<Picker />);
  await user.tab();
  await user.keyboard("{Enter}");
  const search = screen.getByRole("searchbox", { name: "Search members…" });
  expect(search).toHaveFocus();
  await user.type(search, "analyst");
  expect(screen.getAllByRole("checkbox")).toHaveLength(1);
  await user.tab();
  await user.keyboard(" ");
  expect(screen.getByRole("checkbox", { name: "Analyst" })).not.toBeChecked();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Configure members · 2" })).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.getAllByRole("checkbox")).toHaveLength(3);
  expect(screen.getByRole("checkbox", { name: "Analyst" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Editor" }));
  expect(screen.getByRole("checkbox", { name: "Researcher" })).toBeDisabled();
  await user.type(screen.getByRole("searchbox"), "absent");
  expect(screen.getByText("No matching members.")).toBeVisible();
});

it("keeps a filtered editor mounted through renaming and retains edits after removing and reselecting", async () => {
  const user = userEvent.setup();
  const { rerender } = render(<Picker />);
  await user.click(screen.getByRole("button", { name: "Configure members · 3" }));
  await user.type(screen.getByRole("searchbox"), "analyst");
  await user.click(screen.getByRole("button", { name: "Edit Analyst" }));
  expect(screen.getByRole("combobox", { name: "Tools" })).toHaveValue("execution");
  await user.selectOptions(screen.getByRole("combobox", { name: "Tools" }), "review");
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Strategist");
  await user.clear(screen.getByRole("textbox", { name: "Instructions" }));
  await user.type(screen.getByRole("textbox", { name: "Instructions" }), "Evaluate options");
  await user.click(screen.getByRole("checkbox", { name: "Strategist" }));
  await user.click(screen.getByRole("checkbox", { name: "Strategist" }));
  expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("Evaluate options");
  expect(screen.getByRole("combobox", { name: "Tools" })).toHaveValue("review");
  await user.click(document.body);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Configure members · 3" }));
  rerender(<Picker disabled />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Configure members · 3" })).toBeDisabled();
});
