import { Check, KeyRound, Plus, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  buildProviderConfigurePatch,
  buildProviderDefaultLlmPatch,
  buildProviderModelsPatch,
  buildProviderModelsSettings,
  type ProviderModelFetchInput,
  type ProviderModelFetchResult,
  type ProviderCardModel,
  type ProviderModelItem,
  type ProviderModelsSettingsData,
} from "../../app-core/settings/providerModelsSettings";
import type { SettingsStore } from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";

type ProviderModelsSettingsPageProps = {
  settingsStore: SettingsStore;
};

export function ProviderModelsSettingsPage({ settingsStore }: ProviderModelsSettingsPageProps) {
  const [data, setData] = useState<ProviderModelsSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [configureProvider, setConfigureProvider] = useState<ProviderCardModel | null>(null);
  const [modelsProvider, setModelsProvider] = useState<ProviderCardModel | null>(null);

  useEffect(() => {
    let cancelled = false;
    settingsStore.loadProviderSettings?.()
      .then((snapshot) => {
        if (!cancelled) {
          setData(snapshot);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [settingsStore]);

  async function savePatch(patch: unknown): Promise<void> {
    if (!data || !settingsStore.saveProviderSettings) {
      return;
    }
    setSaveStatus("Saving...");
    const next = await settingsStore.saveProviderSettings(data.currentConfig, patch);
    setData(next.providers.length ? next : buildProviderModelsSettings(next.currentConfig));
    setSaveStatus("Saved");
  }
  const fetchProviderModels = settingsStore.fetchProviderModels;

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data) {
    return <p className="react-empty-state">Loading provider settings...</p>;
  }

  return (
    <section className="react-provider-settings" aria-labelledby="provider-models-title">
      <div className="react-provider-settings__header">
        <div>
          <h2 id="provider-models-title">Provider & Models</h2>
          <p>Built-in providers use backend config profiles for credentials, endpoints, and model defaults.</p>
        </div>
      </div>

      <DefaultLlmPanel
        data={data}
        onSave={(patch) => savePatch(patch)}
      />

      {saveStatus ? <p className="react-settings-save-status" role="status">{saveStatus}</p> : null}

      <div className="react-provider-grid">
        {data.providers.map((provider) => (
          <ProviderPresetCard
            key={provider.id}
            provider={provider}
            onConfigure={() => setConfigureProvider(provider)}
            onModels={() => setModelsProvider(provider)}
          />
        ))}
      </div>

      {configureProvider ? (
        <ProviderConfigureDialog
          provider={configureProvider}
          onClose={() => setConfigureProvider(null)}
          onSave={async (patch) => {
            await savePatch(patch);
            setConfigureProvider(null);
          }}
        />
      ) : null}

      {modelsProvider ? (
        <ProviderModelsDialog
          provider={modelsProvider}
          onClose={() => setModelsProvider(null)}
          onRefresh={fetchProviderModels
            ? (input) => fetchProviderModels(input)
            : undefined}
          onSave={async (patch) => {
            await savePatch(patch);
            setModelsProvider(null);
          }}
        />
      ) : null}
    </section>
  );
}

function DefaultLlmPanel({
  data,
  onSave,
}: {
  data: ProviderModelsSettingsData;
  onSave: (patch: unknown) => Promise<void>;
}) {
  const initialProfileId = data.activeProfileId
    ?? data.providers.find((provider) => provider.configured)?.profileId
    ?? data.providers[0]?.profileId
    ?? "";
  const initialProvider = data.providers.find((provider) => provider.profileId === initialProfileId) ?? data.providers[0];
  const initialModelOptions = initialProvider?.models ?? [];
  const initialModel = data.agentDefaultModel
    && initialModelOptions.some((model) => model.id === data.agentDefaultModel)
    ? data.agentDefaultModel
    : initialProvider?.defaultModel ?? initialModelOptions[0]?.id ?? "";
  const [profileId, setProfileId] = useState(initialProfileId);
  const selectedProvider = data.providers.find((provider) => provider.profileId === profileId) ?? data.providers[0];
  const modelOptions = selectedProvider?.models ?? [];
  const [model, setModel] = useState(initialModel);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProfileId(initialProfileId);
    setModel(initialModel);
  }, [initialModel, initialProfileId]);

  useEffect(() => {
    const nextProvider = data.providers.find((provider) => provider.profileId === profileId) ?? data.providers[0];
    const nextModels = nextProvider?.models ?? [];
    if (!nextModels.some((option) => option.id === model)) {
      setModel(nextProvider?.defaultModel ?? nextModels[0]?.id ?? "");
    }
  }, [data.providers, model, profileId]);

  const dirty = profileId !== (data.activeProfileId ?? "") || model !== (data.agentDefaultModel ?? "");
  const canSave = Boolean(profileId && model && dirty && !saving);

  async function saveDefaultLlm() {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await onSave(buildProviderDefaultLlmPatch({ profileId, model }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="react-default-llm-panel" aria-labelledby="default-llm-title">
      <h3 id="default-llm-title">Default LLM</h3>
      <div className="react-default-llm-panel__controls">
        <SettingsChoiceList
          label="Provider"
          options={data.providers.map((provider) => ({
            value: provider.profileId,
            label: provider.label,
            description: provider.modelCount ? `${provider.modelCount} models` : provider.statusLabel,
          }))}
          value={profileId}
          onChange={(nextProfileId) => {
            const nextProvider = data.providers.find((provider) => provider.profileId === nextProfileId);
            setProfileId(nextProfileId);
            setModel(nextProvider?.defaultModel ?? nextProvider?.models[0]?.id ?? "");
          }}
        />
        <SettingsChoiceList
          label="Model"
          options={modelOptions.length
            ? modelOptions.map((option) => ({
              value: option.id,
              label: option.label,
              description: option.id === option.label ? modelSourceLabel(option.source) : `${option.id} - ${modelSourceLabel(option.source)}`,
            }))
            : [{ value: "", label: "No models configured", disabled: true }]}
          value={model}
          onChange={setModel}
        />
        <button type="button" aria-label="Save default LLM" disabled={!canSave} onClick={saveDefaultLlm}>
          <Check aria-hidden="true" size={15} />
          {saving ? "Saving" : dirty ? "Save" : "Saved"}
        </button>
      </div>
      <p>Set the global default LLM. A specific Agent can still choose a different model from the chat page.</p>
      {data.revision ? <small>Config revision {data.revision}</small> : null}
    </section>
  );
}

function ProviderPresetCard({
  onConfigure,
  onModels,
  provider,
}: {
  provider: ProviderCardModel;
  onConfigure: () => void;
  onModels: () => void;
}) {
  return (
    <article className="react-provider-card" aria-label={`${provider.label} provider`} data-status={provider.status}>
      <div className="react-provider-card__top">
        <div className="react-provider-card__mark" aria-hidden="true">{provider.label.slice(0, 2)}</div>
        <span className="react-provider-card__status">
          <span aria-hidden="true" />
          {provider.statusLabel}
        </span>
      </div>
      <div className="react-provider-card__title">
        <h3>{provider.label}</h3>
        {provider.builtIn ? <span>Built-in</span> : null}
        {provider.active ? <span>Active</span> : null}
      </div>
      <dl className="react-provider-card__facts">
        <div>
          <dt>Base URL</dt>
          <dd>{provider.baseUrl}</dd>
        </div>
        <div>
          <dt>API key</dt>
          <dd>{provider.apiKeyConfigured ? "Configured" : "Not set"}</dd>
        </div>
        <div>
          <dt>Models</dt>
          <dd>{provider.modelCount ? `${provider.modelCount} models` : "No models"}</dd>
        </div>
      </dl>
      <div className="react-provider-card__actions">
        <button type="button" aria-label={`Manage ${provider.label} models`} onClick={onModels}>
          <Search aria-hidden="true" size={15} />
          Models
        </button>
        <button type="button" aria-label={`Configure ${provider.label}`} onClick={onConfigure}>
          <Settings aria-hidden="true" size={15} />
          Configure
        </button>
      </div>
    </article>
  );
}

function ProviderConfigureDialog({
  onClose,
  onSave,
  provider,
}: {
  provider: ProviderCardModel;
  onClose: () => void;
  onSave: (patch: unknown) => Promise<void>;
}) {
  const [apiBase, setApiBase] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    await onSave(buildProviderConfigurePatch({
      providerId: provider.id,
      profileId: provider.profileId,
      apiBase,
      apiKey,
      enabled: true,
      activate,
    }));
  }

  return (
    <div className="react-settings-dialog-backdrop">
      <form className="react-settings-dialog" aria-label={`Configure ${provider.label}`} role="dialog" onSubmit={submit}>
        <header>
          <h2>Configure {provider.label}</h2>
          <button type="button" aria-label={`Close ${provider.label} configuration`} onClick={onClose}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <label>
          <span>API base</span>
          <input aria-label="API base" value={apiBase} onChange={(event) => setApiBase(event.currentTarget.value)} />
        </label>
        <label>
          <span>API key</span>
          <input
            aria-label="API key"
            autoComplete="off"
            placeholder={provider.apiKeyConfigured ? "Leave blank to keep current key" : "Enter API key"}
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
        </label>
        <label className="react-settings-checkbox">
          <input checked={activate} type="checkbox" onChange={(event) => setActivate(event.currentTarget.checked)} />
          <span>Set as active profile</span>
        </label>
        <section className="react-settings-dialog__advanced">
          <h3>Advanced</h3>
          <p>Custom headers and generation parameters are reserved for a later provider config pass.</p>
        </section>
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={saving || !apiBase.trim()}>
            <KeyRound aria-hidden="true" size={15} />
            Save
          </button>
        </footer>
      </form>
    </div>
  );
}

function ProviderModelsDialog({
  onClose,
  onRefresh,
  onSave,
  provider,
}: {
  provider: ProviderCardModel;
  onClose: () => void;
  onRefresh?: (input: ProviderModelFetchInput) => Promise<ProviderModelFetchResult>;
  onSave: (patch: unknown) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [models, setModels] = useState(provider.models);
  const [newModel, setNewModel] = useState("");
  const [defaultModel, setDefaultModel] = useState(provider.defaultModel ?? provider.models[0]?.id ?? "");
  const [setAgentDefault, setSetAgentDefault] = useState(provider.active);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery
      ? models.filter((model) => model.id.toLowerCase().includes(normalizedQuery) || model.label.toLowerCase().includes(normalizedQuery))
      : models;
  }, [models, query]);

  function addModel() {
    const id = newModel.trim();
    if (!id || models.some((model) => model.id === id)) {
      return;
    }
    setModels([...models, { id, label: id, source: "user" }]);
    setNewModel("");
    if (!defaultModel) {
      setDefaultModel(id);
    }
  }

  function removeModel(model: ProviderModelItem) {
    if (model.source !== "user") {
      return;
    }
    const nextModels = models.filter((item) => item.id !== model.id);
    setModels(nextModels);
    if (defaultModel === model.id) {
      setDefaultModel(nextModels[0]?.id ?? "");
    }
  }

  async function refreshModels() {
    if (!onRefresh || provider.modelDiscovery.status !== "openai-compatible") {
      return;
    }
    setRefreshing(true);
    setRefreshMessage(null);
    try {
      const result = await onRefresh({
        providerId: provider.id,
        profileId: provider.profileId,
        apiBase: provider.baseUrl,
        modelDiscovery: provider.modelDiscovery,
      });
      if (!result) {
        return;
      }
      if (result.models.length) {
        setModels((currentModels) => mergeFetchedModels(currentModels, result.models));
        if (!defaultModel) {
          setDefaultModel(result.models[0] ?? "");
        }
      }
      setRefreshMessage(result.error || result.warning || (result.models.length ? `Fetched ${result.models.length} models.` : "No models returned."));
    } finally {
      setRefreshing(false);
    }
  }

  const canRefresh = Boolean(onRefresh) && provider.modelDiscovery.status === "openai-compatible";

  return (
    <div className="react-settings-dialog-backdrop">
      <section className="react-settings-dialog react-settings-dialog--wide" aria-label={`${provider.label} models`} role="dialog">
        <header>
          <h2>{provider.label} models</h2>
          <button type="button" aria-label="Close models" onClick={onClose}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <label>
          <span>Search models</span>
          <input aria-label="Search models" placeholder="Search models" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <div className="react-provider-model-list">
          {filteredModels.map((model) => (
            <div className="react-provider-model-row" key={model.id}>
              <div>
                <strong>{model.label}</strong>
                <small>{model.id}</small>
              </div>
              <span>{modelSourceLabel(model.source)}</span>
              <button type="button" onClick={() => setDefaultModel(model.id)}>
                {defaultModel === model.id ? <Check aria-hidden="true" size={15} /> : null}
                Default
              </button>
              <button
                type="button"
                aria-label={`Remove ${model.id}`}
                disabled={model.source !== "user"}
                onClick={() => removeModel(model)}
              >
                <Trash2 aria-hidden="true" size={15} />
              </button>
            </div>
          ))}
          {!filteredModels.length ? <p className="react-empty-state">No models match the search.</p> : null}
        </div>
        <div className="react-provider-model-add">
          <input aria-label="Add model ID" placeholder="model-id" value={newModel} onChange={(event) => setNewModel(event.currentTarget.value)} />
          <button type="button" onClick={addModel}>
            <Plus aria-hidden="true" size={15} />
            Add model
          </button>
        </div>
        <label className="react-settings-checkbox">
          <input checked={setAgentDefault} type="checkbox" onChange={(event) => setSetAgentDefault(event.currentTarget.checked)} />
          <span>Use selected model as agent default</span>
        </label>
        {refreshMessage ? <p className="react-settings-save-status" role="status">{refreshMessage}</p> : null}
        <footer>
          <button type="button" disabled={!canRefresh || refreshing} onClick={refreshModels}>
            <RefreshCw aria-hidden="true" size={15} />
            {provider.modelDiscovery.status === "static" ? "Static list" : refreshing ? "Refreshing" : "Refresh models"}
          </button>
          <button type="button" onClick={onClose}>Cancel</button>
          <button
            type="button"
            onClick={() => onSave(buildProviderModelsPatch({
              providerId: provider.id,
              profileId: provider.profileId,
              models: models.map((model) => model.id),
              defaultModel,
              setAgentDefault,
            }))}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}

function mergeFetchedModels(currentModels: ProviderModelItem[], fetchedModelIds: string[]): ProviderModelItem[] {
  const next = [...currentModels];
  const seen = new Set(next.map((model) => model.id));
  for (const modelId of fetchedModelIds) {
    const id = modelId.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push({ id, label: id, source: "live" });
  }
  return next;
}

function modelSourceLabel(source: ProviderModelItem["source"]): string {
  if (source === "built-in") {
    return "Built-in";
  }
  if (source === "live") {
    return "Provider fetched";
  }
  return "User added";
}
