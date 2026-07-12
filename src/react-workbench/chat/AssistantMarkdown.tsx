import { openUrl } from "@tauri-apps/plugin-opener";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
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
  return (
    <a
      {...props}
      data-streamdown="link"
      href={href}
      rel="noreferrer noopener"
      onClick={(event) => {
        event.preventDefault();
        void openAssistantMarkdownUrl(href);
      }}
    >
      {children}
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
