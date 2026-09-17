import fs from 'node:fs';
import path from 'node:path';
import { sleep, ResetError, clip } from './util.js';
import { render, pick, test, mainText } from './template.js';
import { flatten, generateTeam } from './teams.js';

const RANK_SCHEMA = { type: 'object', properties: { ranked: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, why: { type: 'string' }, actionable: { type: 'boolean' } } } } } };
const PRIORITY = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
const MAX_VISITS = 3;
const SUB_KEYS = ['reason', 'why', 'kind', 'description', 'error', 'status'];

export const cleanJql = jql => jql.replace(/\bAND\s+(?=AND\b)/gi, '').replace(/^\s*AND\s+/i, '').replace(/\bAND\s+(?=ORDER\s+BY\b)/gi, '').replace(/\s{2,}/g, ' ').trim();

export function fallbackRank(tickets) {
  const w = t => [t.blocked ? 1 : 0, /progress/i.test(t.statusCategory || '') ? 0 : 1, PRIORITY[(t.priority || '').toLowerCase()] ?? 5];
  return [...tickets].sort((a, b) => { const x = w(a), y = w(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
}

/** Turn any value a step produced into something the side panel can draw. */
export function section(title, value) {
  if (Array.isArray(value)) {
    return { title: `${title} (${value.length})`, items: value.map(v => {
      const sub = v && typeof v === 'object' ? SUB_KEYS.map(k => v[k]).find(x => typeof x === 'string' && x) : '';
      return { text: clip(mainText(v), 300), sub: clip(sub || '', 400) };
    }) };
  }
  if (value && typeof value === 'object') return { title, code: JSON.stringify(value, null, 1) };
  return { title, text: String(value ?? '') };
}

export class Office {
  constructor({ cfg, hub, jira, brain, commands, store, dataDir = null }) {
    Object.assign(this, { cfg, hub, jira, brain, commands, store, dataDir });
    this.beat = cfg.mode === 'mock' ? 1 : 0.5;
    this.speed = 1;
    this.team = store.get(this.savedTeamId()) || null;
    this.init();
  }

  /* ---------- state ---------- */
  savedTeamId() {
    if (this.dataDir) { try { return JSON.parse(fs.readFileSync(path.join(this.dataDir, 'selected-team.json'), 'utf8')).id; } catch { /* first run */ } }
    return this.cfg.team;
  }
  rememberTeam(id) {
    if (!this.dataDir) return;
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(path.join(this.dataDir, 'selected-team.json'), JSON.stringify({ id }) + '\n');
  }
  publicTeam() {
    const t = this.team;
    return t ? { id: t.id, name: t.name, role: t.role, description: t.description, agents: t.agents, stationLabels: t.stationLabels } : null;
  }
  initialState() {
    return {
      mode: this.cfg.mode, dryRun: !this.jira.writeEnabled, jiraReady: this.jira.ready, jiraSite: this.jira.site, project: this.cfg.jira.project,
      workspaceReady: this.commands.ready(), teams: this.store.list(), teamProblems: this.store.problems, team: this.publicTeam(),
      view: this.team ? 'start' : 'team', busy: false, jql: '', tickets: [], current: null, steps: null, pending: null, results: {}, error: null, notice: null,
    };
  }
  init() {
    this.abort?.abort();
    this.abort = new AbortController();
    this.tickets = new Map();
    this.decision = null;
  }
  reset() { this.init(); this.hub.reset(this.initialState()); }
  get signal() { return this.abort.signal; }
  pause(ms) { return sleep(ms * this.beat / this.speed, this.signal); }
  set(patch) { this.hub.setState(patch); }
  agent(id) { return this.team.agents.find(a => a.id === id); }
  persona(id) { const a = this.agent(id); return `You are ${a.name}, ${a.title}, part of a crew of AI agents that supports a ${this.team.role}. You are precise, you never invent facts that are not in what you were given, and you say so when information is missing.`; }

  emit(e, opts) { if (e.agent !== 'you') this.acted?.add(e.agent); return this.hub.emit(e, opts); }

  async guard(agent, fn, recover) {
    const mine = this.abort;
    try { await fn(); } catch (e) {
      if (e instanceof ResetError || mine !== this.abort) return;
      console.error(e);
      if (agent) this.emit({ agent, type: 'agent.error', status: 'error', ticket: this.hub.state.current?.key, message: clip(e.message, 160) });
      this.set({ busy: false, pending: null, error: clip(e.message, 700), current: null, steps: null, ...recover() });
    }
  }

  waitDecision(allowed) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new ResetError());
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.decision = { allowed, resolve: v => { this.signal.removeEventListener('abort', onAbort); resolve(v); } };
    });
  }
  decide(action, payload = {}) {
    const d = this.decision;
    if (!d || !d.allowed.includes(action)) return false;
    this.decision = null;
    d.resolve({ action, ...payload });
    return true;
  }

  /* ---------- crews ---------- */
  selectTeam(id) {
    const team = this.store.get(id);
    if (!team || this.hub.state.busy) return;
    this.team = team; this.rememberTeam(id); this.reset();
  }
  changeTeam() {
    if (this.hub.state.busy) return;
    this.init();
    this.hub.reset({ ...this.initialState(), view: 'team' });
  }
  createTeam({ role, day }) {
    role = clip(String(role || '').trim(), 120); day = clip(String(day || '').trim(), 2000);
    if (!role || this.hub.state.busy) return;
    return this.guard(null, async () => {
      this.set({ busy: true, view: 'creating', error: null, notice: `Designing a crew for a ${role}. This takes a minute or two.` });
      const { team, notes } = await generateTeam({ brain: this.brain, store: this.store, role, day, signal: this.signal });
      this.team = team; this.rememberTeam(team.id); this.init();
      this.hub.reset({ ...this.initialState(), notice: notes });
    }, () => ({ view: 'team', notice: null, teams: this.store.list() }));
  }

  /* ---------- morning briefing ---------- */
  startDay() {
    if (this.hub.state.busy || !this.team) return;
    const b = this.team.briefing;
    return this.guard(b.agent, async () => {
      this.acted = new Set();
      if (!this.jira.ready) throw new Error('Jira is not connected. Copy .env.example to .env, fill in JIRA_BASE_URL and your credentials, and restart the office.');
      if (!this.cfg.jira.project && this.cfg.mode !== 'mock') throw new Error('Set jira.project in office.config.json to your Jira project key.');
      const jql = cleanJql(render(b.jql, { project: this.cfg.jira.project || 'DEMO', scope: this.cfg.jira.scopeJql || '' }));
      this.set({ busy: true, view: 'loading', error: null, notice: null, jql });
      this.emit({ agent: b.agent, type: 'briefing.started', message: 'Morning! Opening the board' });
      await this.pause(900);
      this.emit({ agent: b.agent, type: 'jira.query', station: 'board', message: 'Searching Jira', data: { jql } });
      const found = await this.jira.search(jql);
      if (!found.length) throw new Error(`The Jira query returned nothing: ${jql}. Adjust jira.scopeJql in office.config.json, or the briefing JQL of this crew.`);
      for (const t of found) this.tickets.set(t.key, t);

      this.emit({ agent: b.agent, type: 'briefing.ranking', station: 'board', message: `Ranking ${found.length} tickets`, data: { found: found.length } });
      let ordered;
      try {
        const list = found.map(t => ({ key: t.key, summary: t.summary, type: t.type, status: t.status, priority: t.priority, assignee: t.assignee, blockedBy: t.blockedBy.map(x => x.key), description: clip(t.description, 500) }));
        const res = await this.brain.think({ persona: this.persona(b.agent), schema: RANK_SCHEMA, signal: this.signal, mockKind: 'rank',
          prompt: `${b.rankPrompt}\n\nRank every ticket exactly once, by key, in the order the ${this.team.role} should handle them today. "why" is one short sentence for them. Set "actionable" to false when there is nothing this crew can do with the ticket. Put blocked tickets last.\n\n${JSON.stringify(list, null, 1)}` });
        const seen = new Set();
        ordered = [];
        for (const r of res.ranked) {
          const t = this.tickets.get(r.key);
          if (!t || seen.has(r.key)) continue;
          seen.add(r.key); ordered.push({ ...t, why: r.why, actionable: r.actionable !== false });
        }
        for (const t of fallbackRank(found)) if (!seen.has(t.key)) ordered.push({ ...t, why: '', actionable: true });
        ordered.sort((x, y) => Number(y.actionable) - Number(x.actionable));
      } catch (e) {
        if (e instanceof ResetError) throw e;
        this.emit({ agent: b.agent, type: 'briefing.fallback', status: 'error', station: 'board', message: 'Could not reach Claude, ranking by status and priority', data: { error: clip(e.message, 200) } });
        ordered = fallbackRank(found).map(t => ({ ...t, why: '', actionable: true }));
      }
      const tickets = ordered.slice(0, this.cfg.jira.maxTickets).map(({ description, labels, links, subtasks, ...rest }) => rest);
      this.emit({ agent: b.agent, type: 'briefing.ready', status: 'waiting', station: 'you', message: 'Your list is ready', data: { tickets: tickets.map(t => t.key) } });
      this.set({ busy: false, view: 'pick', tickets });
    }, () => ({ view: 'start' }));
  }

  /* ---------- one ticket through the crew's workflow ---------- */
  selectTicket(key) {
    const s = this.hub.state;
    const listed = s.tickets.find(t => t.key === key);
    const ticket = this.tickets.get(key);
    if (s.busy || !listed || !ticket || listed.selectable === false) return;
    if (s.results[key] && s.results[key].tone !== 'muted') return;
    const steps = this.team.workflow;

    return this.guard(this.team.briefing.agent, async () => {
      this.acted = new Set();
      this.used = new Set();
      const ctx = { ticket, project: this.cfg.jira.project, scope: this.cfg.jira.scopeJql, language: this.cfg.language,
        issueTypes: this.cfg.jira.issueTypes, linkTypes: this.cfg.jira.linkTypes, today: new Date().toISOString().slice(0, 10) };
      this.current = { key, summary: ticket.summary, url: ticket.url, sections: [], warnings: [] };
      this.set({ busy: true, view: 'work', error: null, notice: null, current: this.current,
        steps: flatten(steps).filter(x => x.label).map(x => ({ id: x.id, label: x.label, state: '' })) });
      this.emit({ agent: 'you', type: 'ticket.selected', status: 'done', ticket: key, message: `You picked ${key}` });
      this.emit({ agent: this.team.briefing.agent, type: 'agent.idle', status: 'idle', station: 'coffee', ticket: key, message: `Handed ${key} to the crew` });

      const visits = {};
      let i = 0, result = { label: 'Done', tone: 'ok' };
      while (i < steps.length) {
        const step = steps[i];
        visits[step.id] = (visits[step.id] || 0) + 1;
        if (visits[step.id] > MAX_VISITS) { result = { label: 'Stopped: the workflow kept looping', tone: 'muted' }; break; }
        const next = await this.exec(step, ctx);
        if (next?.end) { result = next.end; break; }
        const target = next ? next.goto : step.goto; // a step's own answer wins over its static goto
        if (target === 'end') break;
        i = target ? steps.findIndex(x => x.id === target) : i + 1;
        if (i < 0) throw new Error(`Step ${step.id} points to an unknown step "${target}"`);
      }
      let label = clip(render(result.label, ctx), 60);
      if (ctx.dryRun && result.tone !== 'muted') label += ' (dry run)';
      for (const id of this.acted) this.emit({ agent: id, type: 'agent.idle', status: 'idle', station: 'coffee', message: 'Back to the coffee corner' });
      this.set({ busy: false, view: 'pick', current: null, steps: null, pending: null, results: { ...this.hub.state.results, [key]: { label, tone: result.tone } } });
    }, () => ({ view: this.hub.state.tickets.length ? 'pick' : 'start' }));
  }

  mark(id, state) { this.set({ steps: (this.hub.state.steps || []).map(s => (s.id === id ? { ...s, state } : s)) }); }
  show(title, value) {
    const sec = section(title, value);
    const base = t => t.replace(/ \(\d+\)$/, '');
    this.current.sections = [...this.current.sections.filter(s => base(s.title) !== title), sec];
    this.set({ current: { ...this.current } });
  }

  exec(step, ctx) {
    switch (step.type) {
      case 'think': return this.execThink(step, ctx);
      case 'parallel': return this.execParallel(step, ctx);
      case 'command': return this.execCommand(step, ctx);
      case 'gate': return this.execGate(step, ctx);
      case 'jira': return this.execJira(step, ctx);
      case 'branch': return test(step.when, ctx) ? { goto: step.goto } : { goto: step.else };
      case 'end': return { end: step.result };
      default: throw new Error(`Unknown step type ${step.type}`);
    }
  }

  async execParallel(step, ctx) {
    const settled = await Promise.allSettled(step.branches.map(async branch => { for (const s of branch) await this.execThink(s, ctx); }));
    const failed = settled.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async execThink(step, ctx) {
    const key = ctx.ticket.key, station = step.station || 'terminal', tools = step.tools || 'none';
    this.mark(step.id, 'active');
    if (tools !== 'none' && !this.commands.ready()) {
      ctx[step.save] = { skipped: true };
      this.emit({ agent: step.agent, type: `${step.id}.skipped`, status: 'done', station, ticket: key, message: `${step.label}: skipped, no workspace is configured` });
      this.current.warnings.push(`"${step.label}" needs the code repository. Set workspace.repoDir in office.config.json.`);
      this.mark(step.id, 'done');
      return;
    }
    this.emit({ agent: step.agent, type: `${step.id}.started`, station, ticket: key, message: clip(render(step.message || step.label, ctx), 120) });
    const before = tools === 'write' ? await this.commands.gitStatus(this.signal) : null;
    const out = await this.brain.think({ persona: this.persona(step.agent), prompt: render(step.prompt, ctx), schema: step.schema, tools, cwd: this.commands.repoDir, signal: this.signal, mockTicket: ctx.ticket });
    ctx[step.save] = out;
    if (step.appendTo && step.appendFrom) {
      const target = pick(ctx, step.appendTo), extra = pick(ctx, step.appendFrom);
      if (Array.isArray(target) && Array.isArray(extra)) target.push(...extra);
    }
    if (before) {
      const changes = await this.commands.changesSince(before, this.signal);
      ctx.changes = changes;
      if (changes.created.length) this.show('Files created', changes.created);
      if (changes.modified.length) this.current.warnings.push(`${this.agent(step.agent).name} modified existing files: ${changes.modified.join(', ')}. Review them with git diff.`);
    }
    for (const s of step.show || []) this.show(s.title, pick(ctx, s.path));
    this.emit({ agent: step.agent, type: `${step.id}.done`, status: 'done', station, ticket: key, message: clip(render(step.doneMessage || `${step.label}: done`, ctx), 120) });
    this.mark(step.id, 'done');
    await this.pause(700);
  }

  /** Every approval goes through here. Returns the chosen action object, or { id: 'approve' | 'skip' }. */
  async ask(step, ctx, { agent, title, message, sections = [], input = null, actions, warnings = [] }) {
    const live = actions.filter(a => !(a.once && this.used.has(`${step.id}:${a.id}`)));
    this.emit({ agent, type: 'approval.requested', status: 'waiting', station: 'you', ticket: ctx.ticket.key, message: clip(title, 120), data: { step: step.id } });
    this.set({ busy: false, view: 'approve', pending: { step: step.id, title, message, sections, input, warnings,
      actions: live.map(a => ({ id: a.id, label: a.label, primary: !!a.primary })) } });
    const d = await this.waitDecision(live.map(a => a.id));
    const chosen = live.find(a => a.id === d.action);
    if (chosen.once) this.used.add(`${step.id}:${chosen.id}`);
    this.set({ busy: true, view: 'work', pending: null });
    this.emit({ agent: 'you', type: `approval.${chosen.id}`, status: 'done', ticket: ctx.ticket.key, message: `You chose "${chosen.label}"` });
    return { ...chosen, input: typeof d.input === 'string' ? d.input : undefined };
  }
  outcome(chosen, ctx) {
    if (chosen.result) return { end: chosen.result };
    if (chosen.goto) return { goto: chosen.goto };
    return null;
  }

  async execGate(step, ctx) {
    this.mark(step.id, 'active');
    const chosen = await this.ask(step, ctx, {
      agent: step.agent, title: render(step.title || step.label, ctx), message: render(step.message || '', ctx),
      sections: (step.show || []).map(s => section(s.title, pick(ctx, s.path))), warnings: [...this.current.warnings],
      input: step.input ? { label: step.input.label || 'Your note', value: render(step.input.value || '', ctx) } : null, actions: step.actions,
    });
    if (step.input?.save && chosen.input !== undefined) ctx[step.input.save] = chosen.input;
    this.mark(step.id, 'done');
    return this.outcome(chosen, ctx);
  }

  async execCommand(step, ctx) {
    const key = ctx.ticket.key, save = step.save || 'run', station = step.station || 'terminal';
    const skip = reason => {
      const r = { executed: false, reason, exitCode: null, total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0, failures: [] };
      ctx[save] = { ...r, summary: `Not executed: ${reason}` };
      this.emit({ agent: step.agent, type: `${step.id}.skipped`, status: 'done', station, ticket: key, message: `${step.label}: not executed, ${reason}` });
      this.mark(step.id, 'done');
    };
    this.mark(step.id, 'active');
    if (!this.commands.ready()) return skip('no workspace is configured'), null;
    if (!this.commands.has(step.command)) return skip(`no "${step.command}" command is configured`), null;

    const files = (step.files || []).flatMap(p => { const v = pick(ctx, p); return Array.isArray(v) ? v : v == null ? [] : [v]; }).filter(v => typeof v === 'string');
    const plan = this.commands.plan(step.command, files);
    const warnings = [...this.current.warnings];
    if (plan.rejected.length) warnings.push(`Left out because they are not files inside the workspace: ${plan.rejected.join(', ')}`);
    const chosen = await this.ask(step, ctx, {
      agent: step.agent, title: render(step.gateTitle || `Run "${step.label}"?`, ctx), warnings,
      message: `${this.agent(step.agent).name} wants to run this command in ${plan.cwd}. Nothing runs until you approve.`,
      sections: [{ title: 'Command', code: plan.display }, ...(plan.files.length ? [section('Files', plan.files)] : [])],
      actions: [{ id: 'approve', label: 'Run it', primary: true }, ...(step.extraActions || []), { id: 'skip', label: 'Not now' }],
    });
    if (chosen.id === 'skip') { skip('you chose not to run it'); return step.onSkip ? { goto: step.onSkip } : null; }
    if (chosen.id !== 'approve') { this.mark(step.id, 'done'); return this.outcome(chosen, ctx); }

    this.emit({ agent: step.agent, type: `${step.id}.running`, station, ticket: key, message: clip(`Running: ${plan.display}`, 120), data: { kind: 'command', files: plan.files } });
    let last = 0;
    const r = await this.commands.run(step.command, files, { ticketKey: key, signal: this.signal, onProgress: (n, total) => {
      if (Date.now() - last < 900 && n !== total) return;
      last = Date.now();
      this.emit({ agent: step.agent, type: `${step.id}.progress`, station, ticket: key, message: `Running: ${n} of ${total}`, data: { kind: 'command', n, total } }, { transient: true });
    } });
    ctx[save] = r;
    this.show('Result', r.summary);
    if (r.failures.length) this.show('Failures', r.failures);
    this.emit({ agent: step.agent, type: `${step.id}.finished`, status: r.failed ? 'error' : 'done', station, ticket: key, message: r.summary,
      data: { kind: 'command', total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped, report: r.reportDir } });
    this.mark(step.id, r.failed ? 'fail' : 'done');
    await this.pause(1200);
    return null;
  }

  async execJira(step, ctx) {
    const save = step.save || step.id.replace(/-/g, '');
    const issue = render(step.issue || '{{ticket.key}}', ctx);
    const dryNote = this.jira.writeEnabled ? 'Nothing is written to Jira until you approve.' : 'Jira is in dry run: approving will not write anything.';
    this.mark(step.id, 'active');
    let title, sections = [], input = null, perform, okMessage, warnings = [...this.current.warnings];

    if (step.action === 'comment') {
      title = `Post this comment on ${issue}?`;
      input = { label: 'Comment (you can edit it)', value: render(step.body, ctx) };
      perform = text => this.jira.comment(issue, text || input.value);
      okMessage = () => `Commented on ${issue}`;
    } else if (step.action === 'update') {
      title = `Update ${issue}?`;
      const summary = step.summary ? render(step.summary, ctx) : undefined;
      if (summary) sections.push(section('New summary', summary));
      input = { label: 'New description (you can edit it)', value: render(step.body, ctx) };
      warnings.push('This replaces the whole description of the issue.');
      perform = text => this.jira.update(issue, { summary, description: text || input.value });
      okMessage = () => `Updated ${issue}`;
    } else if (step.action === 'create') {
      const source = step.from ? pick(ctx, step.from) : [null];
      const items = (Array.isArray(source) ? source : []).slice(0, 20).map(item => {
        const c = { ...ctx, item };
        const it = { type: render(step.issueType, c), summary: clip(render(step.summary, c), 250), description: render(step.body || '', c) };
        if (step.priority) it.priority = render(step.priority, c);
        if (step.parent) it.parent = render(step.parent, c);
        if (Array.isArray(step.labels)) it.labels = step.labels.map(l => render(l, c)).filter(Boolean);
        return it;
      }).filter(it => it.summary);
      if (!items.length) { this.mark(step.id, 'done'); ctx[save] = { dryRun: false, keys: [], count: 0, keysText: 'nothing to create' }; return null; }
      title = items.length === 1 ? `Create this ${items[0].type} in ${this.cfg.jira.project || 'Jira'}?` : `Create these ${items.length} issues in ${this.cfg.jira.project || 'Jira'}?`;
      sections = [section('Issues to create', items.map(it => ({ title: `${it.type}: ${it.summary}`, description: it.description })))];
      const linkTo = step.linkTo ? render(step.linkTo, ctx) : null;
      if (linkTo) sections.push(section('Linked to', `${linkTo} (${render(step.linkType || '{{linkTypes.relates}}', ctx)})`));
      perform = () => this.jira.create(items, { linkTo, linkType: linkTo ? render(step.linkType || '{{linkTypes.relates}}', ctx) : null });
      okMessage = r => `Created ${r.keys.join(', ')}`;
    } else if (step.action === 'transition') {
      const to = render(step.to, ctx);
      title = `Move ${issue} to "${to}"?`;
      perform = () => this.jira.transition(issue, to);
      okMessage = () => `Moved ${issue} to ${to}`;
    } else {
      const inward = render(step.inward, ctx), outward = render(step.outward, ctx), type = render(step.linkType || '{{linkTypes.relates}}', ctx);
      title = `Link ${inward} to ${outward} (${type})?`;
      perform = () => this.jira.link(inward, outward, type);
      okMessage = () => `Linked ${inward} to ${outward}`;
    }

    const chosen = await this.ask(step, ctx, { agent: step.agent, title: render(step.gateTitle || title, ctx), message: dryNote, sections, input, warnings,
      actions: [{ id: 'approve', label: step.approveLabel || 'Approve', primary: true }, ...(step.extraActions || []), { id: 'skip', label: 'Skip' }] });
    if (chosen.id === 'skip') {
      ctx[save] = { skipped: true, keys: [], keysText: 'skipped' };
      this.mark(step.id, 'done');
      return step.onSkip ? { goto: step.onSkip } : null;
    }
    if (chosen.id !== 'approve') { this.mark(step.id, 'done'); return this.outcome(chosen, ctx); }

    const r = await perform(chosen.input && chosen.input.trim());
    if (r.dryRun) ctx.dryRun = true;
    ctx[save] = { ...r, keysText: r.keys?.length ? r.keys.join(', ') : r.dryRun ? 'not created' : '' };
    this.emit({ agent: step.agent, type: `${step.id}.done`, status: 'done', station: 'board', ticket: ctx.ticket.key,
      message: r.dryRun ? 'Dry run: nothing was written to Jira' : okMessage(r), data: { dryRun: r.dryRun, keys: r.keys } });
    this.mark(step.id, 'done');
    await this.pause(1200);
    return null;
  }
}
