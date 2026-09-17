import { sleep } from '../util.js';
import { describeRun } from './commands.js';

/** A simulated sprint, so any crew (built-in or generated) can be tried with no Jira, no model and no side effects. */
export const FIXTURES = [
  { key: 'DEMO-101', summary: 'Retry card payment when the first provider times out', type: 'Story', status: 'In Review', statusCategory: 'In Progress', priority: 'Highest',
    description: 'As a payer I want my payment retried through the backup provider when the first one times out.\n\nAcceptance criteria:\n- Retries once through the backup provider\n- The payer is charged only once\n- The retry keeps the original transaction ID' },
  { key: 'DEMO-102', summary: 'Split a tuition payment across two cards', type: 'Story', status: 'In Progress', statusCategory: 'In Progress', priority: 'High',
    description: 'A parent can split one tuition payment across two cards.\n\nAcceptance criteria:\n- If either card is declined, no card stays charged\n- The school sees one payment in reconciliation' },
  { key: 'DEMO-103', summary: 'Map the new decline codes from the backup provider', type: 'Task', status: 'In Review', statusCategory: 'In Progress', priority: 'High',
    description: 'Codes 05, 51 and 61 map to our decline reasons. Unknown codes map to generic_decline and are logged.' },
  { key: 'DEMO-104', summary: 'Export includes refunded fees', type: 'Story', status: 'To Do', statusCategory: 'To Do', priority: 'Medium',
    description: 'Refunded fees appear in the daily export with a refund flag. Totals match the finance report.' },
  { key: 'DEMO-105', summary: 'Require an idempotency key on POST /payments', type: 'Story', status: 'In Progress', statusCategory: 'In Progress', priority: 'High',
    description: 'Blocked until the gateway configuration is deployed.', blockedBy: [{ key: 'DEMO-099', status: 'In Progress' }] },
];

/** Build a believable value for any JSON schema, so mock mode can play crews it has never seen. */
export function fake(schema, name = 'value', ticket = {}, n = 1) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, fake(v, k, ticket, n)]));
    case 'array': return [1, 2, 3].map(i => fake(schema.items, name.replace(/s$/, ''), ticket, i));
    case 'boolean': return false;
    case 'number': case 'integer': return n;
    default:
      if (/file|path/i.test(name)) return `tests/${String(ticket.key || 'demo').toLowerCase()}-${n}.spec.ts`;
      return `Sample ${name.replace(/([A-Z])/g, ' $1').toLowerCase()} ${n} for ${ticket.key || 'the ticket'}`;
  }
}

export function createMock(getSpeed = () => 1) {
  const nap = (ms, signal) => sleep(ms / getSpeed(), signal);
  let seq = 200;

  const jira = {
    ready: true, writeEnabled: true, site: '(simulated Jira)',
    async search(_jql) {
      await nap(1800);
      return FIXTURES.map(f => ({ ...f, url: '', assignee: null, reporter: null, labels: [], parent: null, subtasks: [], links: [],
        blockedBy: f.blockedBy || [], blocked: !!f.blockedBy, selectable: !f.blockedBy }));
    },
    async comment() { await nap(1200); return { dryRun: false }; },
    async update() { await nap(1200); return { dryRun: false }; },
    async transition() { await nap(800); return { dryRun: false }; },
    async link() { await nap(800); return { dryRun: false }; },
    async create(items) { await nap(1400); const keys = items.map(() => `DEMO-${seq++}`); return { dryRun: false, keys, count: keys.length, urls: [] }; },
  };

  const brain = {
    async think({ prompt, schema, signal, mockTicket, mockKind }) {
      await nap(2000, signal);
      if (mockKind === 'rank') {
        return { ranked: FIXTURES.map(f => ({ key: f.key, why: f.blockedBy ? 'Blocked, so it goes last.' : `${f.priority} priority and ${f.status.toLowerCase()}.`, actionable: true })) };
      }
      if (schema?.properties?.teamJson) return { teamJson: JSON.stringify(sampleCustomTeam(prompt)), notes: 'A simulated crew. Run the office in live mode to have Claude design one for your role.' };
      return fake(schema, 'value', mockTicket || {});
    },
  };

  const commands = {
    ready: () => true, repoDir: '(simulated workspace)', has: () => true,
    async gitStatus() { return new Map(); },
    async changesSince() { return { created: [], modified: [] }; },
    plan: (name, files = []) => ({ argv: ['npm', 'run', name, '--', ...files], files, rejected: [], display: `npm run ${name} -- ${files.join(' ')}`.trim(), cwd: '(simulated workspace)' }),
    async run(name, files, { ticketKey, onProgress, signal } = {}) {
      const total = 12 + files.length * 6;
      for (let i = 1; i <= 4; i++) { await nap(700, signal); onProgress?.(Math.round(total * i / 4), total); }
      const fails = ticketKey === 'DEMO-102'
        ? [{ title: 'Second card declined voids the first charge', file: files[0] || 'tests/demo.spec.ts', error: 'Expected the first charge to be voided, but it is still captured.' }]
        : [];
      const r = { executed: true, exitCode: fails.length ? 1 : 0, total, passed: total - fails.length, failed: fails.length, skipped: 0, flaky: 0, failures: fails, outputTail: '', reportDir: '(simulated)' };
      return { ...r, summary: describeRun(r) };
    },
  };

  return { jira, brain, commands };
}

function sampleCustomTeam(prompt) {
  const id = (prompt.match(/crew id must be exactly "([^"]+)"/) || [])[1] || 'custom-crew';
  const role = ((prompt.match(/Their role: (.*)/) || [])[1] || 'Specialist').trim();
  const str = { type: 'string' };
  return {
    id, name: `${role} crew`, role, description: `A simulated crew for a ${role}.`,
    agents: [{ id: 'nia', name: 'Nia', title: 'Planner' }, { id: 'leo', name: 'Leo', title: 'Specialist' }],
    briefing: { agent: 'nia', jql: 'project = {{project}} AND {{scope}} AND statusCategory != Done ORDER BY priority DESC', rankPrompt: `Rank these tickets for a ${role}.` },
    workflow: [
      { id: 'analyze', type: 'think', agent: 'leo', station: 'terminal', label: 'Analyze the ticket', prompt: 'Analyze {{ticket.key}}: {{ticket.summary}}\n{{ticket.description}}', save: 'analysis',
        schema: { type: 'object', properties: { findings: { type: 'array', items: str }, recommendation: str } }, show: [{ title: 'Findings', path: 'analysis.findings' }] },
      { id: 'share', type: 'jira', agent: 'leo', label: 'Share the analysis in Jira', action: 'comment', body: 'Analysis\n{{analysis.findings}}\n\nRecommendation: {{analysis.recommendation}}' },
      { id: 'done', type: 'end', result: { label: 'Analysis shared', tone: 'ok' } },
    ],
  };
}
