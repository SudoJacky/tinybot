import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = { bash, css, javascript, json, markdown, powershell, python, rust, typescript, xml, yaml };
Object.entries(languages).forEach(([name, language]) => hljs.registerLanguage(name, language));

self.onmessage = (event: MessageEvent<{ content: string; language?: string }>) => {
  const { content, language } = event.data;
  const lines = content.split("\n");
  self.postMessage({
    lines: language && hljs.getLanguage(language)
      ? lines.map((line) => hljs.highlight(line, { ignoreIllegals: true, language }).value)
      : lines.map(escapeHtml),
  });
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}
