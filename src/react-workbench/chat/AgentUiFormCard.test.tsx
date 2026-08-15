// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentUiForm } from "../../app-core/agent-ui/agentUiEvents";
import { AgentUiFormCard } from "./AgentUiFormCard";

afterEach(cleanup);

describe("AgentUiFormCard", () => {
  it("preserves the local draft when the same canonical form is projected again", async () => {
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      correlation: {},
      fields: [{ name: "destination", type: "text", label: "Destination", required: true }],
      values: { destination: "Shanghai" },
      status: "pending",
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    const user = userEvent.setup();
    const view = render(<AgentUiFormCard form={form} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const destination = screen.getByLabelText("Destination") as HTMLInputElement;

    await user.clear(destination);
    await user.type(destination, "Singapore");
    view.rerender(<AgentUiFormCard form={{ ...form }} onCancel={vi.fn()} onSubmit={vi.fn()} />);

    expect(destination.value).toBe("Singapore");
  });

  it("replaces the local draft when a newer canonical form revision arrives", async () => {
    const form: AgentUiForm = {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      correlation: {},
      fields: [{ name: "destination", type: "text", label: "Destination", required: true }],
      values: { destination: "Shanghai" },
      status: "pending",
      updated_at: "2026-08-15T00:00:00.000Z",
    };
    const user = userEvent.setup();
    const view = render(<AgentUiFormCard form={form} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    const destination = screen.getByLabelText("Destination") as HTMLInputElement;

    await user.clear(destination);
    await user.type(destination, "Singapore");
    view.rerender(
      <AgentUiFormCard
        form={{
          ...form,
          values: { destination: "Tokyo" },
          updated_at: "2026-08-15T00:01:00.000Z",
        }}
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(destination.value).toBe("Tokyo");
  });
});
