import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { loadConfig, ROOT } from './config.js';
import { Hub, validateEvent } from './hub.js';
import { Office } from './engine.js';
import { TeamStore } from './teams.js';
import { createJira } from './adapters/jira.js';
import { createBrain } from './adapters/brain.js';
import { createCommands } from './adapters/commands.js';
import { createMock } from './adapters/mock.js';

const HOST = '127.0.0.1';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function createApp(cfg, { store = new TeamStore(), dataDir = path.join(ROOT, 'data'), adapters = null } = {}) {
  let office;
  adapters ||= cfg.mode === 'mock'
    ? createMock(() => office?.speed || 1)
    : { jira: createJira(cfg), brain: createBrain(cfg), commands: createCommands(cfg) };
  const hub = new Hub({});
  office = new Office({ cfg, hub, store, dataDir, ...adapters });
  hub.state = office.initialState();

  /** Only pages served by this server may open a socket or post events. */
  const localOrigin = origin => {
    if (!origin) return true; // curl, scripts and agents send no Origin
    try { const u = new URL(origin); return ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port) === cfg.port; } catch { return false; }
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (req.method === 'POST' && url.pathname === '/events') {
      if (!localOrigin(req.headers.origin) || !/application\/json/.test(req.headers['content-type'] || '')) return json(403, { error: 'forbidden' });
      let body = '';
      req.on('data', c => { body += c; if (body.length > 64_000) req.destroy(); });
      req.on('end', () => {
        let e;
        try { e = JSON.parse(body); } catch { return json(400, { error: 'invalid JSON' }); }
        const err = validateEvent(e);
        if (err) return json(400, { error: err });
        json(200, { ok: true, event: hub.emit(e) });
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/state') return json(200, { state: hub.state, log: hub.log });
    if (req.method !== 'GET') return json(405, { error: 'method not allowed' });

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.join(ROOT, 'public', path.normalize(rel));
    if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return json(404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server, path: '/ws', verifyClient: info => localOrigin(info.origin) });
  wss.on('connection', ws => {
    const send = msg => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
    const remove = hub.addClient(send);
    ws.on('close', remove);
    ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.kind === 'event') { // an external agent reporting in
        const err = validateEvent(m.event);
        return err ? send({ kind: 'error', error: err }) : void hub.emit(m.event);
      }
      switch (m.cmd) {
        case 'selectTeam': return void office.selectTeam(String(m.id || ''));
        case 'changeTeam': return void office.changeTeam();
        case 'createTeam': return void office.createTeam({ role: m.role, day: m.day });
        case 'startDay': return void office.startDay();
        case 'selectTicket': return void office.selectTicket(String(m.key || ''));
        case 'decide': return void office.decide(String(m.action || ''), { input: m.input });
        case 'reset': return void office.reset();
        case 'speed': office.speed = [1, 2, 4].includes(m.value) ? m.value : 1; return;
        default: send({ kind: 'error', error: 'unknown command' });
      }
    });
  });

  return { server, hub, office, close: () => { office.init(); wss.close(); server.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'server/index.js')) {
  const cfg = loadConfig();
  const app = createApp(cfg);
  app.server.listen(cfg.port, HOST, () => {
    const s = app.hub.state;
    console.log(`QA Office is open at http://${HOST}:${cfg.port}  (${cfg.mode} mode)`);
    if (cfg.mode === 'live') {
      console.log(`  Jira:      ${s.jiraReady ? `${s.jiraSite}, project ${cfg.jira.project || '(set jira.project)'}` : 'not connected. Copy .env.example to .env and fill it in.'}`);
      console.log(`  Writes:    ${s.dryRun ? 'OFF (dry run). Set jira.writeEnabled to true to let approved actions reach Jira.' : 'ON, after your approval in the office'}`);
      console.log(`  Workspace: ${s.workspaceReady ? cfg.workspace.repoDir : 'none (agents that need code are skipped)'}`);
      console.log(`  Crew:      ${s.team ? s.team.name : 'not chosen yet, pick one in the office'}`);
    }
    for (const p of s.teamProblems) console.warn('  Crew file skipped: ' + p);
  });
}
