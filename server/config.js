import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from '../skills/jira-stories/scripts/jira.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  port: 4488,
  language: 'en',
  team: null,
  jira: {
    project: '',
    scopeJql: 'sprint in openSprints()',
    maxResults: 30,
    maxTickets: 8,
    writeEnabled: false,
    issueTypes: { story: 'Story', bug: 'Bug', task: 'Task', subtask: 'Sub-task' },
    linkTypes: { blocks: 'Blocks', relates: 'Relates' },
  },
  workspace: { repoDir: null },
  commands: {},
  safety: { forbiddenPattern: 'prod' },
  llm: { model: 'claude-opus-5', maxBudgetUsdPerCall: 3, timeoutMinutes: 15 },
};

export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    const both = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]);
    out[k] = both ? merge(base[k], v) : v;
  }
  return out;
}

const readJson = file => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {});

export function loadConfig(argv = process.argv.slice(2), root = ROOT) {
  loadEnvFile(path.join(root, '.env'));
  let cfg = merge(DEFAULTS, readJson(path.join(root, 'office.config.json')));
  cfg = merge(cfg, readJson(path.join(root, 'office.config.local.json')));
  cfg.mode = argv.includes('--mock') ? 'mock' : 'live';
  const portArg = argv.find(a => a.startsWith('--port='));
  if (portArg) cfg.port = Number(portArg.split('=')[1]);
  if (cfg.workspace.repoDir) cfg.workspace.repoDir = path.resolve(root, cfg.workspace.repoDir);
  for (const [name, c] of Object.entries(cfg.commands)) assertSafeCommand(name, c, cfg.safety.forbiddenPattern);
  return cfg;
}

/** Commands come from the config file only, never from a model. Anything that smells like production is refused. */
export function assertSafeCommand(name, c, forbiddenPattern) {
  if (!c || !Array.isArray(c.argv) || !c.argv.length || !c.argv.every(a => typeof a === 'string')) {
    throw new Error(`commands.${name}.argv must be a non-empty array of strings`);
  }
  if (!forbiddenPattern) return;
  const re = new RegExp(forbiddenPattern, 'i');
  const hay = [...c.argv, ...Object.values(c.env || {}).map(String)];
  const hit = hay.find(v => re.test(v));
  if (hit) throw new Error(`commands.${name} contains "${hit}", which matches safety.forbiddenPattern. The office refuses to run it.`);
}
