import { Check, ChevronRight, EllipsisVertical, KeyRound, Plus, RefreshCw, Search, Settings, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  buildCustomProviderPatch,
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

type ProviderModelsSettingsPageProps = {
  settingsStore: SettingsStore;
};

export function ProviderModelsSettingsPage({ settingsStore }: ProviderModelsSettingsPageProps) {
  const [data, setData] = useState<ProviderModelsSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [configureProvider, setConfigureProvider] = useState<ProviderCardModel | null>(null);
  const [creatingProvider, setCreatingProvider] = useState(false);
  const [modelsProvider, setModelsProvider] = useState<ProviderCardModel | null>(null);
  const [openProviderMenu, setOpenProviderMenu] = useState<string | null>(null);

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

      <section className="react-provider-directory" aria-labelledby="providers-title">
        <header>
          <h3 id="providers-title">Providers</h3>
          <p>Manage provider connections, credentials, and available models.</p>
        </header>
        <div className="react-provider-directory__columns" aria-hidden="true">
          <span>Provider</span>
          <span>Base URL</span>
          <span>Status</span>
          <span>Models</span>
          <span>Action</span>
        </div>
        <div className="react-provider-grid">
        {data.providers.map((provider) => (
          <ProviderPresetRow
            key={provider.id}
            menuOpen={openProviderMenu === provider.id}
            provider={provider}
            onConfigure={() => {
              setOpenProviderMenu(null);
              setConfigureProvider(provider);
            }}
            onModels={() => {
              setOpenProviderMenu(null);
              setModelsProvider(provider);
            }}
            onToggleMenu={() => setOpenProviderMenu((current) => current === provider.id ? null : provider.id)}
          />
        ))}
        </div>
        <button
          className="react-provider-add"
          type="button"
          onClick={() => setCreatingProvider(true)}
        >
          <Plus aria-hidden="true" size={16} />
          Add provider
        </button>
      </section>

      {creatingProvider ? (
        <CustomProviderDialog
          existingProviders={data.providers}
          onClose={() => setCreatingProvider(false)}
          onSave={async (patch) => {
            await savePatch(patch);
            setCreatingProvider(false);
          }}
        />
      ) : null}

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
  const [modelSearch, setModelSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

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
  const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase();
  const filteredModelOptions = useMemo(() => normalizedModelSearch
    ? modelOptions.filter((option) => `${option.label} ${option.id}`.toLocaleLowerCase().includes(normalizedModelSearch))
    : modelOptions, [modelOptions, normalizedModelSearch]);

  async function saveDefaultLlm() {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await onSave(buildProviderDefaultLlmPatch({ profileId, model }));
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="react-default-llm-panel" aria-labelledby="default-llm-title">
      <header>
        <div>
          <h3 id="default-llm-title">Default model</h3>
          <p>This model is used for new chats and agent turns unless overridden.</p>
        </div>
      </header>
      <div className="react-default-llm-summary">
        {selectedProvider ? <ProviderBrandIcon provider={selectedProvider} /> : null}
        <div className="react-default-llm-summary__provider">
          <strong>{selectedProvider?.label ?? "No provider"}</strong>
          <span className="react-provider-status" data-status={selectedProvider?.status}>
            <span aria-hidden="true" />
            {selectedProvider ? providerStatusLabel(selectedProvider.status) : "Not configured"}
          </span>
        </div>
        <div className="react-default-llm-summary__model">
          <strong>{model || "No model configured"}</strong>
          {model ? <span>Default</span> : null}
        </div>
        <span className="react-default-llm-summary__count">
          {selectedProvider?.modelCount ? `${selectedProvider.modelCount} models` : "No models"}
        </span>
        <button
          aria-expanded={editing}
          type="button"
          onClick={() => setEditing((current) => !current)}
        >
          Change model
        </button>
      </div>
      {editing ? (
        <div className="react-default-llm-editor">
          <div className="react-default-model-picker">
            <nav className="react-default-model-picker__providers" aria-label="Provider selection">
              {data.providers.map((provider) => {
                const selected = provider.profileId === profileId;
                return (
                  <button
                    aria-label={`Select ${provider.label} provider`}
                    aria-pressed={selected}
                    key={provider.profileId}
                    type="button"
                    onClick={() => {
                      setProfileId(provider.profileId);
                      setModel(provider.defaultModel ?? provider.models[0]?.id ?? "");
                      setModelSearch("");
                    }}
                  >
                    <ProviderBrandIcon provider={provider} />
                    <span>
                      <strong>{provider.label}</strong>
                      <small>{provider.modelCount ? `${provider.modelCount} models` : providerStatusLabel(provider.status)}</small>
                    </span>
                    <ChevronRight aria-hidden="true" size={16} />
                  </button>
                );
              })}
            </nav>
            <section className="react-default-model-picker__models" aria-label={`${selectedProvider?.label ?? "Provider"} models`}>
              <header>
                <h4>Models from {selectedProvider?.label ?? "provider"}</h4>
              </header>
              <label className="react-default-model-picker__search">
                <Search aria-hidden="true" size={16} />
                <span className="react-sr-only">Search models</span>
                <input
                  type="search"
                  placeholder="Search models"
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                />
              </label>
              <p className="react-default-model-picker__count">
                {normalizedModelSearch
                  ? `Showing ${filteredModelOptions.length} of ${modelOptions.length}`
                  : `${modelOptions.length} ${modelOptions.length === 1 ? "model" : "models"}`}
              </p>
              <div className="react-default-model-picker__models-list" role="radiogroup" aria-label="Model selection">
                {filteredModelOptions.length ? filteredModelOptions.map((option) => {
                  const selected = option.id === model;
                  return (
                    <button
                      aria-checked={selected}
                      aria-label={`Select ${option.label} model`}
                      key={option.id}
                      role="radio"
                      type="button"
                      onClick={() => setModel(option.id)}
                    >
                      <strong>{option.label}</strong>
                      <small>{modelSourceLabel(option.source)}</small>
                      {selected ? <Check aria-hidden="true" size={16} /> : <span aria-hidden="true" />}
                    </button>
                  );
                }) : (
                  <p className="react-default-model-picker__empty">
                    {modelOptions.length ? "No models match your search." : "No models configured."}
                  </p>
                )}
              </div>
            </section>
          </div>
          <footer>
            <span>{data.revision ? `Config revision ${data.revision}` : "Changes apply to new agent turns."}</span>
            <div>
              <button
                type="button"
                onClick={() => {
                  setProfileId(initialProfileId);
                  setModel(initialModel);
                  setModelSearch("");
                  setEditing(false);
                }}
              >
                Cancel
              </button>
              <button type="button" aria-label="Save default LLM" disabled={!canSave} onClick={saveDefaultLlm}>
                <Check aria-hidden="true" size={15} />
                {saving ? "Saving" : dirty ? "Save" : "Saved"}
              </button>
            </div>
          </footer>
        </div>
      ) : null}
    </section>
  );
}

function ProviderPresetRow({
  menuOpen,
  onConfigure,
  onModels,
  onToggleMenu,
  provider,
}: {
  menuOpen: boolean;
  provider: ProviderCardModel;
  onConfigure: () => void;
  onModels: () => void;
  onToggleMenu: () => void;
}) {
  const primaryAction = provider.status === "available" ? "models" : "configure";

  return (
    <article className="react-provider-card" aria-label={`${provider.label} provider`} data-status={provider.status}>
      <div className="react-provider-card__identity">
        <ProviderBrandIcon provider={provider} />
        <strong>{provider.label}</strong>
      </div>
      <span className="react-provider-card__url" title={provider.baseUrl}>{provider.baseUrl}</span>
      <div className="react-provider-card__state">
        <span className="react-provider-status" data-status={provider.status}>
          <span aria-hidden="true" />
          {providerStatusLabel(provider.status)}
        </span>
        {provider.active ? <small>Active</small> : !provider.apiKeyConfigured ? <small>API key not set</small> : null}
      </div>
      <span className="react-provider-card__models">{provider.modelCount ? `${provider.modelCount} models` : "—"}</span>
      <div className="react-provider-card__actions">
        {primaryAction === "models" ? (
          <button type="button" aria-label={`Manage ${provider.label} models`} onClick={onModels}>Models</button>
        ) : (
          <button type="button" aria-label={`Configure ${provider.label}`} onClick={onConfigure}>Configure</button>
        )}
        <button
          className="react-provider-card__more"
          type="button"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={`More actions for ${provider.label}`}
          onClick={onToggleMenu}
        >
          <EllipsisVertical aria-hidden="true" size={17} />
        </button>
        {menuOpen ? (
          <div className="react-provider-card__menu" role="menu" aria-label={`${provider.label} provider actions`}>
            {primaryAction !== "models" ? (
              <button role="menuitem" type="button" onClick={onModels}>
                <Search aria-hidden="true" size={15} />
                Models
              </button>
            ) : null}
            {primaryAction !== "configure" ? (
              <button role="menuitem" type="button" onClick={onConfigure}>
                <Settings aria-hidden="true" size={15} />
                Configure
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

const PROVIDER_LOGOS: Record<string, string> = {
  dashscope: "/assets/providers/dashscope.svg",
  deepseek: "/assets/providers/deepseek.svg",
  openai: "/assets/providers/openai.svg",
};

function ProviderBrandIcon({ provider }: { provider: ProviderCardModel }) {
  const logo = PROVIDER_LOGOS[provider.id];
  return (
    <span className="react-provider-brand-icon" aria-hidden="true">
      {logo
        ? <img alt="" src={logo} />
        : <span className="react-provider-brand-icon__fallback">{providerInitials(provider.label)}</span>}
    </span>
  );
}

function providerInitials(label: string): string {
  return label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "P";
}

function providerStatusLabel(status: ProviderCardModel["status"]): string {
  if (status === "available") {
    return "Connected";
  }
  if (status === "not_ready") {
    return "Needs attention";
  }
  return "Not configured";
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
      displayName: provider.label,
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

function CustomProviderDialog({
  existingProviders,
  onClose,
  onSave,
}: {
  existingProviders: ProviderCardModel[];
  onClose: () => void;
  onSave: (patch: unknown) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [supportsModelDiscovery, setSupportsModelDiscovery] = useState(true);
  const [activate, setActivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const normalizedProviderId = providerId.trim().toLowerCase();
  const profileId = `${normalizedProviderId}-default`;
  const idValid = /^[a-z0-9][a-z0-9_-]*$/.test(normalizedProviderId);
  const duplicate = existingProviders.some((provider) => (
    provider.id === normalizedProviderId || provider.profileId === profileId
  ));
  const apiBaseValid = isHttpUrl(apiBase);
  const canSave = idValid
    && !duplicate
    && Boolean(displayName.trim())
    && apiBaseValid
    && Boolean(model.trim())
    && !saving;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      await onSave(buildCustomProviderPatch({
        providerId: normalizedProviderId,
        profileId,
        displayName,
        apiBase,
        apiKey,
        model,
        supportsModelDiscovery,
        activate,
      }));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="react-settings-dialog-backdrop">
      <form className="react-settings-dialog" aria-label="Add provider" role="dialog" onSubmit={submit}>
        <header>
          <div>
            <h2>Add provider</h2>
            <p>Configure an OpenAI-compatible endpoint.</p>
          </div>
          <button type="button" aria-label="Close add provider" onClick={onClose}>
            <X aria-hidden="true" size={17} />
          </button>
        </header>
        <label>
          <span>Provider ID</span>
          <input
            aria-label="Provider ID"
            autoComplete="off"
            placeholder="local-openai"
            value={providerId}
            onChange={(event) => setProviderId(event.currentTarget.value)}
          />
          {providerId && !idValid ? <small>Use lowercase letters, numbers, hyphens, or underscores.</small> : null}
          {duplicate ? <small role="alert">This provider ID already exists.</small> : null}
        </label>
        <label>
          <span>Display name</span>
          <input aria-label="Display name" placeholder="Local OpenAI" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
        </label>
        <label>
          <span>API base</span>
          <input aria-label="Custom API base" placeholder="http://127.0.0.1:11434/v1" value={apiBase} onChange={(event) => setApiBase(event.currentTarget.value)} />
          {apiBase && !apiBaseValid ? <small role="alert">Enter a valid HTTP or HTTPS URL.</small> : null}
        </label>
        <label>
          <span>API key <small>Optional for local endpoints</small></span>
          <input aria-label="Custom API key" autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} />
        </label>
        <label>
          <span>Default model</span>
          <input aria-label="Default model" placeholder="model-id" value={model} onChange={(event) => setModel(event.currentTarget.value)} />
        </label>
        <label className="react-settings-checkbox">
          <input checked={supportsModelDiscovery} type="checkbox" onChange={(event) => setSupportsModelDiscovery(event.currentTarget.checked)} />
          <span>Discover models from the /models endpoint</span>
        </label>
        <label className="react-settings-checkbox">
          <input checked={activate} type="checkbox" onChange={(event) => setActivate(event.currentTarget.checked)} />
          <span>Set as active provider and default model</span>
        </label>
        <footer>
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="submit" disabled={!canSave}>
            <Plus aria-hidden="true" size={15} />
            {saving ? "Adding" : "Add provider"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
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
