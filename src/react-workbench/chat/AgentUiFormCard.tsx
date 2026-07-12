import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { AgentUiForm, AgentUiFormField } from "../../app-core/agent-ui/agentUiEvents";

export function AgentUiFormCard({
  form,
  onCancel,
  onSubmit,
}: {
  form: AgentUiForm;
  onCancel: () => void;
  onSubmit: (values: Record<string, unknown>) => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => initialAgentUiFormValues(form));

  useEffect(() => {
    setValues(initialAgentUiFormValues(form));
  }, [form]);

  function updateValue(field: AgentUiFormField, value: unknown) {
    setValues((current) => ({ ...current, [field.name]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(normalizeAgentUiFormValues(form, values));
  }

  return (
    <form aria-label={form.title || form.form_id} className="react-agent-ui-form-card" onSubmit={handleSubmit}>
      <div className="react-agent-ui-form-card__header">
        <h2>{form.title || "Agent form"}</h2>
        {form.description ? <p>{form.description}</p> : null}
      </div>
      <div className="react-agent-ui-form-card__fields">
        {form.fields.map((field) => (
          <AgentUiFormFieldControl
            error={form.errors?.[field.name]}
            field={field}
            key={field.name}
            value={values[field.name]}
            onChange={(value) => updateValue(field, value)}
          />
        ))}
      </div>
      <div className="react-agent-ui-form-card__actions">
        <button disabled={form.submitting} type="submit">{form.submit_label || "Submit"}</button>
        <button disabled={form.submitting} type="button" onClick={onCancel}>{form.cancel_label || "Cancel"}</button>
      </div>
    </form>
  );
}

function AgentUiFormFieldControl({
  error,
  field,
  onChange,
  value,
}: {
  error?: string;
  field: AgentUiFormField;
  onChange: (value: unknown) => void;
  value: unknown;
}) {
  const id = `agent-ui-form-${field.name}`;
  const errorId = `${id}-error`;
  const stringValue = value === undefined || value === null ? "" : String(value);
  return (
    <div className="react-agent-ui-form-field">
      <label htmlFor={id}>{field.label}</label>
      {renderAgentUiFormInput(field, id, stringValue, value, onChange, error ? errorId : undefined)}
      {field.help ? <small>{field.help}</small> : null}
      {error ? <small className="react-agent-ui-form-field__error" id={errorId} role="alert">{error}</small> : null}
    </div>
  );
}

function renderAgentUiFormInput(
  field: AgentUiFormField,
  id: string,
  stringValue: string,
  value: unknown,
  onChange: (value: unknown) => void,
  errorId?: string,
): ReactNode {
  if (field.type === "textarea") {
    return (
      <textarea
        aria-describedby={errorId}
        aria-invalid={Boolean(errorId)}
        id={id}
        maxLength={field.max_length}
        minLength={field.min_length}
        placeholder={field.placeholder}
        required={field.required}
        value={stringValue}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select aria-describedby={errorId} aria-invalid={Boolean(errorId)} id={id} required={field.required} value={stringValue} onChange={(event) => onChange(optionValueFromString(field, event.currentTarget.value))}>
        <option value="">Select...</option>
        {(field.options ?? []).map((option) => (
          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (field.type === "multiselect") {
    const selected = Array.isArray(value) ? value.map(String) : [];
    return (
      <select
        aria-describedby={errorId}
        aria-invalid={Boolean(errorId)}
        id={id}
        multiple
        required={field.required}
        value={selected}
        onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions).map((option) => optionValueFromString(field, option.value)))}
      >
        {(field.options ?? []).map((option) => (
          <option key={String(option.value)} value={String(option.value)}>{option.label}</option>
        ))}
      </select>
    );
  }
  if (field.type === "radio") {
    return (
      <span aria-describedby={errorId} aria-invalid={Boolean(errorId)} className="react-agent-ui-form-field__choices">
        {(field.options ?? []).map((option) => (
          <label key={String(option.value)}>
            <input
              checked={stringValue === String(option.value)}
              name={field.name}
              required={field.required}
              type="radio"
              value={String(option.value)}
              onChange={(event) => onChange(optionValueFromString(field, event.currentTarget.value))}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </span>
    );
  }
  if (field.type === "checkbox") {
    return (
      <input
        aria-describedby={errorId}
        aria-invalid={Boolean(errorId)}
        checked={value === true}
        id={id}
        type="checkbox"
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  }
  return (
    <input
      aria-describedby={errorId}
      aria-invalid={Boolean(errorId)}
      id={id}
      max={field.max}
      maxLength={field.max_length}
      min={field.min}
      minLength={field.min_length}
      pattern={field.pattern}
      placeholder={field.placeholder}
      required={field.required}
      type={inputTypeForAgentUiField(field)}
      value={stringValue}
      onChange={(event) => onChange(field.type === "number" ? event.currentTarget.valueAsNumber : event.currentTarget.value)}
    />
  );
}

function inputTypeForAgentUiField(field: AgentUiFormField): string {
  switch (field.type) {
    case "date":
    case "time":
      return field.type;
    case "datetime":
      return "datetime-local";
    case "number":
      return "number";
    default:
      return "text";
  }
}

function initialAgentUiFormValues(form: AgentUiForm): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of form.fields) {
    if (field.default !== undefined) values[field.name] = field.default;
  }
  return {
    ...values,
    ...(form.initial_values ?? {}),
    ...(form.values ?? {}),
  };
}

function normalizeAgentUiFormValues(form: AgentUiForm, values: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const field of form.fields) {
    const value = values[field.name];
    normalized[field.name] = field.type === "number"
      ? typeof value === "number" && Number.isFinite(value) ? value : undefined
      : value;
  }
  return normalized;
}

function optionValueFromString(field: AgentUiFormField, value: string): string | number | boolean {
  return field.options?.find((option) => String(option.value) === value)?.value ?? value;
}
