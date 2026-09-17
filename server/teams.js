import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { STATIONS } from './hub.js';

/**
 * A crew is a JSON file: who the agents are, how the morning briefing is built, and the workflow for one ticket.
 * Crews are data. Nothing in a crew file is executed as code, and the engine asks the human before every
 * Jira write and every command, so a crew (hand-written or generated) cannot skip an approval.
 */
const STEP_TYPES = ['think', 'parallel', 'command', 'gate', 'jira', 'branch', 'end'];
const JIRA_ACTIONS = ['comment', 'create', 'update', 'transition', 'link'];
const TOOLS = ['none', 'read', 'write'];
const OPS = ['truthy', 'falsy', 'eq', 'ne', 'gt', 'lt'];
const TONES = ['ok', 'err', 'muted'];
const PALETTE = [
  { shirt: '#3a66c9', hair: '#4a2c1f', skin: '#f1c7a0' }, { shirt: '#23804a', hair: '#1e1b2e', skin: '#c98e62' },
  { shirt: '#8a5cc2', hair: '#d8a03a', skin: '#f3d2b3' }, { shirt: '#d0492f', hair: '#6b2a1d', skin: '#8d5a3b' },
  { shirt: '#c98a1b', hair: '#2b2340', skin: '#e0ac7e' }, { shirt: '#1f8a8a', hair: '#7a4a2a', skin: '#f6d9c0' },
];
const HEX = /^#[0-9a-fA-F]{6}$/;
export const RESERVED = ['ticket', 'project', 'scope', 'language', 'issueTypes', 'linkTypes', 'changes', 'today'];
const SLUG = /^[a-z][a-z0-9-]{1,40}$/;

export const flatten = steps => steps.flatMap(s => (s.type === 'parallel' ? [s, ...(s.branches || []).flat()] : [s]));

export function validateTeam(team) {
  const errors = [];
  const err = m => errors.push(m);
  if (!team || typeof team !== 'object') return ['crew must be a JSON object'];
  if (!SLUG.test(team.id || '')) err('id must be a lowercase slug like "qa" or "custom-data-analyst"');
  for (const k of ['name', 'role', 'description']) if (typeof team[k] !== 'string' || !team[k].trim()) err(`${k} is required`);
  for (const [k, v] of Object.entries(team.stationLabels || {})) if (!STATIONS.includes(k) || typeof v !== 'string') err(`stationLabels.${k} is not a station (${STATIONS.join(', ')})`);

  const agents = Array.isArray(team.agents) ? team.agents : [];
  if (agents.length < 1 || agents.length > 6) err('agents must list 1 to 6 agents');
  const agentIds = new Set();
  for (const a of agents) {
    if (!SLUG.test(a?.id || '')) err(`agent id "${a?.id}" must be a lowercase slug`);
    if (agentIds.has(a?.id) || a?.id === 'you') err(`agent id "${a?.id}" is duplicated or reserved`);
    agentIds.add(a?.id);
    if (typeof a?.name !== 'string' || !a.name || a.name.length > 8) err(`agent ${a?.id}: name is required, 8 characters at most`);
    if (typeof a?.title !== 'string' || !a.title) err(`agent ${a?.id}: title is required`);
  }

  const b = team.briefing;
  if (!b || typeof b !== 'object') err('briefing is required');
  else {
    if (!agentIds.has(b.agent)) err('briefing.agent must be one of the agents');
    if (typeof b.jql !== 'string' || !b.jql.trim()) err('briefing.jql is required');
    if (typeof b.rankPrompt !== 'string' || !b.rankPrompt.trim()) err('briefing.rankPrompt is required');
  }

  const top = Array.isArray(team.workflow) ? team.workflow : [];
  if (!top.length) err('workflow must have steps');
  const all = flatten(top);
  if (all.length > 30) err('workflow has more than 30 steps');
  const ids = new Set();
  for (const s of all) {
    if (!SLUG.test(s?.id || '')) err(`step id "${s?.id}" must be a lowercase slug`);
    if (ids.has(s?.id)) err(`step id "${s?.id}" is duplicated`);
    ids.add(s?.id);
  }
  const target = (s, g, where) => { if (g != null && g !== 'end' && !top.some(x => x.id === g)) err(`step ${s.id}: ${where} "${g}" is not a top-level step id`); };
  const actions = (s, list, where) => {
    const seen = new Set(['approve', 'skip']);
    for (const a of list || []) {
      if (!SLUG.test(a?.id || '') || seen.has(a.id) && where === 'extraActions') err(`step ${s.id}: ${where} id "${a?.id}" is invalid or reserved`);
      if (typeof a?.label !== 'string' || !a.label) err(`step ${s.id}: every action needs a label`);
      if (a?.result && !TONES.includes(a.result.tone)) err(`step ${s.id}: action result.tone must be ${TONES.join(', ')}`);
      target(s, a?.goto, `action ${a?.id} goto`);
    }
  };

  for (const s of all) {
    if (!STEP_TYPES.includes(s.type)) { err(`step ${s.id}: type must be one of ${STEP_TYPES.join(', ')}`); continue; }
    if (['think', 'command', 'gate', 'jira'].includes(s.type)) {
      if (!agentIds.has(s.agent)) err(`step ${s.id}: agent "${s.agent}" is not in agents`);
      if (typeof s.label !== 'string' || !s.label) err(`step ${s.id}: label is required`);
    }
    if (s.station != null && !STATIONS.includes(s.station)) err(`step ${s.id}: station must be one of ${STATIONS.join(', ')}`);
    target(s, s.goto, 'goto');
    if (s.type === 'think') {
      if (typeof s.prompt !== 'string' || !s.prompt.trim()) err(`step ${s.id}: prompt is required`);
      if (!s.schema || s.schema.type !== 'object' || !s.schema.properties) err(`step ${s.id}: schema must be a JSON schema of type object with properties`);
      if (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(s.save || '') || RESERVED.includes(s.save)) err(`step ${s.id}: save must be a simple name and not one of ${RESERVED.join(', ')}`);
      if (s.tools != null && !TOOLS.includes(s.tools)) err(`step ${s.id}: tools must be ${TOOLS.join(', ')}`);
    }
    if (s.type === 'parallel') {
      if (!Array.isArray(s.branches) || s.branches.length < 2 || !s.branches.every(Array.isArray)) err(`step ${s.id}: branches must be two or more lists of steps`);
      else if (s.branches.flat().some(x => x.type !== 'think' || x.goto)) err(`step ${s.id}: parallel branches may only hold think steps without goto`);
    }
    if (['command', 'jira'].includes(s.type) && s.save != null && (!/^[a-zA-Z][a-zA-Z0-9]{0,30}$/.test(s.save) || RESERVED.includes(s.save))) err(`step ${s.id}: save must be a simple name`);
    if (s.type === 'command') {
      if (typeof s.command !== 'string' || !s.command) err(`step ${s.id}: command must name an entry of "commands" in office.config.json`);
      if (s.files != null && (!Array.isArray(s.files) || !s.files.every(f => typeof f === 'string'))) err(`step ${s.id}: files must be a list of context paths`);
      actions(s, s.extraActions, 'extraActions');
      target(s, s.onSkip, 'onSkip');
    }
    if (s.type === 'gate') {
      if (!Array.isArray(s.actions) || !s.actions.length) err(`step ${s.id}: a gate needs actions`);
      actions(s, s.actions, 'actions');
    }
    if (s.type === 'jira') {
      if (!JIRA_ACTIONS.includes(s.action)) err(`step ${s.id}: action must be one of ${JIRA_ACTIONS.join(', ')}`);
      if (['comment', 'update'].includes(s.action) && typeof s.body !== 'string') err(`step ${s.id}: body is required`);
      if (s.action === 'create' && typeof s.summary !== 'string') err(`step ${s.id}: summary is required`);
      if (s.action === 'create' && typeof s.issueType !== 'string') err(`step ${s.id}: issueType is required`);
      if (s.action === 'transition' && typeof s.to !== 'string') err(`step ${s.id}: to is required`);
      if (s.action === 'link' && (typeof s.inward !== 'string' || typeof s.outward !== 'string')) err(`step ${s.id}: inward and outward are required`);
      actions(s, s.extraActions, 'extraActions');
      target(s, s.onSkip, 'onSkip');
    }
    if (s.type === 'branch') {
      if (!s.when || typeof s.when.path !== 'string' || (s.when.op && !OPS.includes(s.when.op))) err(`step ${s.id}: when needs a path and an op of ${OPS.join(', ')}`);
      if (!s.goto) err(`step ${s.id}: a branch needs goto`);
      target(s, s.else, 'else');
    }
    if (s.type === 'end' && (!s.result || typeof s.result.label !== 'string' || !TONES.includes(s.result.tone))) err(`step ${s.id}: result needs a label and a tone of ${TONES.join(', ')}`);
  }
  return errors;
}

/** Fill in colours and defaults so the office can draw any valid crew. */
export function normalizeTeam(team) {
  const t = structuredClone(team);
  t.agents = t.agents.map((a, i) => ({ ...PALETTE[i % PALETTE.length], ...Object.fromEntries(Object.entries(a).filter(([k, v]) => !['shirt', 'hair', 'skin'].includes(k) || HEX.test(v))) }));
  t.stationLabels = { board: 'Work board', rack: 'Servers', terminal: 'Terminal', bench: 'Workbench', you: 'Your desk', coffee: 'Coffee', ...(t.stationLabels || {}) };
  return t;
}

export class TeamStore {
  constructor(root = ROOT, customDir = null) {
    this.builtinDir = path.join(root, 'teams');
    this.customDir = customDir || path.join(root, 'teams', 'custom');
    this.teams = new Map();
    this.problems = [];
    this.reload();
  }

  reload() {
    this.teams.clear(); this.problems = [];
    for (const [dir, custom] of [[this.builtinDir, false], [this.customDir, true]]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
        try {
          const team = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const errors = validateTeam(team);
          if (errors.length) { this.problems.push(`${f}: ${errors.join('; ')}`); continue; }
          this.teams.set(team.id, { ...normalizeTeam(team), custom });
        } catch (e) { this.problems.push(`${f}: ${e.message}`); }
      }
    }
  }

  get(id) { return this.teams.get(id) || null; }
  list() {
    return [...this.teams.values()].map(t => ({ id: t.id, name: t.name, role: t.role, description: t.description, custom: t.custom, agents: t.agents.map(a => `${a.name}, ${a.title}`) }));
  }

  saveCustom(team) {
    const errors = validateTeam(team);
    if (errors.length) throw new Error('Crew is not valid: ' + errors.join('; '));
    fs.mkdirSync(this.customDir, { recursive: true });
    fs.writeFileSync(path.join(this.customDir, `${team.id}.json`), JSON.stringify(team, null, 2) + '\n');
    this.reload();
    return this.get(team.id);
  }

  uniqueId(base) {
    const slug = 'custom-' + (String(base).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 28) || 'crew');
    let id = slug, n = 2;
    while (this.teams.has(id)) id = `${slug}-${n++}`;
    return id;
  }
}

/** Ask the model for a crew that fits a role, validate it, and give it one chance to repair its own mistakes. */
export async function generateTeam({ brain, store, role, day, signal, root = ROOT }) {
  const reference = fs.readFileSync(path.join(root, 'docs', 'TEAMS.md'), 'utf8');
  const example = fs.readFileSync(path.join(root, 'teams', 'qa.json'), 'utf8');
  const id = store.uniqueId(role);
  const base = `Design a crew of AI agents for this person and return it as a crew file.

Their role: ${role}
Their day, in their words: ${day || '(not given, infer a typical day for this role)'}

Requirements:
- The crew id must be exactly "${id}".
- 2 to 4 agents with short first names (8 characters at most), each with one clear job. Give each a distinct shirt colour.
- The briefing JQL must use {{project}} and {{scope}} and must rely on statusCategory, not on status names, so it works on any Jira site.
- The workflow must do real, useful work for this role on ONE Jira ticket and end by handing the human something concrete:
  a Jira comment, new Jira issues, an updated description, or files in the workspace.
- Use "tools": "read" or "write" only where the agent truly needs the code repository.
- Use a "command" step only with the command names "test", "lint" or "build", which the user may configure.
- Add a "gate" where the human should choose between paths (for example continue, ask for a rework once, or stop). Do not add gates just to confirm a Jira write or a command: the office already asks before each of those.
- Every path must reach an "end" step.
- Prompts must tell the agent what to read from the context with {{...}} placeholders and must forbid inventing facts that are not in the ticket.

Return the crew file as a JSON string in "teamJson" and a two-sentence explanation in "notes".

=== CREW FILE REFERENCE ===
${reference}

=== A COMPLETE, VALID EXAMPLE ===
${example}`;

  const schema = { type: 'object', properties: { teamJson: { type: 'string' }, notes: { type: 'string' } } };
  let prompt = base, lastErrors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await brain.think({ persona: 'You design crews of AI agents for a workflow engine. You return strict, valid JSON.', prompt, schema, signal });
    let team;
    try { team = JSON.parse(out.teamJson); } catch (e) { lastErrors = ['teamJson is not valid JSON: ' + e.message]; team = null; }
    if (team) {
      team.id = id;
      lastErrors = validateTeam(team);
      if (!lastErrors.length) return { team: store.saveCustom(team), notes: out.notes };
    }
    prompt = `${base}\n\nYour previous answer was rejected for these reasons. Fix every one of them:\n- ${lastErrors.join('\n- ')}\n\nPrevious answer:\n${out.teamJson}`;
  }
  throw new Error('The generated crew was not valid: ' + lastErrors.slice(0, 4).join('; '));
}
