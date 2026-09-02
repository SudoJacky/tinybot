// @vitest-environment happy-dom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../i18n";
import { ProjectGroupDialog } from "./ProjectGroupDialog";

afterEach(cleanup);

describe("ProjectGroupDialog", () => {
  it("selects an available workspace before creating a project group", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => undefined);

    render(
      <ProjectGroupDialog
        availableWorkspaces={[{
          addedAtMs: 1,
          exists: true,
          name: "payments",
          path: "D:\\Services\\payments",
          updatedAtMs: 1,
        }]}
        onChooseWorkspace={async () => undefined}
        onClose={() => undefined}
        onSave={onSave}
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Create project group" });
    await user.type(within(dialog).getByRole("textbox", { name: "Project name" }), "Commerce");
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(within(dialog).getByRole("button", { name: "Save project" }));

    expect(onSave).toHaveBeenCalledWith({
      name: "Commerce",
      workspaceIds: ["D:\\Services\\payments"],
    });
  });
});
