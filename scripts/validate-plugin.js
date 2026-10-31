#!/usr/bin/env node
'use strict';
// Static validation of the marketplace + plugin layout (run in CI and by tests).
// Exits 1 and prints problems if anything is malformed.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const problems = [];
const readJson = (rel) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    problems.push(`${rel}: invalid JSON (${e.message})`);
    return null;
  }
};

function frontmatter(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) {
    problems.push(`${rel}: missing YAML frontmatter`);
    return {};
  }
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2];
  }
  return { fm, body: text.slice(m[0].length) };
}

const market = readJson('.claude-plugin/marketplace.json');
if (market) {
  if (!market.name || !market.owner || !Array.isArray(market.plugins)) problems.push('marketplace.json: needs name, owner, plugins[]');
  for (const p of market.plugins || []) {
    if (!p.name || !p.source) problems.push(`marketplace.json: plugin entry needs name and source`);
    else if (!fs.existsSync(path.join(ROOT, p.source, '.claude-plugin', 'plugin.json'))) problems.push(`marketplace.json: ${p.source} has no .claude-plugin/plugin.json`);
  }
}

const PLUGIN = 'plugins/token-plus';
const manifest = readJson(`${PLUGIN}/.claude-plugin/plugin.json`);
if (manifest) {
  if (manifest.name !== 'token-plus') problems.push('plugin.json: name must be token-plus');
  if (!/^\d+\.\d+\.\d+/.test(manifest.version || '')) problems.push('plugin.json: version must be semver');
  if (market && market.plugins[0] && market.plugins[0].version !== manifest.version) problems.push('marketplace.json and plugin.json versions differ');
}

const hooks = readJson(`${PLUGIN}/hooks/hooks.json`);
const KNOWN_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'];
if (hooks) {
  for (const ev of KNOWN_EVENTS) if (!hooks.hooks || !hooks.hooks[ev]) problems.push(`hooks.json: missing ${ev}`);
  for (const [ev, groups] of Object.entries(hooks.hooks || {})) {
    for (const g of groups) {
      for (const h of g.hooks || []) {
        if (h.type !== 'command') problems.push(`hooks.json ${ev}: type must be command`);
        const m = /run\.sh" ([a-z-]+)/.exec(h.command || '');
        if (!m) problems.push(`hooks.json ${ev}: unexpected command ${h.command}`);
        if (!h.command.includes('${CLAUDE_PLUGIN_ROOT}')) problems.push(`hooks.json ${ev}: command must use \${CLAUDE_PLUGIN_ROOT}`);
        if (!(h.timeout > 0 && h.timeout <= 30)) problems.push(`hooks.json ${ev}: timeout should be 1-30s`);
      }
    }
  }
}
for (const f of ['hooks/run.sh', 'scripts/hook.js', 'scripts/cli.js']) {
  if (!fs.existsSync(path.join(ROOT, PLUGIN, f))) problems.push(`${PLUGIN}/${f} missing`);
}

for (const dir of fs.readdirSync(path.join(ROOT, PLUGIN, 'skills'))) {
  const rel = `${PLUGIN}/skills/${dir}/SKILL.md`;
  if (!fs.existsSync(path.join(ROOT, rel))) {
    problems.push(`${rel} missing`);
    continue;
  }
  const { fm } = frontmatter(rel);
  if (fm.name !== dir) problems.push(`${rel}: name must equal directory (${dir})`);
  if (!fm.description || fm.description.length > 400) problems.push(`${rel}: description required, <=400 chars (it is always in context)`);
}
for (const f of fs.readdirSync(path.join(ROOT, PLUGIN, 'agents'))) {
  const rel = `${PLUGIN}/agents/${f}`;
  const { fm, body } = frontmatter(rel);
  if (!fm.name || !fm.description) problems.push(`${rel}: needs name and description`);
  if (fm.model !== 'haiku') problems.push(`${rel}: token-plus agents must use model: haiku`);
  if (!fm.tools) problems.push(`${rel}: restrict tools`);
  if (body && body.split(/\s+/).length > 150) problems.push(`${rel}: spawn prompt should stay under 150 words`);
}
for (const f of fs.readdirSync(path.join(ROOT, PLUGIN, 'commands'))) {
  const rel = `${PLUGIN}/commands/${f}`;
  const { fm } = frontmatter(rel);
  if (!fm.description) problems.push(`${rel}: needs description`);
}

if (problems.length) {
  console.error('Plugin validation failed:\n- ' + problems.join('\n- '));
  process.exit(1);
}
console.log('Plugin layout OK');
