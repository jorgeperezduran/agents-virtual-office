import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { ROOT, assertSafeCommand, merge } from '../server/config.js';
import { render, pick, test as cond } from '../server/template.js';
import { TeamStore, validateTeam, normalizeTeam } from '../server/teams.js';
import { safeFiles, summarizePlaywright, describeRun } from '../server/adapters/commands.js';
import { strictSchema } from '../server/adapters/brain.js';
import { createMock, fake } from '../server/adapters/mock.js';
import { fallbackRank, section, cleanJql } from '../server/engine.js';
import { validateEvent } from '../server/hub.js';

const baseCfg = () => ({
  mode: 'mock', port: 0, language: 'en', team: null,
  jira: { project: 'DEMO', scopeJql: 'sprint in openSprints()', maxResults: 30, maxTickets: 8, writeEnabled: true,
    issueTypes: { story: 'Story', bug: 'Bug', task: 'Task', subtask: 'Sub-task' }, linkTypes: { blocks: 'Blocks', relates: 'Relates' } },
  workspace: { repoDir: null }, commands: {}, safety: { forbiddenPattern: 'prod' }, llm: { model: 'x', maxBudgetUsdPerCall: 1, timeoutMinutes: 1 },
});

test('templates: paths, list mapping, filters and conditions', () => {
  const ctx = { ticket: { key: 'A-1' }, cases: { cases: [{ title: 'one', kind: 'positive' }, { title: 'two' }] }, regression: { suites: [{ file: 'a.spec.ts' }, { file: 'b.spec.ts' }] }, run: { failed: 2 }, flags: [], n: null };
  assert.equal(render('{{ticket.key}}: {{cases.cases|count}} cases', ctx), 'A-1: 2 cases');
  assert.equal(render('{{cases.cases|titles}}', ctx), '- one\n- two');
  assert.equal(render('{{cases.cases|numbered}}', ctx), '1. one\n2. two');
  assert.equal(render('{{regression.suites[].file}}', ctx), '- a.spec.ts\n- b.spec.ts');
  assert.equal(render('[{{missing.deep.path}}]', ctx), '[]');
  assert.deepEqual(pick(ctx, 'regression.suites[].file'), ['a.spec.ts', 'b.spec.ts']);
  assert.equal(JSON.parse(render('{{run|json}}', ctx)).failed, 2);
  assert.equal(cond({ path: 'run.failed', op: 'gt', value: 0 }, ctx), true);
  assert.equal(cond({ path: 'flags' }, ctx), false, 'an empty list is falsy');
  assert.equal(cond({ path: 'n', op: 'falsy' }, ctx), true);
  assert.equal(render('[{{constructor.constructor}}|{{ticket.__proto__}}|{{ticket.key.length}}]', ctx), '[||]', 'templates read own data only');
});

test('every built-in crew is valid, and broken crews are refused with reasons', () => {
  const store = new TeamStore(ROOT, fs.mkdtempSync(path.join(os.tmpdir(), 'crews-')));
  assert.deepEqual(store.problems, []);
  assert.deepEqual(store.list().map(t => t.id).sort(), ['developer', 'product-owner', 'qa']);
  const qa = JSON.parse(fs.readFileSync(path.join(ROOT, 'teams', 'qa.json'), 'utf8'));
  assert.deepEqual(validateTeam(qa), []);

  const bad = structuredClone(qa);
  bad.agents[0].name = 'Bartholomew';
  bad.workflow[1].agent = 'ghost';
  bad.workflow[1].save = 'ticket';
  bad.workflow[2].goto = 'nowhere';
  bad.workflow.push({ id: 'explode', type: 'shell', run: 'rm -rf /' });
  const errors = validateTeam(bad).join('\n');
  for (const needle of ['8 characters', 'agent "ghost"', 'save must be', '"nowhere" is not a top-level step', 'type must be one of']) assert.match(errors, new RegExp(needle));

  const plain = normalizeTeam({ ...qa, agents: [{ id: 'a1', name: 'A', title: 'T', shirt: 'red' }], stationLabels: undefined });
  assert.match(plain.agents[0].shirt, /^#[0-9a-f]{6}$/i, 'an invalid colour falls back to the palette');
  assert.equal(plain.stationLabels.board, 'Work board');
});

test('commands: only real workspace files become arguments, production is refused, reports are summarised', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-'));
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'a.spec.ts'), '');
  const r = safeFiles(['tests/a.spec.ts', '../outside.ts', '--config=evil', '/etc/passwd', 'tests/missing.ts', 'tests/a.spec.ts'], repo);
  assert.deepEqual(r.ok, ['tests/a.spec.ts']);
  assert.equal(r.rejected.length, 4);

  assert.throws(() => assertSafeCommand('test', { argv: ['npx', 'playwright', 'test'], env: { TEST_ENV: 'production' } }, 'prod'), /refuses/);
  assert.throws(() => assertSafeCommand('test', { argv: 'npm test' }, 'prod'), /array of strings/);
  assert.doesNotThrow(() => assertSafeCommand('test', { argv: ['npm', 'test'], env: { TEST_ENV: 'dev' } }, 'prod'));

  const t = (status, results = []) => ({ status, results });
  const s = summarizePlaywright({ suites: [{ file: 'a', specs: [{ title: 'ok', tests: [t('expected')] }], suites: [{ specs: [{ title: 'flaky', tests: [t('flaky')] }, { title: 'bad', tests: [t('unexpected', [{ error: { message: 'boom' } }])] }] }] }] });
  assert.deepEqual([s.total, s.passed, s.failed, s.flaky, s.failures[0].error], [3, 2, 1, 1, 'boom']);
  assert.match(describeRun({ executed: true, ...s, skipped: 0 }), /1 of 3 tests failed/);
  assert.match(describeRun({ executed: false, reason: 'no workspace' }), /Not executed/);
});

test('small pieces: strict schemas, fake data, ranking, sections, events, config merge', () => {
  const strict = strictSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'object', properties: { b: { type: 'string' } } } } } });
  assert.equal(strict.additionalProperties, false);
  assert.deepEqual(strict.properties.a.items.required, ['b']);
  const f = fake({ type: 'object', properties: { testFile: { type: 'string' }, ok: { type: 'boolean' }, kind: { type: 'string', enum: ['x', 'y'] }, list: { type: 'array', items: { type: 'string' } } } }, 'v', { key: 'D-1' });
  assert.deepEqual([f.testFile, f.ok, f.kind, f.list.length], ['tests/d-1-1.spec.ts', false, 'x', 3]);
  const mk = (key, statusCategory, priority, blocked = false) => ({ key, statusCategory, priority, blocked });
  assert.deepEqual(fallbackRank([mk('A', 'To Do', 'Highest'), mk('B', 'In Progress', 'Low'), mk('C', 'In Progress', 'High'), mk('D', 'In Progress', 'Highest', true)]).map(t => t.key), ['C', 'B', 'A', 'D']);
  assert.deepEqual(section('Cases', [{ title: 'x', kind: 'edge' }]), { title: 'Cases (1)', items: [{ text: 'x', sub: 'edge' }] });
  assert.equal(validateEvent({ agent: 'bot', type: 'build.done', message: 'ok', station: 'rack' }), null);
  assert.match(validateEvent({ agent: 'bot', type: 'x', message: 'm', station: 'moon' }), /station/);
  assert.equal(cleanJql('project = A AND  AND statusCategory = "To Do" ORDER BY priority'), 'project = A AND statusCategory = "To Do" ORDER BY priority', 'an empty scope leaves valid JQL');
  assert.equal(cleanJql('project = A AND sprint in openSprints() AND  ORDER BY x'), 'project = A AND sprint in openSprints() ORDER BY x');
  assert.deepEqual(merge({ a: { b: 1, c: [1] } }, { a: { c: [2] } }), { a: { b: 1, c: [2] } });
});

/* ---------- whole simulated days, driven the way the browser drives them ---------- */
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const events = [];
  let state = null, waiters = [];
  ws.on('message', raw => {
    const m = JSON.parse(raw.toString());
    if (m.state) state = m.state;
    if (m.kind === 'event') events.push(m.event);
    waiters = waiters.filter(w => !(w.pred(state) && (w.resolve(state), true)));
  });
  return {
    events, ws, open: () => new Promise(r => ws.on('open', r)), send: m => ws.send(JSON.stringify(m)),
    until: (pred, what) => new Promise((resolve, reject) => {
      if (state && pred(state)) return resolve(state);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; view=${state?.view} pending=${state?.pending?.step} error=${state?.error}`)), 20_000);
      waiters.push({ pred, resolve: s => { clearTimeout(timer); resolve(s); } });
    }),
  };
}

async function office(spy = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-'));
  const cfg = baseCfg();
  let app;
  const adapters = createMock(() => app?.office.speed || 1);
  const writes = [];
  for (const m of ['comment', 'update', 'transition', 'link', 'create']) {
    const orig = adapters.jira[m];
    adapters.jira[m] = async (...args) => { writes.push({ m, args }); return orig(...args); };
  }
  const ran = [];
  const origRun = adapters.commands.run;
  adapters.commands.run = async (...args) => { ran.push(args[0]); return origRun(...args); };
  Object.assign(adapters.jira, spy.jira || {});
  app = createApp(cfg, { store: new TeamStore(ROOT, path.join(tmp, 'custom')), dataDir: path.join(tmp, 'data'), adapters });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  cfg.port = app.server.address().port;
  app.office.speed = 400;
  const c = client(cfg.port);
  await c.open();
  await c.until(s => !!s.view, 'hello');
  return { app, c, writes, ran, tmp, close: () => { c.ws.close(); app.close(); } };
}

/** Work one ticket to its end, answering every approval with choose(pending). Returns the approvals seen. */
async function workTicket(c, key, choose) {
  const seen = [];
  c.send({ cmd: 'selectTicket', key });
  for (let guard = 0; guard < 30; guard++) {
    const s = await c.until(s => (s.pending && !seen.includes(s.pending)) || (s.view === 'pick' && s.results[key]) || s.error, `progress on ${key}`);
    if (s.error) throw new Error(s.error);
    if (s.results[key] && s.view === 'pick') return { result: s.results[key], seen };
    seen.push(s.pending);
    const step = s.pending.step;
    c.send({ cmd: 'decide', action: choose(s.pending) });
    await c.until(s2 => !s2.pending || s2.pending.step !== step || s2.pending !== s.pending, `leaving gate ${step}`);
  }
  throw new Error('too many gates');
}

test('QA crew: pass with one rework round, fail files a bug, and nothing is written without an approval', async () => {
  const o = await office();
  const { c } = o;
  try {
    let s = await c.until(s => s.view === 'team', 'crew picker');
    assert.equal(s.teams.length, 3);
    c.send({ cmd: 'selectTeam', id: 'qa' });
    s = await c.until(s => s.view === 'start' && s.team?.id === 'qa', 'qa selected');
    assert.equal(s.team.agents.length, 4);
    c.send({ cmd: 'startDay' });
    s = await c.until(s => s.view === 'pick', 'list');
    assert.equal(s.tickets.length, 5);
    assert.match(s.jql, /^project = DEMO AND sprint in openSprints\(\) AND statusCategory/);
    assert.equal(s.tickets.find(t => t.key === 'DEMO-105').selectable, false);

    // Passing ticket. First review: ask for more cases. Second review: the rework button is gone.
    let reviews = 0;
    const pass = await workTicket(c, 'DEMO-101', p => {
      if (p.step === 'review') { reviews++; if (reviews === 1) { assert.ok(p.actions.some(a => a.id === 'rework')); return 'rework'; } assert.ok(!p.actions.some(a => a.id === 'rework')); return 'continue'; }
      return 'approve';
    });
    assert.deepEqual(pass.result, { label: 'Signed off', tone: 'ok' });
    assert.deepEqual(pass.seen.map(p => p.step), ['run-tests', 'review', 'run-tests', 'review', 'sign-off']);
    const signoff = pass.seen.at(-1);
    assert.match(signoff.input.value, /QA sign-off\nResult: All \d+ executed tests passed/);
    assert.equal(o.ran.length, 2);
    assert.equal(o.writes.length, 1);
    assert.equal(o.writes[0].m, 'comment');

    // Failing ticket: Bea drafts, the human files, the bug is linked as blocking the ticket.
    const fail = await workTicket(c, 'DEMO-102', () => 'approve');
    assert.deepEqual(fail.seen.map(p => p.step), ['run-tests', 'file-bug']);
    assert.equal(fail.result.tone, 'err');
    assert.match(fail.result.label, /^Bug DEMO-\d+$/);
    const bug = o.writes.at(-1);
    assert.equal(bug.m, 'create');
    assert.equal(bug.args[0][0].type, 'Bug');
    assert.deepEqual(bug.args[1], { linkTo: 'DEMO-102', linkType: 'Blocks' });

    // Skipping the run and skipping a write both leave Jira and the workspace untouched.
    const before = [o.writes.length, o.ran.length];
    const skipped = await workTicket(c, 'DEMO-103', () => 'skip');
    assert.deepEqual(skipped.result, { label: 'Not run', tone: 'muted' });
    assert.deepEqual([o.writes.length, o.ran.length], before);

    // A finished ticket cannot be reopened, a muted one can.
    c.send({ cmd: 'selectTicket', key: 'DEMO-101' });
    await new Promise(r => setTimeout(r, 80));
    assert.equal(o.app.hub.state.view, 'pick');
    c.send({ cmd: 'selectTicket', key: 'DEMO-103' });
    await c.until(s => s.view === 'work' || s.view === 'approve', 'muted ticket reopened');

    // Every event follows the contract and says where the agent stands.
    assert.ok(c.events.every(e => e.ts && e.agent && e.type && typeof e.message === 'string'));
    assert.ok(c.events.some(e => e.station === 'rack' && e.agent === 'rex'));
    assert.ok(!o.app.hub.log.some(e => e.transient));
  } finally { o.close(); }
});

test('developer and product crews run end to end, and each Jira write had its own approval', async () => {
  for (const [id, key, expectWrites] of [['developer', 'DEMO-101', ['comment', 'create']], ['product-owner', 'DEMO-104', ['comment']]]) {
    const o = await office();
    try {
      o.c.send({ cmd: 'selectTeam', id });
      await o.c.until(s => s.view === 'start' && s.team?.id === id, id);
      o.c.send({ cmd: 'startDay' });
      await o.c.until(s => s.view === 'pick', 'list');
      const r = await workTicket(o.c, key, p => (p.actions.find(a => a.primary) || p.actions[0]).id);
      assert.equal(r.result.tone, 'ok', id);
      assert.deepEqual(o.writes.map(w => w.m), expectWrites, id);
      const writeGates = r.seen.filter(p => p.actions.some(a => a.id === 'approve') && p.actions.some(a => a.id === 'skip'));
      assert.equal(writeGates.length, o.writes.length, `${id}: one approval per write`);
      if (id === 'developer') {
        const created = o.writes[1].args[0];
        assert.equal(created.length, 3);
        assert.ok(created.every(it => it.type === 'Sub-task' && it.parent === 'DEMO-101'));
      }
    } finally { o.close(); }
  }
});

test('dry run: approvals still happen, the adapter reports dry run, and the result says so', async () => {
  const o = await office({ jira: { writeEnabled: false, comment: async () => ({ dryRun: true }) } });
  try {
    o.c.send({ cmd: 'selectTeam', id: 'qa' });
    await o.c.until(s => s.view === 'start' && s.dryRun === true, 'dry run state');
    o.c.send({ cmd: 'startDay' });
    await o.c.until(s => s.view === 'pick', 'list');
    const r = await workTicket(o.c, 'DEMO-101', p => (p.step === 'review' ? 'continue' : 'approve'));
    assert.deepEqual(r.result, { label: 'Signed off (dry run)', tone: 'ok' });
    assert.match(r.seen.at(-1).message, /dry run/i);
  } finally { o.close(); }
});

test('create my own crew: generated, validated, saved, selected, remembered, and playable', async () => {
  const o = await office();
  const { c } = o;
  try {
    c.send({ cmd: 'createTeam', role: 'Data Analyst', day: 'I answer data questions that arrive as tickets.' });
    let s = await c.until(s => s.view === 'start' && s.team, 'generated crew');
    assert.equal(s.team.id, 'custom-data-analyst');
    assert.ok(fs.existsSync(path.join(o.tmp, 'custom', 'custom-data-analyst.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(o.tmp, 'data', 'selected-team.json'), 'utf8')).id, 'custom-data-analyst');
    assert.ok(s.teams.some(t => t.id === 'custom-data-analyst' && t.custom));

    c.send({ cmd: 'startDay' });
    await c.until(s => s.view === 'pick', 'list');
    const r = await workTicket(c, 'DEMO-101', () => 'approve');
    assert.deepEqual(r.result, { label: 'Analysis shared', tone: 'ok' });
    assert.equal(o.writes.length, 1);

    // A second crew for the same role gets its own id, and the picker can be reopened.
    c.send({ cmd: 'changeTeam' });
    await c.until(s => s.view === 'team', 'picker');
    c.send({ cmd: 'createTeam', role: 'Data Analyst' });
    s = await c.until(s => s.view === 'start' && s.team?.id === 'custom-data-analyst-2', 'second crew');

    // Reset in the middle of a run stops the crew and keeps the crew selected.
    c.send({ cmd: 'startDay' });
    await c.until(s => s.view === 'pick', 'list again');
    c.send({ cmd: 'selectTicket', key: 'DEMO-103' });
    await c.until(s => s.view === 'work', 'working');
    c.send({ cmd: 'reset' });
    s = await c.until(s => s.view === 'start' && !s.busy, 'reset');
    assert.equal(s.team.id, 'custom-data-analyst-2');
    assert.equal(o.app.hub.log.length, 0);

    // External agents can report in, bad events and foreign origins are refused.
    const post = (body, headers = {}) => fetch(`http://127.0.0.1:${o.app.server.address().port}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await post({ agent: 'buildbot', type: 'build.finished', status: 'done', station: 'rack', message: 'green' })).status, 200);
    assert.equal((await post({ agent: 'buildbot', type: 'x', message: 'm', station: 'moon' })).status, 400);
    assert.equal((await post({ agent: 'a', type: 'b', message: 'c' }, { origin: 'https://evil.example' })).status, 403);
  } finally { o.close(); }
});

test('a generated crew that breaks the rules is rejected and nothing is saved', async () => {
  const o = await office();
  try {
    o.app.office.brain.think = async () => ({ teamJson: JSON.stringify({ id: 'x', name: 'Bad', role: 'r', description: 'd', agents: [], briefing: {}, workflow: [{ id: 'sh', type: 'shell' }] }), notes: '' });
    o.c.send({ cmd: 'createTeam', role: 'Chaos Engineer' });
    const s = await o.c.until(s => s.view === 'team' && s.error, 'rejection');
    assert.match(s.error, /not valid/);
    assert.equal(fs.existsSync(path.join(o.tmp, 'custom')), false);
  } finally { o.close(); }
});
