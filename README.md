# Agents Office

A pixel-art office run by a crew of AI agents that works your Jira tickets with you. You pick the crew that fits your role, or describe your role and have a crew designed for you. The office only moves in response to events, and **nothing is run or written to Jira without your approval.**

It works with any Jira Cloud, Server or Data Center site through the Jira REST API. No company-specific tooling is needed.

## Quick start

```bash
npm install
npm run mock            # a simulated sprint: no Jira, no model, no side effects
```

Open http://127.0.0.1:4488, pick a crew, start the day.

For the real office:

```bash
cp .env.example .env    # fill in your Jira site and credentials
# set "jira.project" in office.config.json to your project key
npm start
```

Requirements: Node 20 or newer, and the [Claude Code](https://claude.com/claude-code) CLI logged in (`claude --version`). The agents think through `claude -p`, so they use the login already on the machine and no API key is needed.

## Crews

| Crew | For | What it does with a ticket |
|---|---|---|
| QA crew | QA engineer | Picks regression suites, writes test cases, writes automated tests in your repo, runs them, then drafts the sign-off comment or the bug. |
| Developer crew | Software developer | Reads the story and the code, plans the change with risks and test ideas, posts the plan, creates the sub-tasks. |
| Product crew | Product owner | Rewrites unready stories with testable acceptance criteria and proposes how to split large ones. |
| Your own | Any role | On the crew picker, fill in "Create my own crew". Claude designs a crew for your role, the office validates it, saves it to `teams/custom/` and selects it. |

[docs/example-generated-crew.json](docs/example-generated-crew.json) is what Claude designed, unedited, for the role "DevOps engineer". Copy it into `teams/custom/` to try it.

A crew is a JSON file. You can edit a generated crew, copy a built-in one, or write one from scratch: see [docs/TEAMS.md](docs/TEAMS.md). Use "Change crew" in the header to switch.

## What keeps it safe

- **Every Jira write and every command stops for your approval.** The engine enforces this, so a crew file, hand-written or generated, cannot skip it. You see exactly what will be written and can edit comments and descriptions first.
- **Jira starts in dry run.** `jira.writeEnabled` is `false`: approved writes are drafted and not sent. Set it to `true` when you trust the drafts. `JIRA_READ_ONLY=1` in `.env` blocks writes whatever the config says.
- **Commands come from your config file only.** A crew names a command (`"test"`); it cannot define one. Model output becomes a command argument only when it is an existing file inside your workspace. Anything matching `safety.forbiddenPattern` (default `prod`) is refused at startup.
- **Agents have no shell.** Most have no tools at all. Steps marked `read` can read your workspace; steps marked `write` can also create and edit files there. None can read `.env` files. After a writing step the office compares `git status` and warns you when an existing file changed.
- **Localhost only.** The server binds to 127.0.0.1 and refuses WebSocket and POST requests from other web origins.
- **Secrets stay in `.env`**, which git ignores. Tokens are never logged, sent to the browser or given to a model.

## Configuration

`office.config.json`, with personal overrides in `office.config.local.json` (ignored by git).

| Key | Meaning |
|---|---|
| `language` | Language the agents write in: `en`, `es`, `pt`, `fr`, `de`, `it`. |
| `jira.project` | Your Jira project key. Required in live mode. |
| `jira.scopeJql` | Replaces `{{scope}}` in a crew's briefing query. Default `sprint in openSprints()`. Set it to `""` for a Kanban project. |
| `jira.maxTickets` | How many tickets reach your list. |
| `jira.writeEnabled` | `true` sends approved writes to Jira. |
| `jira.issueTypes`, `jira.linkTypes` | The names your Jira site uses, for example `"subtask": "Subtask"`. |
| `workspace.repoDir` | A code repository the agents may read and, in `write` steps, add files to. Optional. |
| `commands` | Commands a crew may ask to run, by name. See below. |
| `llm.model`, `llm.maxBudgetUsdPerCall` | Model and spend cap per Claude call. |

A command is an argv list, never a shell string. `{{files}}` is replaced by the files a step passes in.

```json
"workspace": { "repoDir": "../my-tests" },
"commands": {
  "test": { "argv": ["npx", "playwright", "test", "{{files}}", "--reporter=line,json"], "env": { "TEST_ENV": "dev" }, "parse": "playwright-json", "timeoutMinutes": 30 },
  "lint": { "argv": ["npm", "run", "lint"] }
}
```

`parse` is `playwright-json` (reads totals and failures from Playwright's JSON report) or omitted (the exit code decides pass or fail). Output of every run is kept in `runs/`.

## The Jira skill

`skills/jira-stories/` is a self-contained [Claude Code skill](https://docs.claude.com/en/docs/claude-code/skills): one dependency-free script that reads and writes Jira issues, plus the instructions that teach Claude to use it. The office uses the same script as a library.

```bash
npm run jira -- whoami
npm run jira -- search "project = ABC AND sprint in openSprints()" --max 20
npm run jira -- view ABC-123
npm run jira -- create --project ABC --type Story --summary "..." --description-file story.md --dry-run
npm run jira -- comment ABC-123 "Ready for review"
npm run jira -- transition ABC-123 "In Review"
```

Inside this repository Claude Code finds the skill by itself. To use it in every project on your machine run `npm run install-skill` (add `-- --copy` to copy instead of link).

## Connect other agents

Any script can appear in the office by sending events. An agent the crew does not know walks in as a guest.

```bash
curl -X POST http://127.0.0.1:4488/events -H 'content-type: application/json' \
  -d '{"agent":"buildbot","type":"build.finished","status":"done","station":"rack","message":"Build 512 is green"}'
```

Event: `{ agent, type, message, status?, station?, ticket?, data? }`. Status: `idle`, `walking`, `working`, `waiting`, `done`, `error`. Station: `board`, `rack`, `terminal`, `bench`, `you`, `coffee`. The same JSON works over the WebSocket at `/ws` as `{"kind":"event","event":{...}}`. `GET /state` returns the current state and log.

## Layout

```
skills/jira-stories/      the Jira skill: SKILL.md + scripts/jira.mjs (REST client and CLI)
teams/                    built-in crews; teams/custom/ holds yours
docs/TEAMS.md             crew file reference (also given to Claude when it designs a crew)
server/engine.js          briefing, workflow steps, approvals
server/teams.js           crew loading, validation, generation
server/template.js        {{placeholders}} and conditions, no code execution
server/adapters/          jira, brain (Claude), commands, mock
public/index.html         the office
test/                     Jira client against a fake Jira, engine, crews, safety
```

## Known limits

- One ticket at a time, and the office keeps the day in memory: a restart starts the day over.
- The Jira client is tested against a fake Jira server that checks paths, auth and payloads. Try `npm run jira -- whoami` and one `--dry-run` write against your own site before you turn writes on.
- A generated crew is validated for structure and safety, not for wisdom. Read its prompts in `teams/custom/` and adjust them.
