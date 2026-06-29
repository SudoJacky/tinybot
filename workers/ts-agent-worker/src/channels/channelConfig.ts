import type { TinybotConfig } from "../config/configTypes.ts";
import {
  builtinChannelDescriptors,
  type ChannelDescriptor,
} from "./channelRegistry.ts";

export type ChannelDeliveryOptions = {
  sendProgress: boolean;
  sendToolHints: boolean;
  sendMaxRetries: number;
};

export type SelectedChannelConfig = {
  name: string;
  descriptor: ChannelDescriptor;
  config: Record<string, unknown>;
};

const CHANNEL_GLOBAL_KEYS = new Set(["sendProgress", "sendToolHints", "sendMaxRetries"]);

export function selectChannelDeliveryOptions(config: TinybotConfig): ChannelDeliveryOptions {
  return {
    sendProgress: config.channels.sendProgress,
    sendToolHints: config.channels.sendToolHints,
    sendMaxRetries: config.channels.sendMaxRetries,
  };
}

export function selectChannelConfig(
  config: TinybotConfig,
  name: string,
  descriptors: ChannelDescriptor[] = builtinChannelDescriptors(),
): Record<string, unknown> | undefined {
  const descriptor = descriptors.find((item) => item.name === name);
  if (!descriptor) {
    return undefined;
  }
  const section = record(config.channels[name]);
  return {
    ...descriptor.defaultConfig,
    ...normalizeChannelSection(section),
  };
}

export function selectEnabledChannelConfigs(
  config: TinybotConfig,
  descriptors: ChannelDescriptor[] = builtinChannelDescriptors(),
): SelectedChannelConfig[] {
  const selected: SelectedChannelConfig[] = [];
  for (const descriptor of descriptors) {
    const section = record(config.channels[descriptor.name]);
    if (!section || section.enabled !== true) {
      continue;
    }
    selected.push({
      name: descriptor.name,
      descriptor,
      config: {
        ...descriptor.defaultConfig,
        ...normalizeChannelSection(section),
      },
    });
  }
  return selected;
}

export function selectConfiguredChannelNames(config: TinybotConfig): string[] {
  return Object.entries(config.channels)
    .filter(([key, value]) => !CHANNEL_GLOBAL_KEYS.has(key) && record(value)?.enabled === true)
    .map(([key]) => key);
}

function normalizeChannelSection(section: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(section ?? {})) {
    normalized[toCamelKey(key)] = value;
  }
  return normalized;
}

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
