---
name: jira-stories
description: Read and write Jira issues (stories, bugs, tasks, sub-tasks, epics) on any Jira Cloud or Jira Server / Data Center site through the Jira REST API, with no company-specific tooling. Use it whenever the user wants to search Jira with JQL, see what is in a sprint, view a ticket, create a story or bug, break a story into sub-tasks, update a summary or description, add a comment, move a ticket to another status, or link two issues. Trigger on phrases like "what's in the sprint", "show me ABC-123", "create a story for", "file a bug", "add a comment to", "move it to In Progress", "split this story", "link these tickets", or any Jira task.
---

# jira-stories

One script, no dependencies: `scripts/jira.mjs` next to this file. Run it with Node 20 or newer. Resolve the path from this skill's folder.

```bash
node <skill-dir>/scripts/jira.mjs --help
```

## Setup (once)

The script reads credentials from the environment, or from an env file passed with `--env-file` (it also picks up `./.env`).

| Jira | Variables |
|---|---|
| Cloud (`*.atlassian.net`) | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (create one at id.atlassian.com, Security, API tokens) |
| Server / Data Center | `JIRA_BASE_URL`, `JIRA_PAT` (profile, Personal Access Tokens) |

Optional: `JIRA_API_VERSION` (`3` or `2`; detected from the URL), `JIRA_READ_ONLY=1` to refuse every write.

Check the connection first: `node <skill-dir>/scripts/jira.mjs whoami`. If it fails, tell the user which variable is missing. Never ask the user to paste a token into the chat, and never print one.

## Reading

```bash
jira.mjs search "project = ABC AND sprint in openSprints() ORDER BY priority DESC" --max 30
jira.mjs search "assignee = currentUser() AND statusCategory != Done" --json
jira.mjs view ABC-123
jira.mjs transitions ABC-123
```

Add `--json` when you need to process the result. Statuses differ between sites, so prefer `statusCategory` (`"To Do"`, `"In Progress"`, `Done`) in JQL unless the user names a status.

## Writing

Writes change shared data that other people see. Before any write, show the user exactly what you will create or change and wait for a yes, unless they already gave the exact text and target. When unsure, run the same command with `--dry-run` first: it prints the request and sends nothing.

```bash
jira.mjs create --project ABC --type Story --summary "Parent can split tuition across two cards" --description-file story.md --labels payments
jira.mjs create --project ABC --type Sub-task --parent ABC-123 --summary "Add void on second decline"
jira.mjs update ABC-123 --description-file refined.md
jira.mjs comment ABC-123 "QA sign-off: 31 tests passed in staging."
jira.mjs transition ABC-123 "In Review"
jira.mjs link ABC-200 ABC-123 --type Blocks        # ABC-200 blocks ABC-123
```

Descriptions and comments accept plain text with light markdown: `#` headings, `- ` bullets, `1. ` numbered lists and fenced code. The script converts it to Atlassian Document Format on Cloud and sends it as text on Server. Put long text in a file and pass `--description-file` or `--file`.

## Writing good stories

- Summary: one line, outcome first. For a story, "As a <who>, I want <what>, so that <why>" belongs in the description, not the summary.
- Description: context, then acceptance criteria as a bullet list that a tester can check one by one, then out of scope.
- A bug needs steps to reproduce, expected, actual, environment and evidence.
- Sub-task type names vary (`Sub-task`, `Subtask`). If `create` fails on the type, read the error: Jira lists what it expected.
- `update --description` replaces the whole description. Read the current one with `view` first and keep what must stay.

## Errors

The script prints Jira's own error text. 401 means bad credentials, 403 missing permission, 404 a wrong key or a project you cannot see, and 400 usually names the field Jira rejected.
