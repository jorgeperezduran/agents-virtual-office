import fs from 'node:fs';
import path from 'node:path';
import { run, stripAnsi, clip } from '../util.js';
import { ROOT, assertSafeCommand } from '../config.js';

/** Totals and failures from Playwright's JSON reporter. */
export function summarizePlaywright(report) {
  const failures = [];
  let total = 0, passed = 0, failed = 0, skipped = 0, flaky = 0;
  const walk = (suite, file) => {
    const f = suite.file || file;
    for (const spec of suite.specs || []) for (const t of spec.tests || []) {
      total++;
      if (t.status === 'expected') passed++;
      else if (t.status === 'flaky') { passed++; flaky++; }
      else if (t.status === 'skipped') skipped++;
      else {
        failed++;
        const last = (t.results || []).at(-1) || {};
        const msg = last.error?.message || (last.errors || []).map(e => e.message).join('\n') || last.status || 'failed';
        failures.push({ title: spec.title, file: spec.file || f || '', error: clip(stripAnsi(msg), 2000) });
      }
    }
    for (const s of suite.suites || []) walk(s, f);
  };
  for (const s of report.suites || []) walk(s, s.file);
  return { total, passed, failed, skipped, flaky, failures };
}

/** Values that came out of a model may only become arguments when they are real files inside the workspace. */
export function safeFiles(files, repoDir) {
  const root = path.resolve(repoDir);
  const ok = [], rejected = [];
  for (const f of files) {
    const abs = path.resolve(root, String(f));
    if (typeof f !== 'string' || f.startsWith('-') || !(abs + path.sep).startsWith(root + path.sep) || !fs.existsSync(abs)) rejected.push(String(f));
    else ok.push(path.relative(root, abs));
  }
  return { ok: [...new Set(ok)], rejected };
}

export function describeRun(r) {
  if (!r.executed) return `Not executed: ${r.reason}`;
  if (r.total) return r.failed ? `${r.failed} of ${r.total} tests failed` : `All ${r.total - r.skipped} executed tests passed${r.skipped ? `, ${r.skipped} skipped` : ''}${r.flaky ? `, ${r.flaky} only on retry` : ''}`;
  return r.failed ? `The command failed with exit code ${r.exitCode}` : 'The command succeeded';
}

export function createCommands(cfg) {
  const repoDir = cfg.workspace.repoDir;
  const ready = () => !!repoDir && fs.existsSync(repoDir);

  async function gitStatus(signal) {
    const map = new Map();
    if (!ready()) return map;
    const r = await run('git', ['status', '--porcelain', '-uall'], { cwd: repoDir, signal, timeoutMs: 30_000 }).catch(() => ({ stdout: '' }));
    for (const line of r.stdout.split('\n')) if (line.trim()) map.set(line.slice(3).trim(), line.slice(0, 2).trim());
    return map;
  }

  return {
    ready, repoDir, gitStatus,
    has: name => !!cfg.commands[name],

    async changesSince(before, signal) {
      const created = [], modified = [];
      for (const [file, st] of await gitStatus(signal)) if (!before.has(file)) (st === '??' || st === 'A' ? created : modified).push(file);
      return { created, modified };
    },

    /** The exact argv that would run, with {{files}} expanded. Shown to the human before anything runs. */
    plan(name, files = []) {
      const c = cfg.commands[name];
      assertSafeCommand(name, c, cfg.safety.forbiddenPattern);
      const { ok, rejected } = ready() ? safeFiles(files, repoDir) : { ok: [], rejected: files };
      const argv = c.argv.flatMap(a => (a === '{{files}}' ? ok : [a]));
      const envText = Object.entries(c.env || {}).map(([k, v]) => `${k}=${v} `).join('');
      return { argv, files: ok, rejected, display: envText + argv.join(' '), cwd: repoDir };
    },

    async run(name, files, { ticketKey, onProgress, signal } = {}) {
      const c = cfg.commands[name];
      const p = this.plan(name, files);
      const outDir = path.join(ROOT, 'runs', `${ticketKey || 'run'}-${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fs.mkdirSync(outDir, { recursive: true });
      const reportFile = path.join(outDir, 'report.json');
      let buf = '';
      const r = await run(p.argv[0], p.argv.slice(1), {
        cwd: repoDir, signal, timeoutMs: (c.timeoutMinutes || 30) * 60_000,
        env: { ...(c.env || {}), PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile, PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile, PW_TEST_HTML_REPORT_OPEN: 'never' },
        onStdout: chunk => {
          buf = (buf + stripAnsi(chunk)).slice(-400);
          const all = [...buf.matchAll(/\[(\d+)\/(\d+)\]/g)];
          if (all.length) onProgress?.(Number(all.at(-1)[1]), Number(all.at(-1)[2]));
        },
      });
      const output = stripAnsi(r.stdout + '\n' + r.stderr).trim();
      fs.writeFileSync(path.join(outDir, 'output.log'), output);
      let res = { total: 0, passed: 0, failed: r.code === 0 ? 0 : 1, skipped: 0, flaky: 0, failures: [] };
      if (c.parse === 'playwright-json' && fs.existsSync(reportFile)) res = summarizePlaywright(JSON.parse(fs.readFileSync(reportFile, 'utf8')));
      if (r.code !== 0 && !res.failures.length) res.failures = [{ title: `${name} exited with code ${r.code}`, file: '', error: clip(output.slice(-2000), 2000) }], res.failed = res.failed || 1;
      const result = { executed: true, exitCode: r.code, ...res, outputTail: clip(output.slice(-1500), 1500), reportDir: path.relative(ROOT, outDir) };
      return { ...result, summary: describeRun(result) };
    },
  };
}
