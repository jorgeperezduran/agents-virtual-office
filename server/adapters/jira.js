import { createJiraClient, simplifyIssue } from '../../skills/jira-stories/scripts/jira.mjs';

/** A ticket is blocked when an unfinished issue "blocks" it. Uses status categories, so it works on any Jira site. */
export function toTicket(issue, browse) {
  const t = simplifyIssue(issue, browse);
  const blockedBy = t.links
    .filter(l => /is blocked by/i.test(l.relation || '') && !/^done$/i.test(l.statusCategory || '') && !/^(done|closed|resolved)$/i.test(l.status || ''))
    .map(l => ({ key: l.key, status: l.status }));
  return { ...t, blocked: blockedBy.length > 0, blockedBy, selectable: true };
}

/** The office's view of Jira: reads always, writes only when jira.writeEnabled is true. Writes are called after a human approval. */
export function createJira(cfg, clientOpts = {}) {
  const client = createJiraClient(clientOpts);
  const canWrite = !!cfg.jira.writeEnabled && !client.readOnly;
  const dry = extra => ({ dryRun: true, ...extra });

  return {
    ready: client.configured,
    writeEnabled: canWrite,
    site: client.baseUrl,
    async search(jql) {
      const issues = await client.search(jql, { maxResults: cfg.jira.maxResults });
      return issues.map(i => toTicket(i, client.browseUrl));
    },
    async comment(key, body) {
      if (!canWrite) return dry();
      await client.addComment(key, body);
      return { dryRun: false };
    },
    async update(key, fields) {
      if (!canWrite) return dry();
      await client.updateIssue(key, fields);
      return { dryRun: false };
    },
    async transition(key, to) {
      if (!canWrite) return dry();
      await client.transition(key, to);
      return { dryRun: false };
    },
    async link(inward, outward, type) {
      if (!canWrite) return dry();
      await client.link(inward, outward, type);
      return { dryRun: false };
    },
    /** Creates one issue per item. Stops at the first failure and reports what was created before it. */
    async create(items, { linkTo, linkType } = {}) {
      if (!canWrite) return dry({ keys: [], count: items.length });
      const keys = [];
      for (const it of items) {
        const r = await client.createIssue({ project: cfg.jira.project, ...it });
        keys.push(r.key);
        if (linkTo && linkType) { try { await client.link(r.key, linkTo, linkType); } catch { /* the issue exists; a missing link is not worth failing for */ } }
      }
      return { dryRun: false, keys, count: keys.length, urls: keys.map(client.browseUrl) };
    },
  };
}
