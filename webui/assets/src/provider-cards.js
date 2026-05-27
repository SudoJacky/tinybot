export function buildProviderCardViewModel(provider) {
  const status = provider.status || "unavailable";
  const credential = provider.credential || {};
  const models = provider.models || {};
  const categories = Array.isArray(provider.categories) ? provider.categories : [];
  const badges = [
    provider.builtIn ? "Built-in" : "",
    provider.local ? "Local" : "",
    provider.custom ? "Custom" : "",
    categories.includes("aggregator") ? "Aggregator" : "",
  ].filter(Boolean);

  return {
    id: provider.id,
    title: provider.displayName || provider.id,
    badges,
    status,
    statusLabel: status.replace(/_/g, " "),
    baseUrlText: provider.baseUrl || "Default endpoint",
    credentialText: credential.state === "missing"
      ? `Missing ${credential.envVars?.[0] || "API key"}`
      : credential.state === "environment"
        ? `Env ${credential.envVars?.[0] || "API key"}`
        : credential.state === "configured"
          ? "API key configured"
          : "No key required",
    modelCount: Number(models.count || 0),
    defaultModel: provider.default?.model || "",
    isDefault: provider.default?.isDefault === true,
    actions: provider.actions || {},
    searchText: [
      provider.id,
      provider.displayName,
      ...(provider.aliases || []),
      status,
      ...categories,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

export function filterProviderCards(providers, { query = "", filter = "all" } = {}) {
  const needle = query.trim().toLowerCase();
  return providers
    .map(buildProviderCardViewModel)
    .filter((card) => {
      if (needle && !card.searchText.includes(needle)) {
        return false;
      }
      if (filter === "all") {
        return true;
      }
      if (filter === "needs_setup") {
        return ["needs_key", "no_models", "unavailable", "unsupported"].includes(card.status);
      }
      if (filter === "local") {
        return card.badges.includes("Local");
      }
      if (filter === "built_in") {
        return card.badges.includes("Built-in");
      }
      if (filter === "custom") {
        return card.badges.includes("Custom");
      }
      return card.status === filter;
    });
}
