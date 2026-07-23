import { describe, expect, test } from "vitest";
import {
  AGENT_UI_EVENT_TYPES,
  AGENT_UI_FORM_STATUSES,
  buildAgentUiFormCancelRequest,
  buildAgentUiFormSubmitRequest,
  createAgentUiEventState,
  normalizeAgentUiEvents,
  reduceAgentUiEventState,
  validateAgentUiFormValues,
} from "./agentUiEvents";

const browserFrameFixture = {
  event: "browser_frame",
  chat_id: "chat-1",
  url: "/browser/frame.png",
  command: "click",
  captured_at: "2026-05-24T00:00:00Z",
};

const formRequestFrame = {
  event: "agent_ui_event",
  chat_id: "chat-1",
  agent_ui_event: {
    event_type: AGENT_UI_EVENT_TYPES["ui.form.requested"],
    chat_id: "chat-1",
    message_id: "msg-form-1",
    turn_id: "run-1",
    payload: {
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      description: "Collect itinerary constraints before planning.",
      submit_label: "Save preferences",
      cancel_label: "Skip",
      correlation: {
        chat_id: "chat-1",
        turn_id: "run-1",
        message_id: "msg-form-1",
      },
      fields: [
        { name: "destination", type: "text", label: "Destination", required: true },
        { name: "nights", type: "number", label: "Nights", min: 1, max: 30, default: 3 },
        {
          name: "style",
          type: "select",
          label: "Travel style",
          options: [
            { label: "Relaxed", value: "relaxed" },
            { label: "Packed", value: "packed" },
          ],
        },
      ],
      initial_values: { destination: "Shanghai", nights: 3 },
    },
  },
};

describe("desktop agent-ui events", () => {
  test("normalizes browser frames using the existing WebUI fixture shape", () => {
    const events = normalizeAgentUiEvents(browserFrameFixture);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: AGENT_UI_EVENT_TYPES["browser.frame.updated"],
      chat_id: "chat-1",
      payload: {
        image_url: "/browser/frame.png",
        command: "click",
        captured_at: "2026-05-24T00:00:00Z",
      },
    });

    const state = createAgentUiEventState();
    reduceAgentUiEventState(state, events[0]);
    expect(state.browserBridgeAvailable).toBe(true);
    expect(state.browserFrame?.image_url).toBe("/browser/frame.png");
  });

  test("reduces native form request, submit, and cancel lifecycle frames", () => {
    const state = createAgentUiEventState();
    for (const event of normalizeAgentUiEvents(formRequestFrame)) {
      reduceAgentUiEventState(state, event);
    }

    const form = state.forms.get("travel-preferences-1");
    expect(form).toMatchObject({
      form_id: "travel-preferences-1",
      title: "Travel preferences",
      status: AGENT_UI_FORM_STATUSES.pending,
      chat_id: "chat-1",
    });
    expect(form?.fields.map((field) => field.name)).toEqual(["destination", "nights", "style"]);
    expect(() => validateAgentUiFormValues(form!, { destination: "Shanghai", nights: 3, style: "relaxed" })).not.toThrow();
    expect(() => validateAgentUiFormValues(form!, { destination: "", nights: 31 })).toThrow(/required|above the maximum/i);

    expect(buildAgentUiFormSubmitRequest(form!, { destination: "Shanghai", nights: 3 })).toEqual({
      values: { destination: "Shanghai", nights: 3 },
      correlation: {
        form_id: "travel-preferences-1",
        chat_id: "chat-1",
        turn_id: "run-1",
        message_id: "msg-form-1",
      },
    });
    expect(buildAgentUiFormCancelRequest(form!)).toEqual({
      correlation: {
        form_id: "travel-preferences-1",
        chat_id: "chat-1",
        turn_id: "run-1",
        message_id: "msg-form-1",
      },
    });

    for (const event of normalizeAgentUiEvents({
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.submitted"],
        chat_id: "chat-1",
        payload: {
          form_id: "travel-preferences-1",
          values: { destination: "Shanghai", nights: 3 },
          correlation: { chat_id: "chat-1", turn_id: "run-1", message_id: "msg-form-1" },
        },
      },
    })) {
      reduceAgentUiEventState(state, event);
    }

    expect(state.forms.get("travel-preferences-1")?.status).toBe(AGENT_UI_FORM_STATUSES.submitted);
    expect(buildAgentUiFormSubmitRequest(state.forms.get("travel-preferences-1")!, {})).toBeNull();
  });

  test("turns unsafe form schemas into error events", () => {
    const events = normalizeAgentUiEvents({
      event: "agent_ui_event",
      chat_id: "chat-1",
      agent_ui_event: {
        event_type: AGENT_UI_EVENT_TYPES["ui.form.requested"],
        chat_id: "chat-1",
        payload: {
          form_id: "unsafe-1",
          title: "Unsafe",
          correlation: { chat_id: "chat-1" },
          fields: [{ name: "details", type: "text", label: "Details", html: "<script>alert(1)</script>" }],
        },
      },
    });

    expect(events[0].event_type).toBe(AGENT_UI_EVENT_TYPES["error.raised"]);
    expect(events[0].payload.message).toMatch(/unsafe key|executable UI payload/i);
  });
});
