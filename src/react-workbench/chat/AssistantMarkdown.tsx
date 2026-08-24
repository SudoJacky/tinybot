import { openUrl } from "@tauri-apps/plugin-opener";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { Globe2, Mail } from "lucide-react";
import { memo, type ComponentProps } from "react";
import {
  Streamdown,
  type Components,
  type ControlsConfig,
  type LinkSafetyConfig,
  type PluginConfig,
  type UrlTransform,
} from "streamdown";
import "streamdown/styles.css";

const ASSISTANT_MARKDOWN_CONTROLS = {
  code: { copy: true, download: false },
  mermaid: false,
  table: false,
} satisfies ControlsConfig;

const ASSISTANT_MARKDOWN_LINK_SAFETY = {
  enabled: false,
} satisfies LinkSafetyConfig;

const ASSISTANT_MARKDOWN_PLUGINS = {
  cjk,
  code,
} satisfies PluginConfig;

const DISALLOWED_ASSISTANT_ELEMENTS = ["img"];
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

type AssistantMarkdownLinkKind = "email" | "github" | "web";

const ASSISTANT_MARKDOWN_LINK_ICON_PROPS = {
  "aria-hidden": true,
  className: "react-message-markdown__link-icon",
  height: 14,
  width: 14,
} as const;

function assistantMarkdownLinkKind(href: string): AssistantMarkdownLinkKind {
  const url = new URL(href);
  if (url.protocol === "mailto:") {
    return "email";
  }
  const hostname = url.hostname.toLowerCase();
  return hostname === "github.com" || hostname.endsWith(".github.com") ? "github" : "web";
}

function AssistantMarkdownLinkIcon({ kind }: { kind: AssistantMarkdownLinkKind }) {
  if (kind === "github") {
    return (
      <svg {...ASSISTANT_MARKDOWN_LINK_ICON_PROPS} data-link-icon="github" focusable="false" viewBox="0 0 16 16">
        <path fill="currentColor" d="M8 0a8.16 8.16 0 0 0-2.53 15.84c.4.08.55-.18.55-.39 0-.19-.01-.83-.01-1.51-2.23.49-2.7-.96-2.7-.96-.36-.94-.89-1.19-.89-1.19-.73-.5.05-.49.05-.49.8.06 1.22.83 1.22.83.71 1.23 1.87.88 2.33.67.07-.52.28-.88.51-1.08-1.78-.21-3.65-.91-3.65-4.02 0-.89.31-1.61.82-2.18-.08-.2-.36-1.03.08-2.15 0 0 .67-.22 2.2.83A7.48 7.48 0 0 1 8 3.98c.68 0 1.36.09 2 .27 1.53-1.05 2.2-.83 2.2-.83.44 1.12.16 1.95.08 2.15.51.57.82 1.29.82 2.18 0 3.12-1.87 3.8-3.66 4.01.29.25.54.74.54 1.5 0 1.08-.01 1.95-.01 2.22 0 .22.15.47.55.39A8.16 8.16 0 0 0 8 0Z" />
      </svg>
    );
  }
  const LinkIcon = kind === "email" ? Mail : Globe2;
  return <LinkIcon {...ASSISTANT_MARKDOWN_LINK_ICON_PROPS} data-link-icon={kind} />;
}

const transformAssistantMarkdownUrl: UrlTransform = (url, key) => {
  if (key === "src") {
    return null;
  }
  try {
    return ALLOWED_EXTERNAL_PROTOCOLS.has(new URL(url).protocol) ? url : null;
  } catch {
    return null;
  }
};

async function openAssistantMarkdownUrl(url: string): Promise<void> {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("[Tinybot chat] assistant link open failed", { error, url });
  }
}

function AssistantMarkdownLink({ children, href, node: _node, onClick: _onClick, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  if (!href) {
    return <span>{children}</span>;
  }
  const linkKind = assistantMarkdownLinkKind(href);
  return (
    <a
      {...props}
      data-link-kind={linkKind}
      data-streamdown="link"
      href={href}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        void openAssistantMarkdownUrl(href);
      }}
    >
      <AssistantMarkdownLinkIcon kind={linkKind} />
      <span className="react-message-markdown__link-label">{children}</span>
    </a>
  );
}

function AssistantMarkdownStrong({ node: _node, ...props }: ComponentProps<"strong"> & { node?: unknown }) {
  return <strong data-streamdown="strong" {...props} />;
}

const ASSISTANT_MARKDOWN_COMPONENTS = {
  a: AssistantMarkdownLink,
  strong: AssistantMarkdownStrong,
} satisfies Components;

export const AssistantMarkdown = memo(function AssistantMarkdown({
  streaming,
  text,
}: {
  streaming: boolean;
  text: string;
}) {
  if (!text.trim()) {
    return null;
  }
  return (
    <Streamdown
      animated={false}
      className="react-message-markdown"
      components={ASSISTANT_MARKDOWN_COMPONENTS}
      controls={ASSISTANT_MARKDOWN_CONTROLS}
      disallowedElements={DISALLOWED_ASSISTANT_ELEMENTS}
      isAnimating={false}
      key={streaming ? "streaming" : "complete"}
      lineNumbers={false}
      linkSafety={ASSISTANT_MARKDOWN_LINK_SAFETY}
      mode="streaming"
      plugins={ASSISTANT_MARKDOWN_PLUGINS}
      skipHtml
      unwrapDisallowed
      urlTransform={transformAssistantMarkdownUrl}
    >
      {text}
    </Streamdown>
  );
});
