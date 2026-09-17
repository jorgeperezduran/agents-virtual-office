import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createJiraClient, textToAdf, adfToText, simplifyIssue, main, loadEnvFile, JiraError } from '../skills/jira-stories/scripts/jira.mjs';
import { toTicket } from '../server/adapters/jira.js';

/** A tiny fake Jira that records what it receives. */
async function fakeJira(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const call = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
      calls.push(call);
      const out = handler(call) || { status: 404, json: { errorMessages: ['not found'] } };
      res.writeHead(out.status || 200, { 'content-type': 'application/json' });
      res.end(out.json === undefined ? '' : JSON.stringify(out.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { calls, baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
const issue = (key, extra = {}) => ({ key, fields: { summary: 'S ' + key, status: { name: 'In Review', statusCategory: { name: 'In Progress' } }, issuetype: { name: 'Story' }, priority: { name: 'High' }, ...extra } });

test('textToAdf builds headings, lists, code and paragraphs, and adfToText reads them back', () => {
  const adf = textToAdf('# Title\nFirst line\nsecond line\n\n- one\n- two\n\n1. a\n2. b\n\n```\ncode here\n```');
  assert.deepEqual(adf.content.map(n => n.type), ['heading', 'paragraph', 'bulletList', 'orderedList', 'codeBlock']);
  assert.equal(adf.content[1].content[1].type, 'hardBreak');
  const back = adfToText(adf);
  assert.match(back, /^# Title/);
  assert.match(back, /- one\n- two/);
  assert.match(back, /1\. a\n2\. b/);
  assert.match(back, /code here/);
  assert.equal(textToAdf('').content.length, 1);
});

test('Cloud client: basic auth, new search endpoint, ADF bodies, transition by name, link direction', async () => {
  const j = await fakeJira(c => {
    if (c.url === '/rest/api/3/search/jql') return { json: { issues: [issue('ABC-1'), issue('ABC-2')] } };
    if (c.method === 'POST' && c.url === '/rest/api/3/issue') return { status: 201, json: { key: 'ABC-9' } };
    if (c.url === '/rest/api/3/issue/ABC-1/comment') return { status: 201, json: { id: '1' } };
    if (c.method === 'GET' && c.url === '/rest/api/3/issue/ABC-1/transitions') return { json: { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] } };
    if (c.method === 'POST' && c.url === '/rest/api/3/issue/ABC-1/transitions') return { status: 204 };
    if (c.url === '/rest/api/3/issueLink') return { status: 201 };
    if (c.method === 'PUT') return { status: 204 };
  });
  try {
    const jira = createJiraClient({ baseUrl: j.baseUrl, email: 'me@x.io', apiToken: 'tok', apiVersion: '3' }, {});
    const found = await jira.search('project = ABC', { maxResults: 5 });
    assert.equal(found.length, 2);
    assert.equal(j.calls[0].auth, 'Basic ' + Buffer.from('me@x.io:tok').toString('base64'));
    assert.equal(j.calls[0].body.jql, 'project = ABC');

    const created = await jira.createIssue({ project: 'ABC', type: 'Sub-task', summary: 'Do it', description: '- a\n- b', parent: 'ABC-1', priority: 'High', labels: ['x'] });
    assert.equal(created.key, 'ABC-9');
    const f = j.calls[1].body.fields;
    assert.deepEqual([f.project.key, f.issuetype.name, f.parent.key, f.priority.name, f.labels[0]], ['ABC', 'Sub-task', 'ABC-1', 'High', 'x']);
    assert.equal(f.description.type, 'doc');
    assert.equal(f.description.content[0].type, 'bulletList');

    await jira.addComment('ABC-1', 'hello');
    assert.equal(j.calls[2].body.body.type, 'doc');

    await jira.transition('ABC-1', 'done'); // matches the target status, case-insensitively
    assert.equal(j.calls.at(-1).body.transition.id, '31');
    await assert.rejects(() => jira.transition('ABC-1', 'Nowhere'), /Available: Start, Finish/);

    await jira.link('ABC-9', 'ABC-1', 'Blocks');
    assert.deepEqual(j.calls.at(-1).body, { type: { name: 'Blocks' }, inwardIssue: { key: 'ABC-9' }, outwardIssue: { key: 'ABC-1' } });

    await jira.updateIssue('ABC-1', { description: 'new text' });
    assert.equal(j.calls.at(-1).method, 'PUT');
  } finally { j.close(); }
});

test('Server client: bearer token, v2 endpoints, plain text bodies; search falls back on old Cloud sites', async () => {
  const j = await fakeJira(c => {
    if (c.url === '/rest/api/2/search') return { json: { issues: [issue('OPS-1')] } };
    if (c.url === '/rest/api/2/issue/OPS-1/comment') return { status: 201, json: {} };
    if (c.url === '/rest/api/3/search') return { json: { issues: [issue('OLD-1')] } };
  });
  try {
    const server = createJiraClient({ baseUrl: j.baseUrl, pat: 'pat123' }, {});
    assert.equal(server.apiVersion, '2');
    assert.equal((await server.search('x'))[0].key, 'OPS-1');
    assert.equal(j.calls[0].auth, 'Bearer pat123');
    await server.addComment('OPS-1', '# heading stays text');
    assert.equal(j.calls[1].body.body, '# heading stays text');

    const oldCloud = createJiraClient({ baseUrl: j.baseUrl, pat: 'p', apiVersion: '3' }, {});
    assert.equal((await oldCloud.search('x'))[0].key, 'OLD-1'); // /search/jql answered 404, so it retried /search
  } finally { j.close(); }
});

test('writes are refused in read-only mode, previewed in dry run, and errors carry Jira\'s own words', async () => {
  const j = await fakeJira(c => (c.method === 'POST' && c.url.endsWith('/issue') ? { status: 400, json: { errors: { issuetype: 'The issue type selected is invalid.' } } } : null));
  try {
    const ro = createJiraClient({ baseUrl: j.baseUrl, pat: 'p', readOnly: true }, {});
    await assert.rejects(() => ro.addComment('A-1', 'x'), /read-only/);
    const dry = createJiraClient({ baseUrl: j.baseUrl, pat: 'p', dryRun: true }, {});
    const r = await dry.addComment('A-1', 'x');
    assert.equal(r.dryRun, true);
    assert.equal(j.calls.length, 0, 'neither mode may reach Jira');

    const live = createJiraClient({ baseUrl: j.baseUrl, pat: 'p' }, {});
    await assert.rejects(() => live.createIssue({ project: 'A', type: 'Nope', summary: 's' }), e => e instanceof JiraError && e.status === 400 && /issue type selected is invalid/.test(e.message));
    await assert.rejects(() => createJiraClient({}, {}).myself(), /not configured/);
  } finally { j.close(); }
});

test('simplifyIssue and toTicket: blocked only by unfinished "is blocked by" links', () => {
  const link = (dir, key, cat) => ({ type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, [dir]: { key, fields: { status: { name: cat, statusCategory: { name: cat } } } } });
  const t = toTicket(issue('ABC-1', { description: textToAdf('hello'), issuelinks: [link('inwardIssue', 'ABC-2', 'In Progress'), link('outwardIssue', 'ABC-3', 'To Do')] }), k => 'https://x/browse/' + k);
  assert.equal(t.blocked, true);
  assert.deepEqual(t.blockedBy, [{ key: 'ABC-2', status: 'In Progress' }]);
  assert.equal(t.description, 'hello');
  assert.equal(t.url, 'https://x/browse/ABC-1');
  assert.equal(toTicket(issue('ABC-1', { issuelinks: [link('inwardIssue', 'ABC-2', 'Done')] }), () => '').blocked, false);
  assert.equal(simplifyIssue(issue('ABC-1', { description: 'plain v2 text' })).description, 'plain v2 text');
});

test('CLI: search, view, create --dry-run and errors', async () => {
  const j = await fakeJira(c => {
    if (c.url === '/rest/api/2/search') return { json: { issues: [issue('OPS-1')] } };
    if (c.url.startsWith('/rest/api/2/issue/OPS-1?')) return { json: issue('OPS-1', { description: 'the description' }) };
  });
  const env = { JIRA_BASE_URL: j.baseUrl, JIRA_PAT: 'p', JIRA_ENV_FILE: '/nonexistent' };
  const run = async argv => { const lines = []; await main(argv, { out: l => lines.push(l), env }); return lines.join('\n'); };
  try {
    assert.match(await run(['search', 'project = OPS']), /OPS-1 {2}\[In Review\] \[High\] Story: S OPS-1/);
    assert.equal(JSON.parse(await run(['search', 'x', '--json']))[0].key, 'OPS-1');
    assert.match(await run(['view', 'OPS-1']), /the description/);
    const before = j.calls.length;
    assert.match(await run(['create', '--project', 'OPS', '--type', 'Bug', '--summary', 'Broken', '--dry-run']), /DRY RUN, nothing sent/);
    assert.equal(j.calls.length, before);
    await assert.rejects(() => run(['create', '--project', 'OPS']), /Missing --type/);
    await assert.rejects(() => run(['explode']), /Unknown command/);
    assert.match(await run(['--help']), /jira-stories/);
  } finally { j.close(); }
});

test('loadEnvFile reads KEY=VALUE lines and never overrides the real environment', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-env-')), '.env');
  fs.writeFileSync(file, '# comment\nJIRA_BASE_URL="https://a.example"\nexport JIRA_PAT=abc\nJIRA_EMAIL=from-file\n');
  const env = { JIRA_EMAIL: 'from-shell' };
  assert.equal(loadEnvFile(file, env), true);
  assert.deepEqual(env, { JIRA_EMAIL: 'from-shell', JIRA_BASE_URL: 'https://a.example', JIRA_PAT: 'abc' });
  assert.equal(loadEnvFile('/nope/.env', env), false);
});
