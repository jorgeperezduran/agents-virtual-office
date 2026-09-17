#!/usr/bin/env node
/**
 * jira-stories: read and write Jira issues over the Jira REST API. Zero dependencies, Node 20+.
 * Works with Jira Cloud (API v3, email + API token) and Jira Server / Data Center (API v2, personal access token).
 *
 * Use it as a library:  import { createJiraClient } from './jira.mjs'
 * Or as a CLI:          node jira.mjs search "project = ABC AND sprint in openSprints()"
 *
 * Credentials come from the environment (or an env file):
 *   JIRA_BASE_URL   https://your-site.atlassian.net   or   https://jira.your-company.com
 *   JIRA_EMAIL + JIRA_API_TOKEN   (Cloud)      |      JIRA_PAT   (Server / Data Center)
 *   JIRA_API_VERSION  optional, "3" or "2"     |      JIRA_READ_ONLY=1  refuses every write
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export class JiraError extends Error {
  constructor(message, status, body) { super(message); this.name = 'JiraError'; this.status = status; this.body = body; }
}

/** Minimal KEY=VALUE env file loader. Existing environment variables win. */
export function loadEnvFile(file, env = process.env) {
  if (!file || !fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
  return true;
}

/* ---------- Atlassian Document Format ---------- */
export function adfToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  const kids = (n, sep = '') => (n.content || []).map(adfToText).join(sep);
  switch (node.type) {
    case 'doc': return kids(node, '\n').replace(/\n{3,}/g, '\n\n').trim();
    case 'text': return node.text || '';
    case 'hardBreak': return '\n';
    case 'paragraph': return kids(node) + '\n';
    case 'heading': return '#'.repeat(node.attrs?.level || 2) + ' ' + kids(node) + '\n';
    case 'bulletList': return (node.content || []).map(li => '- ' + adfToText(li).trim()).join('\n') + '\n';
    case 'orderedList': return (node.content || []).map((li, i) => `${i + 1}. ` + adfToText(li).trim()).join('\n') + '\n';
    case 'listItem': return kids(node, ' ');
    case 'codeBlock': return '```\n' + kids(node) + '\n```\n';
    case 'table': return kids(node, '\n') + '\n';
    case 'tableRow': return (node.content || []).map(c => adfToText(c).trim()).join(' | ');
    case 'tableHeader': case 'tableCell': return kids(node, ' ');
    case 'mention': return node.attrs?.text || '';
    case 'emoji': return node.attrs?.text || node.attrs?.shortName || '';
    case 'inlineCard': case 'blockCard': return node.attrs?.url || '';
    case 'rule': return '---\n';
    default: return kids(node);
  }
}

/** Plain text with light markdown (# headings, "- " bullets, "1. " lists, ``` code) to ADF. */
export function textToAdf(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const content = [];
  const t = s => (s ? [{ type: 'text', text: s }] : []);
  const item = s => ({ type: 'listItem', content: [{ type: 'paragraph', content: t(s) }] });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (line.trim().startsWith('```')) {
      const code = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++;
      content.push({ type: 'codeBlock', content: t(code.join('\n')) });
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { content.push({ type: 'heading', attrs: { level: h[1].length }, content: t(h[2]) }); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(item(lines[i++].replace(/^\s*[-*]\s+/, '')));
      content.push({ type: 'bulletList', content: items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(item(lines[i++].replace(/^\s*\d+[.)]\s+/, '')));
      content.push({ type: 'orderedList', content: items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*]\s+|\s*\d+[.)]\s+|\s*```)/.test(lines[i])) para.push(lines[i++]);
    const nodes = [];
    para.forEach((p, n) => { if (n) nodes.push({ type: 'hardBreak' }); nodes.push(...t(p)); });
    content.push({ type: 'paragraph', content: nodes });
  }
  if (!content.length) content.push({ type: 'paragraph', content: [] });
  return { type: 'doc', version: 1, content };
}

/* ---------- client ---------- */
export function createJiraClient(opts = {}, env = process.env) {
  const baseUrl = String(opts.baseUrl || env.JIRA_BASE_URL || '').replace(/\/+$/, '');
  const email = opts.email || env.JIRA_EMAIL;
  const token = opts.apiToken || env.JIRA_API_TOKEN;
  const pat = opts.pat || env.JIRA_PAT;
  const configured = !!baseUrl && (!!pat || (!!email && !!token));
  const cloud = /\.atlassian\.net$/i.test(baseUrl ? new URL(baseUrl).hostname : '');
  const v = String(opts.apiVersion || env.JIRA_API_VERSION || (cloud ? '3' : '2'));
  const readOnly = opts.readOnly ?? env.JIRA_READ_ONLY === '1';
  const dryRun = !!opts.dryRun;
  const fetchFn = opts.fetch || fetch;
  const api = `/rest/api/${v}`;
  const body = text => (v === '3' ? textToAdf(text) : String(text ?? ''));

  async function request(method, p, payload) {
    if (!configured) throw new JiraError('Jira is not configured. Set JIRA_BASE_URL and JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server).', 0);
    const write = method !== 'GET' && !p.includes('/search');
    if (write && readOnly) throw new JiraError('Jira is in read-only mode (JIRA_READ_ONLY=1). Nothing was written.', 0);
    if (write && dryRun) return { dryRun: true, method, path: p, payload };
    const auth = pat ? `Bearer ${pat}` : 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const res = await fetchFn(baseUrl + p, {
      method, headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload), signal: opts.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!res.ok) {
      const msgs = [...(data?.errorMessages || []), ...Object.entries(data?.errors || {}).map(([k, m]) => `${k}: ${m}`)];
      throw new JiraError(`Jira ${method} ${p.split('?')[0]} failed (${res.status})${msgs.length ? ': ' + msgs.join('; ') : ''}`, res.status, data);
    }
    return data;
  }

  const DEFAULT_FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'assignee', 'reporter', 'labels', 'parent', 'issuelinks', 'subtasks', 'created', 'updated'];

  return {
    configured, baseUrl, apiVersion: v, cloud, readOnly,
    browseUrl: key => (baseUrl ? `${baseUrl}/browse/${key}` : ''),
    myself: () => request('GET', `${api}/myself`),

    async search(jql, { fields = DEFAULT_FIELDS, maxResults = 50 } = {}) {
      if (v === '3') {
        try { return (await request('POST', `${api}/search/jql`, { jql, maxResults, fields })).issues || []; } catch (e) {
          if (![404, 405].includes(e.status)) throw e; // older Cloud sites and proxies only know /search
        }
      }
      return (await request('POST', `${api}/search`, { jql, maxResults, fields })).issues || [];
    },

    getIssue: (key, fields = DEFAULT_FIELDS) => request('GET', `${api}/issue/${encodeURIComponent(key)}?fields=${fields.join(',')}`),

    createIssue({ project, type, summary, description, priority, labels, parent, assignee, fields: extra }) {
      const fields = { project: { key: project }, issuetype: { name: type }, summary, ...extra };
      if (description) fields.description = body(description);
      if (priority) fields.priority = { name: priority };
      if (labels?.length) fields.labels = labels;
      if (parent) fields.parent = { key: parent };
      if (assignee) fields.assignee = v === '3' ? { accountId: assignee } : { name: assignee };
      return request('POST', `${api}/issue`, { fields });
    },

    updateIssue(key, { summary, description, priority, labels, fields: extra }) {
      const fields = { ...extra };
      if (summary) fields.summary = summary;
      if (description != null) fields.description = body(description);
      if (priority) fields.priority = { name: priority };
      if (labels) fields.labels = labels;
      return request('PUT', `${api}/issue/${encodeURIComponent(key)}`, { fields });
    },

    addComment: (key, text) => request('POST', `${api}/issue/${encodeURIComponent(key)}/comment`, { body: body(text) }),

    async getTransitions(key) { return (await request('GET', `${api}/issue/${encodeURIComponent(key)}/transitions`)).transitions || []; },

    async transition(key, stateName) {
      const all = await this.getTransitions(key);
      const want = String(stateName).toLowerCase();
      const t = all.find(x => x.name.toLowerCase() === want) || all.find(x => x.to?.name?.toLowerCase() === want);
      if (!t) throw new JiraError(`No transition to "${stateName}" from the current status of ${key}. Available: ${all.map(x => x.name).join(', ') || 'none'}`, 0);
      return request('POST', `${api}/issue/${encodeURIComponent(key)}/transitions`, { transition: { id: t.id } });
    },

    /** "inward blocks outward" when type is Blocks. */
    link: (inwardKey, outwardKey, type = 'Relates') => request('POST', `${api}/issueLink`, { type: { name: type }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } }),
  };
}

/** A compact, tool-friendly view of an issue. */
export function simplifyIssue(issue, browse = () => '') {
  const f = issue.fields || {};
  const desc = typeof f.description === 'string' ? f.description : adfToText(f.description);
  return {
    key: issue.key, url: browse(issue.key), summary: f.summary || '', type: f.issuetype?.name || '', status: f.status?.name || '',
    statusCategory: f.status?.statusCategory?.name || '', priority: f.priority?.name || '', assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null, labels: f.labels || [], parent: f.parent?.key || null, description: desc,
    subtasks: (f.subtasks || []).map(s => ({ key: s.key, summary: s.fields?.summary, status: s.fields?.status?.name })),
    links: (f.issuelinks || []).map(l => l.inwardIssue
      ? { relation: l.type?.inward || l.type?.name, key: l.inwardIssue.key, status: l.inwardIssue.fields?.status?.name, statusCategory: l.inwardIssue.fields?.status?.statusCategory?.name }
      : { relation: l.type?.outward || l.type?.name, key: l.outwardIssue?.key, status: l.outwardIssue?.fields?.status?.name, statusCategory: l.outwardIssue?.fields?.status?.statusCategory?.name }),
  };
}

/* ---------- CLI ---------- */
const HELP = `jira-stories: read and write Jira issues

  whoami
  search "<JQL>" [--max 25]
  view KEY
  create --project ABC --type Story --summary "..." [--description "..." | --description-file f.md]
         [--priority High] [--labels a,b] [--parent ABC-1]
  update KEY [--summary "..."] [--description "..." | --description-file f.md] [--priority High] [--labels a,b]
  comment KEY "text" | --file f.md
  transitions KEY
  transition KEY "In Progress"
  link INWARD-KEY OUTWARD-KEY [--type Blocks]      (INWARD blocks OUTWARD)

Global flags: --json   --dry-run (print the write instead of sending it)   --env-file path
Credentials: JIRA_BASE_URL plus JIRA_EMAIL + JIRA_API_TOKEN (Cloud) or JIRA_PAT (Server / Data Center).`;

export function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['json', 'dry-run', 'help'].includes(k)) flags[k] = true;
      else flags[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

export async function main(argv, { out = console.log, env = process.env } = {}) {
  const { pos, flags } = parseArgs(argv);
  const [cmd, a, b] = pos;
  if (!cmd || flags.help || cmd === 'help') { out(HELP); return 0; }
  loadEnvFile(flags['env-file'] || env.JIRA_ENV_FILE || path.resolve('.env'), env);
  const jira = createJiraClient({ dryRun: !!flags['dry-run'] }, env);
  const text = (inline, fileFlag) => (flags[fileFlag] ? fs.readFileSync(flags[fileFlag], 'utf8') : inline);
  const list = s => (s ? String(s).split(',').map(x => x.trim()).filter(Boolean) : undefined);
  const need = (v, what) => { if (!v) throw new JiraError(`Missing ${what}. Run with --help.`, 0); return v; };
  const show = (data, human) => out(flags.json || !human ? JSON.stringify(data, null, 2) : human);
  const wrote = (r, msg) => show(r, r?.dryRun ? `DRY RUN, nothing sent:\n${JSON.stringify(r, null, 2)}` : msg);

  switch (cmd) {
    case 'whoami': { const me = await jira.myself(); return show(me, `${me.displayName} <${me.emailAddress || me.name || me.accountId}> on ${jira.baseUrl} (API v${jira.apiVersion})`), 0; }
    case 'search': {
      const issues = (await jira.search(need(a, 'JQL'), { maxResults: Number(flags.max) || 25 })).map(i => simplifyIssue(i, jira.browseUrl));
      return show(issues, issues.length ? issues.map(i => `${i.key}  [${i.status}] [${i.priority}] ${i.type}: ${i.summary}${i.assignee ? '  (' + i.assignee + ')' : ''}`).join('\n') : 'No issues found.'), 0;
    }
    case 'view': {
      const i = simplifyIssue(await jira.getIssue(need(a, 'issue key')), jira.browseUrl);
      const human = [`${i.key}  ${i.summary}`, `${i.type} | ${i.status} | ${i.priority} | assignee: ${i.assignee || 'none'}${i.parent ? ' | parent: ' + i.parent : ''}`, i.url,
        i.labels.length ? 'labels: ' + i.labels.join(', ') : '', '', i.description || '(no description)',
        i.subtasks.length ? '\nSub-tasks:\n' + i.subtasks.map(s => `- ${s.key} [${s.status}] ${s.summary}`).join('\n') : '',
        i.links.length ? '\nLinks:\n' + i.links.map(l => `- ${l.relation} ${l.key} [${l.status}]`).join('\n') : ''].filter(x => x !== '').join('\n');
      return show(i, human), 0;
    }
    case 'create': {
      const r = await jira.createIssue({ project: need(flags.project, '--project'), type: need(flags.type, '--type'), summary: need(flags.summary, '--summary'),
        description: text(flags.description, 'description-file'), priority: flags.priority, labels: list(flags.labels), parent: flags.parent });
      return wrote(r, `Created ${r.key}  ${jira.browseUrl(r.key)}`), 0;
    }
    case 'update': {
      const r = await jira.updateIssue(need(a, 'issue key'), { summary: flags.summary, description: text(flags.description, 'description-file'), priority: flags.priority, labels: list(flags.labels) });
      return wrote(r, `Updated ${a}`), 0;
    }
    case 'comment': { const r = await jira.addComment(need(a, 'issue key'), need(text(b, 'file'), 'comment text')); return wrote(r, `Commented on ${a}`), 0; }
    case 'transitions': { const t = await jira.getTransitions(need(a, 'issue key')); return show(t, t.map(x => `${x.name} -> ${x.to?.name}`).join('\n') || 'No transitions available.'), 0; }
    case 'transition': { const r = await jira.transition(need(a, 'issue key'), need(b, 'target state')); return wrote(r, `Moved ${a} to ${b}`), 0; }
    case 'link': { const r = await jira.link(need(a, 'inward key'), need(b, 'outward key'), flags.type || 'Relates'); return wrote(r, `Linked ${a} -> ${b} (${flags.type || 'Relates'})`), 0; }
    default: throw new JiraError(`Unknown command "${cmd}". Run with --help.`, 0);
  }
}

const invoked = process.argv[1] ? pathToFileURL(fs.realpathSync(process.argv[1])).href : '';
if (invoked === pathToFileURL(fs.realpathSync(new URL(import.meta.url).pathname)).href) {
  main(process.argv.slice(2)).then(code => process.exit(code || 0)).catch(e => { console.error(e.name === 'JiraError' ? e.message : e); process.exit(1); });
}
