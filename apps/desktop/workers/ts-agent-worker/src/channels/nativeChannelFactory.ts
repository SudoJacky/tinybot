import type { MessageBus } from "../bus/messageBus.ts";
import type { TinybotConfig } from "../config/configTypes.ts";
import {
  selectEnabledChannelConfigs,
  type SelectedChannelConfig,
} from "./channelConfig.ts";
import {
  builtinChannelDescriptors,
  type ChannelDescriptor,
} from "./channelRegistry.ts";
import {
  NativeTextChannel,
  type NativeTextChannelConnector,
} from "./nativeTextChannel.ts";

export type NativeTextChannelConnectorRegistry = Record<string, NativeTextChannelConnector | undefined>;

export type NativeTextChannelFactorySkip = {
  name: string;
  reason: "missing_connector";
};

export type CreateNativeTextChannelAdaptersOptions = {
  config: TinybotConfig;
  bus: MessageBus;
  connectors: NativeTextChannelConnectorRegistry;
  descriptors?: ChannelDescriptor[];
};

export type CreateNativeTextChannelAdaptersResult = {
  adapters: NativeTextChannel[];
  skipped: NativeTextChannelFactorySkip[];
};

export function createNativeTextChannelAdapters(
  options: CreateNativeTextChannelAdaptersOptions,
): CreateNativeTextChannelAdaptersResult {
  const adapters: NativeTextChannel[] = [];
  const skipped: NativeTextChannelFactorySkip[] = [];
  const selected = selectEnabledChannelConfigs(
    options.config,
    options.descriptors ?? builtinChannelDescriptors(),
  );
  for (const channelConfig of selected) {
    const connector = options.connectors[channelConfig.name];
    if (!connector) {
      skipped.push({ name: channelConfig.name, reason: "missing_connector" });
      continue;
    }
    adapters.push(createNativeTextChannelAdapter(channelConfig, options.bus, connector));
  }
  return { adapters, skipped };
}

function createNativeTextChannelAdapter(
  selected: SelectedChannelConfig,
  bus: MessageBus,
  connector: NativeTextChannelConnector,
): NativeTextChannel {
  validateAllowFrom(selected.name, selected.config);
  return new NativeTextChannel({
    name: selected.name,
    displayName: selected.descriptor.displayName,
    config: selected.config,
    bus,
    connector,
  });
}

function validateAllowFrom(name: string, config: Record<string, unknown>): void {
  if (Array.isArray(config.allowFrom) && config.allowFrom.length === 0) {
    throw new Error(
      `Error: "${name}" has empty allowFrom (denies all). Set ["*"] to allow everyone, or add specific user IDs.`,
    );
  }
}
