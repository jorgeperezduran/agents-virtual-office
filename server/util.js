import { spawn } from 'node:child_process';

export class ResetError extends Error {
  constructor() { super('reset'); this.name = 'ResetError'; }
}

export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new ResetError());
  const onAbort = () => { clearTimeout(t); reject(new ResetError()); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

/**
 * Run a command without a shell. Resolves with { code, stdout, stderr } and does not
 * reject on a non-zero exit. Rejects on spawn failure, timeout, or abort.
 */
export function run(cmd, args, { cwd, env, input, signal, timeoutMs, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ResetError());
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', done = false, timer = null;
    const onAbort = () => { child.kill('SIGTERM'); finish(reject, new ResetError()); };
    function finish(fn, v) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish(reject, new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    }
    child.stdout.on('data', d => { const s = d.toString(); stdout += s; onStdout?.(s); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => finish(reject, e));
    child.on('close', code => finish(resolve, { code, stdout, stderr }));
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*[A-Za-z]', 'g');
export const stripAnsi = s => String(s ?? '').replace(ANSI, '');

export function parseJsonLoose(text) {
  const s = String(text);
  const i = s.search(/[\[{]/);
  if (i < 0) throw new Error('No JSON found in output: ' + s.slice(0, 200));
  return JSON.parse(s.slice(i));
}

export { adfToText } from '../skills/jira-stories/scripts/jira.mjs';

export const clip = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
