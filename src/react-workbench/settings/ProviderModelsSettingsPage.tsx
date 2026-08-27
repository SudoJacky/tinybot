import { Check, ChevronRight, EllipsisVertical, Image as ImageIcon, Loader2, Plus, RefreshCw, Search, Settings, Trash2 } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  buildCustomProviderPatch,
  buildProviderConfigurePatch,
  buildProviderModelsPatch,
  buildProviderModelsSettings,
  automaticModelCapabilities,
  automaticModelContextWindow,
  type ProviderModelFetchInput,
  type ProviderModelFetchResult,
  type ProviderCardModel,
  type ProviderModelItem,
  type ProviderModelsSettingsData,
} from "../../app-core/settings/providerModelsSettings";
import {
  readDefaultChatModelPreference,
  writeDefaultChatModel,
} from "../../app-core/chat/chatModelPreference";
import type { SettingsStore } from "../services";
import { SettingsChoiceList } from "./SettingsChoiceList";
import { SettingsSaveStatus, type SettingsSaveState } from "./SettingsSaveStatus";
import { SettingsSheet } from "./SettingsSheet";

type ProviderModelsSettingsPageProps = {
  settingsStore: SettingsStore;
};

export function ProviderModelsSettingsPage({ settingsStore }: ProviderModelsSettingsPageProps) {
  const { t } = useTranslation("settings");
  const [data, setData] = useState<ProviderModelsSettingsData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SettingsSaveState>("idle");
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
    setSaveStatus(t("provider.saving"));
    setSaveState("saving");
    try {
      const next = await settingsStore.saveProviderSettings(data.currentConfig, patch);
      setData(next.providers.length ? next : buildProviderModelsSettings(next.currentConfig));
      setSaveStatus(t("provider.saved"));
      setSaveState("saved");
    } catch (error) {
      setSaveStatus(t("provider.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
      setSaveState("error");
      throw error;
    }
  }
  const fetchProviderModels = settingsStore.fetchProviderModels;

  if (loadError) {
    return <p className="react-settings-alert" role="alert">{loadError}</p>;
  }
  if (!data) {
    return <p className="react-empty-state">{t("provider.loading")}</p>;
  }

  return (
    <section className="react-provider-settings" aria-labelledby="provider-models-title">
      <div className="react-provider-settings__header">
        <div>
          <span className="react-settings-eyebrow">{t("provider.eyebrow")}</span>
          <h2 id="provider-models-title">{t("provider.title")}</h2>
          <p>{t("provider.description")}</p>
        </div>
      </div>

      <DefaultLlmPanel data={data} />

      <SettingsSaveStatus message={saveStatus} state={saveState} />

      <section className="react-provider-directory" aria-labelledby="providers-title">
        <header>
          <div>
            <h3 id="providers-title">{t("provider.connections")}</h3>
            <p>{t("provider.connectionsDescription")}</p>
          </div>
          <button
            className="react-provider-add"
            data-press-feedback="true"
            type="button"
            onClick={() => setCreatingProvider(true)}
          >
            <Plus aria-hidden="true" size={16} />
            {t("provider.addProvider")}
          </button>
        </header>
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
      </section>

      {creatingProvider ? (
        <CustomProviderDialog
          existingProviders={data.providers}
          onClose={() => setCreatingProvider(false)}
          onSave={savePatch}
        />
      ) : null}

      {configureProvider ? (
        <ProviderConfigureDialog
          provider={configureProvider}
          onClose={() => setConfigureProvider(null)}
          onSave={savePatch}
        />
      ) : null}

      {modelsProvider ? (
        <ProviderModelsDialog
          fallbackContextWindowTokens={data.fallbackContextWindowTokens}
          provider={modelsProvider}
          onClose={() => setModelsProvider(null)}
          onRefresh={fetchProviderModels
            ? (input) => fetchProviderModels(input)
            : undefined}
          onSave={savePatch}
        />
      ) : null}
    </section>
  );
}

function DefaultLlmPanel({
  data,
}: {
  data: ProviderModelsSettingsData;
}) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const savedPreference = readDefaultChatModelPreference();
  const savedDefaultModel = savedPreference?.modelId ?? "";
  const initialProviderFromDefaultModel = data.providers.find((provider) => (
    provider.id === savedPreference?.providerId
    && provider.models.some((model) => model.enabled && model.id === savedDefaultModel)
  )) ?? data.providers.find((provider) => (
    provider.models.some((model) => model.enabled && model.id === savedDefaultModel)
  ));
  const initialProfileId = initialProviderFromDefaultModel?.profileId ?? data.activeProfileId
    ?? data.providers.find((provider) => provider.configured)?.profileId
    ?? data.providers[0]?.profileId
    ?? "";
  const initialProvider = data.providers.find((provider) => provider.profileId === initialProfileId) ?? data.providers[0];
  const initialModelOptions = initialProvider?.models.filter((model) => model.enabled) ?? [];
  const initialModel = savedDefaultModel
    && initialModelOptions.some((model) => model.id === savedDefaultModel)
    ? savedDefaultModel
    : initialProvider?.defaultModel ?? initialModelOptions[0]?.id ?? "";
  const [profileId, setProfileId] = useState(initialProfileId);
  const selectedProvider = data.providers.find((provider) => provider.profileId === profileId) ?? data.providers[0];
  const modelOptions = useMemo(
    () => selectedProvider?.models.filter((model) => model.enabled) ?? [],
    [selectedProvider],
  );
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
    const nextModels = nextProvider?.models.filter((option) => option.enabled) ?? [];
    if (!nextModels.some((option) => option.id === model)) {
      setModel(nextProvider?.defaultModel ?? nextModels[0]?.id ?? "");
    }
  }, [data.providers, model, profileId]);

  const dirty = model !== savedDefaultModel || profileId !== initialProfileId;
  const canSave = Boolean(profileId && model && dirty && !saving);
  const normalizedModelSearch = modelSearch.trim().toLocaleLowerCase();
  const filteredModelOptions = useMemo(() => normalizedModelSearch
    ? modelOptions.filter((option) => `${option.label} ${option.id}`.toLocaleLowerCase().includes(normalizedModelSearch))
    : modelOptions, [modelOptions, normalizedModelSearch]);

  async function saveDefaultModel(onSaved: () => void) {
    if (!canSave) {
      return;
    }
    setSaving(true);
    try {
      writeDefaultChatModel(model, selectedProvider?.id);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  function closeEditor() {
    setProfileId(initialProfileId);
    setModel(initialModel);
    setModelSearch("");
    setEditing(false);
  }

  return (
    <section className="react-default-llm-panel" aria-labelledby="default-llm-title">
      <header>
        <div>
          <span className="react-settings-eyebrow">{t("provider.recentlyUsed")}</span>
          <h3 id="default-llm-title">{t("provider.defaultModel")}</h3>
          <p>{t("provider.defaultModelDescription")}</p>
        </div>
      </header>
      <div className="react-default-llm-summary">
        {selectedProvider ? <ProviderBrandIcon provider={selectedProvider} /> : null}
        <div className="react-default-llm-summary__model">
          <strong>{model || t("provider.noModel")}</strong>
          <span>{selectedProvider?.label ?? t("provider.noProvider")}</span>
        </div>
        <div className="react-default-llm-summary__provider">
          <span className="react-provider-status" data-status={selectedProvider?.status}>
            <span aria-hidden="true" />
            {selectedProvider ? providerStatusLabel(selectedProvider.status, t) : t("provider.notConfigured")}
          </span>
          <small>{selectedProvider?.useResponsesApi ? t("provider.responsesApi") : t("provider.chatCompletions")}</small>
        </div>
        <span className="react-default-llm-summary__count">
          {selectedProvider?.modelCount ? t("provider.modelCount", { count: selectedProvider.modelCount }) : t("provider.noModels")}
        </span>
        <button
          aria-expanded={editing}
          data-press-feedback="true"
          type="button"
          onClick={() => setEditing((current) => !current)}
        >
          {t("provider.changeModel")}
        </button>
      </div>
      {editing ? (
        <SettingsSheet
          ariaLabel={t("provider.changeModel")}
          closeLabel={t("provider.closeModelSelection")}
          description={t("provider.changeModelDescription")}
          onClose={closeEditor}
          title={t("provider.changeModel")}
          wide
        >
          {(requestClose) => (
            <div className="react-settings-sheet__content react-default-llm-editor">
              <div className="react-default-model-picker">
                <nav className="react-default-model-picker__providers" aria-label={t("provider.providerSelection")}>
                  {data.providers.map((provider) => {
                    const selected = provider.profileId === profileId;
                    return (
                      <button
                        aria-label={t("provider.selectProvider", { name: provider.label })}
                        aria-pressed={selected}
                        data-press-feedback="true"
                        key={provider.profileId}
                        type="button"
                        onClick={() => {
                          setProfileId(provider.profileId);
                          setModel(provider.defaultModel ?? provider.models.find((model) => model.enabled)?.id ?? "");
                          setModelSearch("");
                        }}
                      >
                        <ProviderBrandIcon provider={provider} />
                        <span>
                          <strong>{provider.label}</strong>
                          <small>{provider.modelCount ? t("provider.modelCount", { count: provider.modelCount }) : providerStatusLabel(provider.status, t)}</small>
                        </span>
                        <ChevronRight aria-hidden="true" size={16} />
                      </button>
                    );
                  })}
                </nav>
                <section className="react-default-model-picker__models" aria-label={t("provider.providerModelsLabel", { name: selectedProvider?.label ?? t("provider.noProvider") })}>
                  <header>
                    <h4>{t("provider.modelsFrom", { name: selectedProvider?.label ?? t("provider.noProvider") })}</h4>
                  </header>
                  <label className="react-default-model-picker__search">
                    <Search aria-hidden="true" size={16} />
                    <span className="react-sr-only">{t("provider.searchModels")}</span>
                    <input
                      data-dialog-initial-focus
                      type="search"
                      placeholder={t("provider.searchModels")}
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                    />
                  </label>
                  <p className="react-default-model-picker__count">
                    {normalizedModelSearch
                      ? t("provider.showingModels", { shown: filteredModelOptions.length, total: modelOptions.length })
                      : t("provider.modelCount", { count: modelOptions.length })}
                  </p>
                  <div className="react-default-model-picker__models-list" role="radiogroup" aria-label={t("provider.modelSelection")}>
                    {filteredModelOptions.length ? filteredModelOptions.map((option) => {
                      const selected = option.id === model;
                      return (
                        <button
                          aria-checked={selected}
                          aria-label={t("provider.selectModel", { name: option.label })}
                          data-press-feedback="true"
                          key={option.id}
                          role="radio"
                          type="button"
                          onClick={() => setModel(option.id)}
                        >
                          <strong>{option.label}</strong>
                          <small>{modelSourceLabel(option.source, t)}</small>
                          {selected ? <Check aria-hidden="true" size={16} /> : <span aria-hidden="true" />}
                        </button>
                      );
                    }) : (
                      <p className="react-default-model-picker__empty">
                        {modelOptions.length ? t("provider.noModelMatches") : t("provider.noModelsConfigured")}
                      </p>
                    )}
                  </div>
                </section>
              </div>
              <footer>
                <span>{t("provider.newConversationNote")}</span>
                <div>
                  <button data-press-feedback="true" type="button" onClick={requestClose}>{tCommon("generic.cancel")}</button>
                  <button
                    type="button"
                    aria-label={t("provider.saveDefaultModel")}
                    data-press-feedback="true"
                    disabled={!canSave}
                    onClick={() => saveDefaultModel(requestClose)}
                  >
                    {saving
                      ? <Loader2 aria-hidden="true" className="react-settings-spinner" size={15} />
                      : <Check aria-hidden="true" size={15} />}
                    {saving ? tCommon("generic.saving") : dirty ? tCommon("generic.save") : t("provider.saved")}
                  </button>
                </div>
              </footer>
            </div>
          )}
        </SettingsSheet>
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
  const { t } = useTranslation("settings");
  const primaryAction = provider.status === "available" ? "models" : "configure";

  return (
    <article
      className="react-provider-card"
      aria-label={t("provider.providerLabel", { name: provider.label })}
      data-active={provider.active || undefined}
      data-status={provider.status}
    >
      <div className="react-provider-card__identity">
        <ProviderBrandIcon provider={provider} />
        <div>
          <span>
            <strong>{provider.label}</strong>
            {provider.active ? <small>{t("provider.active")}</small> : null}
          </span>
          <span className="react-provider-card__url" title={provider.baseUrl}>{provider.baseUrl}</span>
        </div>
      </div>
      <div className="react-provider-card__model">
        <small>{t("provider.fallback")}</small>
        <strong>{provider.defaultModel ?? t("provider.notSelected")}</strong>
        <span className="react-provider-card__models">{provider.modelCount ? t("provider.modelCount", { count: provider.modelCount }) : t("provider.noModels")}</span>
      </div>
      <div className="react-provider-card__state">
        <span className="react-provider-status" data-status={provider.status}>
          <span aria-hidden="true" />
          {providerStatusLabel(provider.status, t)}
        </span>
        <small>{provider.apiKeyConfigured ? (provider.useResponsesApi ? t("provider.responsesApi") : t("provider.chatCompletions")) : t("provider.apiKeyMissing")}</small>
      </div>
      <div className="react-provider-card__actions">
        {primaryAction === "models" ? (
          <button data-press-feedback="true" type="button" aria-label={t("provider.manageModels", { name: provider.label })} onClick={onModels}>{t("provider.manage")}</button>
        ) : (
          <button data-press-feedback="true" type="button" aria-label={t("provider.configureProvider", { name: provider.label })} onClick={onConfigure}>{t("provider.setUp")}</button>
        )}
        <button
          className="react-provider-card__more"
          data-press-feedback="true"
          type="button"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          aria-label={t("provider.moreActions", { name: provider.label })}
          onClick={onToggleMenu}
        >
          <EllipsisVertical aria-hidden="true" size={17} />
        </button>
        {menuOpen ? (
          <div className="react-provider-card__menu" role="menu" aria-label={t("provider.providerActions", { name: provider.label })}>
            {primaryAction !== "models" ? (
              <button role="menuitem" type="button" onClick={onModels}>
                <Search aria-hidden="true" size={15} />
                {t("provider.models")}
              </button>
            ) : null}
            {primaryAction !== "configure" ? (
              <button role="menuitem" type="button" onClick={onConfigure}>
                <Settings aria-hidden="true" size={15} />
                {t("provider.configure")}
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
  zai: "/assets/providers/zai.svg",
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

function providerStatusLabel(status: ProviderCardModel["status"], t: TFunction<"settings">): string {
  if (status === "available") {
    return t("provider.status.connected");
  }
  if (status === "not_ready") {
    return t("provider.status.attention");
  }
  return t("provider.status.notConfigured");
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
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [apiBase, setApiBase] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [useResponsesApi, setUseResponsesApi] = useState(provider.useResponsesApi);
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(provider.supportsReasoningEffort !== false);
  const [activate, setActivate] = useState(provider.active);
  const [saving, setSaving] = useState(false);
  const dirty = apiBase.trim() !== provider.baseUrl
    || Boolean(apiKey.trim())
    || useResponsesApi !== provider.useResponsesApi
    || (!provider.builtIn && supportsReasoningEffort !== provider.supportsReasoningEffort)
    || activate !== provider.active;
  const canSave = Boolean(apiBase.trim()) && dirty && !saving;

  async function submit(event: FormEvent<HTMLFormElement>, onSaved: () => void) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave(buildProviderConfigurePatch({
        providerId: provider.id,
        profileId: provider.profileId,
        displayName: provider.label,
        apiBase,
        apiKey,
        useResponsesApi,
        supportsReasoningEffort: provider.builtIn ? undefined : supportsReasoningEffort,
        enabled: true,
        activate: !provider.active && activate,
      }));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSheet
      ariaLabel={t("provider.configureProvider", { name: provider.label })}
      closeLabel={t("provider.configureDialog.close", { name: provider.label })}
      compact
      description={t("provider.configureDialog.description")}
      onClose={onClose}
      title={t("provider.configureProvider", { name: provider.label })}
    >
      {(requestClose) => (
        <form className="react-settings-sheet__content react-provider-config" onSubmit={(event) => submit(event, requestClose)}>
          <section className="react-provider-config__section" aria-labelledby="provider-connection-title">
            <h3 id="provider-connection-title">{t("provider.configureDialog.connection")}</h3>
            <label>
              <span>{t("provider.configureDialog.apiBase")}</span>
              <input
                aria-label={t("provider.configureDialog.apiBase")}
                data-dialog-initial-focus
                value={apiBase}
                onChange={(event) => setApiBase(event.currentTarget.value)}
              />
            </label>
            <label>
              <span className="react-provider-config__field-heading">
                <span>{t("provider.configureDialog.apiKey")}</span>
                <small data-status={provider.apiKeyConfigured ? "configured" : "missing"}>
                  {provider.apiKeyConfigured ? t("provider.configureDialog.configured") : t("provider.configureDialog.notConfigured")}
                </small>
              </span>
              <input
                aria-describedby="provider-api-key-help"
                aria-label={t("provider.configureDialog.apiKey")}
                autoComplete="off"
                placeholder={t("provider.configureDialog.newApiKey")}
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
              <small id="provider-api-key-help" className="react-provider-config__help">
                {provider.apiKeyConfigured
                  ? t("provider.configureDialog.replaceKey")
                  : t("provider.configureDialog.keyIfRequired")}
              </small>
            </label>
          </section>

          <section className="react-provider-config__section" aria-labelledby="provider-profile-title">
            <h3 id="provider-profile-title">{t("provider.configureDialog.profile")}</h3>
            <label className="react-provider-config__switch" data-disabled={provider.active || undefined}>
              <span>
                <strong>{provider.active ? t("provider.configureDialog.activeProfile") : t("provider.configureDialog.setActiveProfile")}</strong>
                <small>{provider.active ? t("provider.configureDialog.activeDescription") : t("provider.configureDialog.setActiveDescription")}</small>
              </span>
              <input
                aria-label={t("provider.configureDialog.setActiveProfile")}
                checked={activate}
                disabled={provider.active}
                type="checkbox"
                onChange={(event) => setActivate(event.currentTarget.checked)}
              />
              <i aria-hidden="true" />
            </label>
          </section>

          <fieldset className="react-provider-config__section react-provider-config__mode">
            <legend>{t("provider.configureDialog.apiMode")}</legend>
            <div>
              {provider.supportsResponsesApi ? (
                <label data-selected={useResponsesApi || undefined}>
                  <input
                    checked={useResponsesApi}
                    name="provider-api-mode"
                    type="radio"
                    value="responses"
                    onChange={() => setUseResponsesApi(true)}
                  />
                  <span>{t("provider.responsesApi")}</span>
                </label>
              ) : null}
              <label data-selected={!useResponsesApi || undefined}>
                <input
                  checked={!useResponsesApi}
                  name="provider-api-mode"
                  type="radio"
                  value="chat_completions"
                  onChange={() => setUseResponsesApi(false)}
                />
                <span>{t("provider.chatCompletions")}</span>
              </label>
            </div>
            <small>{provider.supportsResponsesApi
              ? t("provider.configureDialog.responsesHelp")
              : t("provider.configureDialog.chatOnlyHelp")}</small>
          </fieldset>
          {!provider.builtIn ? (
            <section className="react-provider-config__section" aria-labelledby="provider-features-title">
              <h3 id="provider-features-title">{t("provider.configureDialog.features")}</h3>
              <label className="react-provider-config__switch">
                <span>
                  <strong>{t("provider.reasoningEffort.title")}</strong>
                  <small>{t("provider.reasoningEffort.description")}</small>
                </span>
                <input
                  aria-label={t("provider.reasoningEffort.title")}
                  checked={supportsReasoningEffort}
                  type="checkbox"
                  onChange={(event) => setSupportsReasoningEffort(event.currentTarget.checked)}
                />
                <i aria-hidden="true" />
              </label>
            </section>
          ) : null}
          <footer>
            <button className="react-provider-config__cancel" data-press-feedback="true" type="button" onClick={requestClose}>{tCommon("generic.cancel")}</button>
            <button className="react-provider-config__save" data-press-feedback="true" type="submit" disabled={!canSave}>
              {saving
                ? <Loader2 aria-hidden="true" className="react-settings-spinner" size={15} />
                : <Check aria-hidden="true" size={15} />}
              {saving ? tCommon("generic.saving") : t("config.saveChanges")}
            </button>
          </footer>
        </form>
      )}
    </SettingsSheet>
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
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [providerId, setProviderId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [apiBase, setApiBase] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [supportsModelDiscovery, setSupportsModelDiscovery] = useState(true);
  const [supportsReasoningEffort, setSupportsReasoningEffort] = useState(true);
  const [useResponsesApi, setUseResponsesApi] = useState(false);
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

  async function submit(event: FormEvent<HTMLFormElement>, onSaved: () => void) {
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
        supportsReasoningEffort,
        useResponsesApi,
        activate,
      }));
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSheet
      ariaLabel={t("provider.addProvider")}
      closeLabel={t("provider.addDialog.close")}
      description={t("provider.addDialog.description")}
      onClose={onClose}
      title={t("provider.addProvider")}
    >
      {(requestClose) => (
        <form className="react-settings-sheet__content" onSubmit={(event) => submit(event, requestClose)}>
          <label>
            <span>{t("provider.addDialog.providerId")}</span>
            <input
              aria-label={t("provider.addDialog.providerId")}
              autoComplete="off"
              data-dialog-initial-focus
              placeholder="local-openai"
              value={providerId}
              onChange={(event) => setProviderId(event.currentTarget.value)}
            />
            {providerId && !idValid ? <small>{t("provider.addDialog.invalidId")}</small> : null}
            {duplicate ? <small role="alert">{t("provider.addDialog.duplicateId")}</small> : null}
          </label>
          <label>
            <span>{t("provider.addDialog.displayName")}</span>
            <input aria-label={t("provider.addDialog.displayName")} placeholder="Local OpenAI" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} />
          </label>
          <label>
            <span>{t("provider.addDialog.apiBase")}</span>
            <input aria-label={t("provider.addDialog.customApiBase")} placeholder="http://127.0.0.1:11434/v1" value={apiBase} onChange={(event) => setApiBase(event.currentTarget.value)} />
            {apiBase && !apiBaseValid ? <small role="alert">{t("provider.addDialog.invalidUrl")}</small> : null}
          </label>
          <label>
            <span>{t("provider.addDialog.apiKey")} <small>{t("provider.addDialog.optionalLocal")}</small></span>
            <input aria-label={t("provider.addDialog.customApiKey")} autoComplete="off" type="password" value={apiKey} onChange={(event) => setApiKey(event.currentTarget.value)} />
          </label>
          <label>
            <span>{t("provider.addDialog.fallbackModel")}</span>
            <input aria-label={t("provider.addDialog.fallbackModel")} placeholder="model-id" value={model} onChange={(event) => setModel(event.currentTarget.value)} />
          </label>
          <label className="react-settings-checkbox">
            <input checked={supportsModelDiscovery} type="checkbox" onChange={(event) => setSupportsModelDiscovery(event.currentTarget.checked)} />
            <span>{t("provider.addDialog.discoverModels")}</span>
          </label>
          <label className="react-settings-checkbox">
            <input checked={supportsReasoningEffort} type="checkbox" onChange={(event) => setSupportsReasoningEffort(event.currentTarget.checked)} />
            <span>{t("provider.reasoningEffort.title")} <small>{t("provider.reasoningEffort.description")}</small></span>
          </label>
          <label className="react-settings-checkbox">
            <input checked={useResponsesApi} type="checkbox" onChange={(event) => setUseResponsesApi(event.currentTarget.checked)} />
            <span>{t("provider.addDialog.useResponses")} <small>{t("provider.addDialog.responsesRequirement")}</small></span>
          </label>
          <label className="react-settings-checkbox">
            <input checked={activate} type="checkbox" onChange={(event) => setActivate(event.currentTarget.checked)} />
            <span>{t("provider.addDialog.activate")}</span>
          </label>
          <footer>
            <button data-press-feedback="true" type="button" onClick={requestClose}>{tCommon("generic.cancel")}</button>
            <button data-press-feedback="true" type="submit" disabled={!canSave}>
              {saving
                ? <Loader2 aria-hidden="true" className="react-settings-spinner" size={15} />
                : <Plus aria-hidden="true" size={15} />}
              {saving ? t("provider.addDialog.adding") : t("provider.addProvider")}
            </button>
          </footer>
        </form>
      )}
    </SettingsSheet>
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
  fallbackContextWindowTokens,
  onClose,
  onRefresh,
  onSave,
  provider,
}: {
  fallbackContextWindowTokens: number;
  provider: ProviderCardModel;
  onClose: () => void;
  onRefresh?: (input: ProviderModelFetchInput) => Promise<ProviderModelFetchResult>;
  onSave: (patch: unknown) => Promise<void>;
}) {
  const { t: tCommon } = useTranslation("common");
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [models, setModels] = useState(provider.models);
  const [newModel, setNewModel] = useState("");
  const [defaultModel, setDefaultModel] = useState(
    provider.defaultModel ?? provider.models.find((model) => model.enabled)?.id ?? "",
  );
  const [contextWindowDrafts, setContextWindowDrafts] = useState<Record<string, string>>(() => (
    Object.fromEntries(Object.entries(provider.modelContextWindows).map(([model, tokens]) => [model, String(tokens)]))
  ));
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const filteredModels = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return normalizedQuery
      ? models.filter((model) => model.id.toLowerCase().includes(normalizedQuery) || model.label.toLowerCase().includes(normalizedQuery))
      : models;
  }, [models, query]);
  const invalidContextWindowModels = useMemo(() => new Set(
    Object.entries(contextWindowDrafts)
      .filter(([, value]) => !isPositiveInteger(value))
      .map(([model]) => model),
  ), [contextWindowDrafts]);

  function addModel() {
    const id = newModel.trim();
    if (!id || models.some((model) => model.id === id)) {
      return;
    }
    setModels([...models, {
      id,
      label: id,
      source: "user",
      enabled: true,
      supportsImageInput: automaticModelCapabilities(id).supportsImageInput,
    }]);
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
    setContextWindowDrafts((current) => {
      const next = { ...current };
      delete next[model.id];
      return next;
    });
    if (defaultModel === model.id) {
      setDefaultModel(nextModels.find((item) => item.enabled)?.id ?? "");
    }
  }

  function setModelEnabled(modelId: string, enabled: boolean) {
    const nextModels = models.map((model) => model.id === modelId ? { ...model, enabled } : model);
    setModels(nextModels);
    if (enabled && !defaultModel) {
      setDefaultModel(modelId);
    } else if (!enabled && defaultModel === modelId) {
      setDefaultModel(nextModels.find((model) => model.enabled)?.id ?? "");
    }
  }

  function setModelImageInput(modelId: string, supportsImageInput: boolean) {
    setModels((current) => current.map((model) => (
      model.id === modelId ? { ...model, supportsImageInput } : model
    )));
  }

  function setContextWindowMode(model: string, mode: "auto" | "custom") {
    setContextWindowDrafts((current) => {
      const next = { ...current };
      if (mode === "auto") {
        delete next[model];
      } else if (!Object.prototype.hasOwnProperty.call(next, model)) {
        next[model] = String(automaticModelContextWindow(model, fallbackContextWindowTokens).tokens);
      }
      return next;
    });
  }

  function setContextWindowTokens(model: string, value: string) {
    setContextWindowDrafts((current) => ({ ...current, [model]: value }));
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
          setDefaultModel(currentEnabledModelId(models));
        }
      }
      setRefreshMessage(result.error || result.warning || (result.models.length
        ? t("provider.modelsDialog.fetched", { count: result.models.length })
        : t("provider.modelsDialog.noneReturned")));
    } finally {
      setRefreshing(false);
    }
  }

  const canRefresh = Boolean(onRefresh) && provider.modelDiscovery.status === "openai-compatible";
  const canSave = invalidContextWindowModels.size === 0;

  async function saveModels(onSaved: () => void) {
    await onSave(buildProviderModelsPatch({
      providerId: provider.id,
      profileId: provider.profileId,
      models: models.map((model) => model.id),
      enabledModels: models.filter((model) => model.enabled).map((model) => model.id),
      defaultModel,
      modelContextWindows: Object.entries(contextWindowDrafts).map(([model, value]) => ({
        model,
        contextWindowTokens: Number.parseInt(value, 10),
      })),
      modelCapabilities: models.map((model) => ({
        model: model.id,
        inputModalities: model.supportsImageInput ? ["image"] : [],
      })),
    }));
    onSaved();
  }

  return (
    <SettingsSheet
      ariaLabel={t("provider.providerModelsLabel", { name: provider.label })}
      closeLabel={t("provider.modelsDialog.close")}
      description={t("provider.modelsDialog.description")}
      onClose={onClose}
      title={t("provider.providerModelsLabel", { name: provider.label })}
      wide
    >
      {(requestClose) => (
        <div className="react-settings-sheet__content react-provider-model-manager">
          <div className="react-provider-model-toolbar">
            <label className="react-provider-model-search">
              <span>{t("provider.searchModels")}</span>
              <input
                aria-label={t("provider.searchModels")}
                data-dialog-initial-focus
                placeholder={t("provider.searchModels")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </label>
            <p className="react-provider-model-selection-summary" role="status">
              {t("provider.modelsDialog.enabledCount", {
                count: models.filter((model) => model.enabled).length,
                total: models.length,
              })}
            </p>
          </div>
          <div className="react-provider-model-list">
            <div className="react-provider-model-list__header" aria-hidden="true">
              <span>{t("provider.modelsDialog.enabled")}</span>
              <span>{t("provider.modelsDialog.model")}</span>
              <span>{t("provider.modelsDialog.capabilities")}</span>
              <span>{t("provider.modelsDialog.contextWindow")}</span>
              <span>{t("provider.modelsDialog.backupModel")}</span>
              <span />
            </div>
            {filteredModels.map((model) => (
              <div className="react-provider-model-row" data-enabled={model.enabled} key={model.id}>
                <label
                  className="react-provider-model-enable"
                  title={t("provider.modelsDialog.enableModel", { name: model.id })}
                >
                  <input
                    aria-label={t("provider.modelsDialog.enableModel", { name: model.id })}
                    checked={model.enabled}
                    type="checkbox"
                    onChange={(event) => setModelEnabled(model.id, event.currentTarget.checked)}
                  />
                </label>
                <div className="react-provider-model-identity">
                  <div>
                    <strong>{model.label}</strong>
                    <span className="react-provider-model-source">{modelSourceLabel(model.source, t)}</span>
                  </div>
                  {model.label !== model.id ? <small>{model.id}</small> : null}
                </div>
                <button
                  className="react-provider-model-capability"
                  data-press-feedback="true"
                  type="button"
                  aria-label={t("provider.modelsDialog.imageInputFor", { name: model.id })}
                  aria-pressed={model.supportsImageInput}
                  title={t("provider.modelsDialog.imageInputFor", { name: model.id })}
                  onClick={() => setModelImageInput(model.id, !model.supportsImageInput)}
                >
                  <ImageIcon aria-hidden="true" size={16} strokeWidth={1.8} />
                </button>
                <ModelContextWindowControl
                  fallbackContextWindowTokens={fallbackContextWindowTokens}
                  invalid={invalidContextWindowModels.has(model.id)}
                  model={model.id}
                  onModeChange={(mode) => setContextWindowMode(model.id, mode)}
                  onTokensChange={(value) => setContextWindowTokens(model.id, value)}
                  overrideValue={contextWindowDrafts[model.id]}
                />
                <label
                  className="react-provider-model-default"
                  title={t("provider.modelsDialog.selectBackupModel", { name: model.id })}
                >
                  <input
                    aria-label={t("provider.modelsDialog.selectBackupModel", { name: model.id })}
                    checked={defaultModel === model.id}
                    disabled={!model.enabled}
                    name={`provider-backup-${provider.profileId}`}
                    type="radio"
                    onChange={() => setDefaultModel(model.id)}
                  />
                  <span className="react-provider-model-default__label" aria-hidden="true">
                    {t("provider.modelsDialog.backupModel")}
                  </span>
                </label>
                <button
                  className="react-provider-model-remove"
                  data-press-feedback="true"
                  type="button"
                  aria-label={t("provider.modelsDialog.remove", { name: model.id })}
                  disabled={model.source !== "user"}
                  onClick={() => removeModel(model)}
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              </div>
            ))}
            {!filteredModels.length ? <p className="react-empty-state">{t("provider.modelsDialog.empty")}</p> : null}
          </div>
          <div className="react-provider-model-add">
            <input aria-label={t("provider.modelsDialog.addId")} placeholder="model-id" value={newModel} onChange={(event) => setNewModel(event.currentTarget.value)} />
            <button data-press-feedback="true" type="button" onClick={addModel}>
              <Plus aria-hidden="true" size={15} />
              {t("provider.modelsDialog.add")}
            </button>
          </div>
          {refreshMessage ? <p className="react-settings-save-status" role="status">{refreshMessage}</p> : null}
          <footer>
            <button data-press-feedback="true" type="button" disabled={!canRefresh || refreshing} onClick={refreshModels}>
              <RefreshCw aria-hidden="true" size={15} />
              {provider.modelDiscovery.status === "static" ? t("provider.modelsDialog.staticList") : refreshing ? t("provider.modelsDialog.refreshing") : t("provider.modelsDialog.refresh")}
            </button>
            <button data-press-feedback="true" type="button" onClick={requestClose}>{tCommon("generic.cancel")}</button>
            <button data-press-feedback="true" type="button" disabled={!canSave} onClick={() => saveModels(requestClose)}>{tCommon("generic.save")}</button>
          </footer>
        </div>
      )}
    </SettingsSheet>
  );
}

function ModelContextWindowControl({
  fallbackContextWindowTokens,
  invalid,
  model,
  onModeChange,
  onTokensChange,
  overrideValue,
}: {
  fallbackContextWindowTokens: number;
  invalid: boolean;
  model: string;
  onModeChange: (mode: "auto" | "custom") => void;
  onTokensChange: (value: string) => void;
  overrideValue?: string;
}) {
  const { t } = useTranslation("settings");
  const automatic = automaticModelContextWindow(model, fallbackContextWindowTokens);
  const custom = overrideValue !== undefined;
  return (
    <div className="react-provider-model-context">
      <SettingsChoiceList
        ariaLabel={t("provider.modelsDialog.contextMode", { name: model })}
        label={t("provider.modelsDialog.contextWindow")}
        onChange={(value) => onModeChange(value === "custom" ? "custom" : "auto")}
        options={[
          {
            value: "auto",
            label: automatic.known
              ? t("provider.modelsDialog.contextAuto", { tokens: formatContextWindowTokens(automatic.tokens) })
              : t("provider.modelsDialog.contextDefault", { tokens: formatContextWindowTokens(automatic.tokens) }),
          },
          { value: "custom", label: t("provider.modelsDialog.contextCustom") },
        ]}
        optionsAriaLabel={t("provider.modelsDialog.contextOptions", { name: model })}
        value={custom ? "custom" : "auto"}
      />
      {custom ? (
        <input
          aria-invalid={invalid || undefined}
          aria-label={t("provider.modelsDialog.contextTokens", { name: model })}
          min={1}
          step={1}
          type="number"
          value={overrideValue}
          onChange={(event) => onTokensChange(event.currentTarget.value)}
        />
      ) : null}
      {invalid ? <small role="alert">{t("provider.modelsDialog.contextInvalid")}</small> : null}
    </div>
  );
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) {
    return `${tokens / 1_000_000}M`;
  }
  if (tokens >= 1_000 && tokens % 1_000 === 0) {
    return `${tokens / 1_000}K`;
  }
  return tokens.toLocaleString();
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
    next.push({
      id,
      label: id,
      source: "live",
      enabled: false,
      supportsImageInput: automaticModelCapabilities(id).supportsImageInput,
    });
  }
  return next;
}

function currentEnabledModelId(models: ProviderModelItem[]): string {
  return models.find((model) => model.enabled)?.id ?? "";
}

function modelSourceLabel(source: ProviderModelItem["source"], t: TFunction<"settings">): string {
  if (source === "built-in") {
    return t("provider.modelsDialog.sourceBuiltIn");
  }
  if (source === "live") {
    return t("provider.modelsDialog.sourceLive");
  }
  return t("provider.modelsDialog.sourceUser");
}
