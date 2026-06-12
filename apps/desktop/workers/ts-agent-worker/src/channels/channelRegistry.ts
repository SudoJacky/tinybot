export type ChannelCapabilities = {
  streaming: boolean;
  login: boolean;
  media: boolean;
  usage: boolean;
};

export type ChannelDescriptor = {
  name: string;
  displayName: string;
  builtin: boolean;
  defaultConfig: Record<string, unknown>;
  capabilities: ChannelCapabilities;
};

const BUILTIN_CHANNEL_DESCRIPTORS: ChannelDescriptor[] = [
  {
    name: "websocket",
    displayName: "WebSocket",
    builtin: true,
    defaultConfig: {
      enabled: false,
      host: "127.0.0.1",
      port: 18790,
      streaming: true,
      tokenTtlS: 300,
      wsPath: "/ws",
      bootstrapPath: "/webui/bootstrap",
      sessionsPath: "/api/sessions",
      staticDir: "webui",
      allowFrom: ["*"],
    },
    capabilities: { streaming: true, login: false, media: true, usage: true },
  },
  {
    name: "feishu",
    displayName: "Feishu",
    builtin: true,
    defaultConfig: {
      enabled: false,
      appId: "",
      appSecret: "",
      encryptKey: "",
      verificationToken: "",
      allowFrom: [],
      reactEmoji: "THUMBSUP",
      groupPolicy: "mention",
      replyToMessage: false,
      streaming: true,
    },
    capabilities: { streaming: true, login: false, media: true, usage: false },
  },
  {
    name: "dingtalk",
    displayName: "DingTalk",
    builtin: true,
    defaultConfig: {
      enabled: false,
      clientId: "",
      clientSecret: "",
      allowFrom: [],
    },
    capabilities: { streaming: false, login: false, media: true, usage: false },
  },
  {
    name: "weixin",
    displayName: "Weixin",
    builtin: true,
    defaultConfig: {
      enabled: false,
      allowFrom: [],
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      routeTag: null,
      token: "",
      stateDir: "",
    },
    capabilities: { streaming: false, login: true, media: true, usage: false },
  },
];

export function builtinChannelDescriptors(): ChannelDescriptor[] {
  return BUILTIN_CHANNEL_DESCRIPTORS.map(copyDescriptor);
}

export function channelDescriptorByName(name: string): ChannelDescriptor | undefined {
  const descriptor = BUILTIN_CHANNEL_DESCRIPTORS.find((item) => item.name === name);
  return descriptor ? copyDescriptor(descriptor) : undefined;
}

export function selectChannelDefaultConfigs(
  descriptors: ChannelDescriptor[] = builtinChannelDescriptors(),
): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    descriptors.map((descriptor) => [descriptor.name, { ...descriptor.defaultConfig }]),
  );
}

function copyDescriptor(descriptor: ChannelDescriptor): ChannelDescriptor {
  return {
    ...descriptor,
    defaultConfig: { ...descriptor.defaultConfig },
    capabilities: { ...descriptor.capabilities },
  };
}
