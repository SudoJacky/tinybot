import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sessionsCss = readFileSync(new URL("../styles/components/sessions.css", import.meta.url), "utf8");
const utilitiesCss = readFileSync(new URL("../styles/utilities.css", import.meta.url), "utf8");

function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*{(?<body>[^}]*)}`));
  assert.ok(match, `${selector} rule should exist`);
  return match.groups.body;
}

assert.match(ruleBody(sessionsCss, ".session-item"), /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+12px;/);
assert.match(ruleBody(sessionsCss, ".session-item"), /min-height:\s*32px;[\s\S]*padding:\s*1px\s+7px\s+1px\s+8px;/);
assert.match(ruleBody(sessionsCss, ".session-key"), /line-height:\s*28px;/);
assert.match(ruleBody(sessionsCss, ".session-delete"), /position:\s*absolute;[\s\S]*width:\s*20px;[\s\S]*height:\s*20px;[\s\S]*min-height:\s*20px;[\s\S]*padding:\s*0;[\s\S]*transform:\s*translateY\(-50%\);/);
assert.match(ruleBody(sessionsCss, ".session-delete:hover"), /transform:\s*translateY\(-50%\);/);
assert.match(ruleBody(sessionsCss, ".session-delete.confirming"), /height:\s*22px;[\s\S]*min-height:\s*22px;[\s\S]*padding:\s*0\s+8px;[\s\S]*transform:\s*translateY\(-50%\);/);
assert.match(ruleBody(utilitiesCss, ".session-item-wrapper.expanded .session-item"), /padding-top:\s*1px;[\s\S]*padding-bottom:\s*1px;/);
