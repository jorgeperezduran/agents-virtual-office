import { run, clip } from '../util.js';

const LANG = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian' };

/** `claude --json-schema` wants closed objects with every property required. Crew files may be looser, so tighten them here. */
export function strictSchema(s) {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(strictSchema);
  const out = { ...s };
  if (out.type === 'object' && out.properties) {
    out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, strictSchema(v)]));
    out.required = Object.keys(out.properties);
    out.additionalProperties = false;
  }
  if (out.items) out.items = strictSchema(out.items);
  return out;
}

/**
 * Agents think through the local Claude Code CLI in headless mode. It reuses the Claude login on this machine.
 * tools: "none" (default) no tools at all, "read" can read the workspace, "write" can also create and edit files there.
 * No agent ever gets a shell, and none can read .env files.
 */
export function createBrain(cfg) {
  const language = LANG[cfg.language] || cfg.language || 'English';
  const timeoutMs = cfg.llm.timeoutMinutes * 60_000;

  return {
    async think({ persona, prompt, schema, tools = 'none', cwd, signal }) {
      const system = `${persona} Write in ${language}.`;
      const args = ['-p', '--model', cfg.llm.model, '--output-format', 'json', '--no-session-persistence',
        '--json-schema', JSON.stringify(strictSchema(schema)), '--max-budget-usd', String(cfg.llm.maxBudgetUsdPerCall)];
      if (tools === 'none' || !cwd) args.push('--setting-sources', '', '--tools', '', '--system-prompt', system);
      else {
        const list = tools === 'write' ? 'Read,Glob,Grep,Write,Edit' : 'Read,Glob,Grep';
        args.push('--setting-sources', 'project', '--tools', list, '--allowedTools', list, '--disallowedTools', 'Read(./.env*)',
          '--permission-mode', tools === 'write' ? 'acceptEdits' : 'default', '--append-system-prompt', system);
      }
      const r = await run('claude', args, { cwd: tools === 'none' ? undefined : cwd, input: prompt, signal, timeoutMs });
      let out;
      try { out = JSON.parse(r.stdout); } catch { throw new Error('Claude returned no JSON: ' + clip((r.stderr || r.stdout).trim(), 300)); }
      if (out.is_error || !out.structured_output) throw new Error('Claude call failed: ' + clip(out.result || out.subtype || 'no structured output', 300));
      return out.structured_output;
    },
  };
}
