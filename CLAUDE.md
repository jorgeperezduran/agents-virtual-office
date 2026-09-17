# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

Agents Office: a pixel-art office in the browser, run by a crew of AI agents that works Jira tickets with a human. The human picks a crew for their role (QA engineer, developer, product owner) or describes their role and has Claude design one. The office only moves in response to events, and the human approves every Jira write and every command.

This project is company-neutral. Keep company names, real project keys, internal CLIs and private URLs out of code, crews, docs, tests and fixtures. Jira access goes through the Jira REST API only.

## Commands

```bash
npm install
npm run mock             # simulated sprint: no Jira, no model, no side effects. http://127.0.0.1:4488
npm start                # live: needs .env (Jira credentials) and jira.project in office.config.json
npm test                 # node:test; Jira client against a fake Jira server, plus a simulated day for every crew
npm run jira -- whoami   # the Jira skill's CLI; also search, view, create, update, comment, transition, link
npm run install-skill    # link skills/jira-stories into ~/.claude/skills
```

## Layout

```
skills/jira-stories/SKILL.md          the skill's instructions for Claude
skills/jira-stories/scripts/jira.mjs  Jira REST client + CLI in one zero-dependency file. The server imports it.
.claude/skills/jira-stories           relative symlink to the folder above, so the skill is active in this repo
teams/*.json                          built-in crews: qa, developer, product-owner
teams/custom/                         crews created from the UI (created on first use)
docs/TEAMS.md                         crew file reference. ALSO injected into the crew-generation prompt.
docs/example-generated-crew.json      an unedited crew Claude designed for "DevOps engineer"
server/engine.js                      briefing, step execution, approvals (ask / waitDecision / decide), results
server/teams.js                       TeamStore, validateTeam, normalizeTeam, generateTeam
server/template.js                    {{path|filter}} rendering, pick(), conditions. No eval, own properties only.
server/adapters/jira.js               office-side Jira: reads always, writes only when jira.writeEnabled
server/adapters/brain.js              `claude -p --json-schema`; strictSchema(); tools none | read | write
server/adapters/commands.js           config-defined commands, safeFiles(), Playwright report parsing, git snapshots
server/adapters/mock.js               fixtures, schema-driven fake(), simulated adapters
server/index.js, hub.js, config.js    HTTP + WebSocket, event log and state, config and .env loading
public/index.html                     the whole UI, no build step
```

## How it fits together

- A crew is data. `workflow` is a list of steps of type `think`, `parallel`, `command`, `gate`, `jira`, `branch`, `end`. The engine walks it top to bottom; `goto` jumps to a top-level step id; a step that runs more than 3 times ends the ticket.
- Each step result is stored in a per-ticket context under its `save` name and read back through templates such as `{{cases.cases|titles}}` or paths such as `regression.suites[].file`.
- Events: `{ ts, agent, type, status, station?, ticket?, message, data? }`. The `station` on the event tells the UI where the agent walks (`board`, `rack`, `terminal`, `bench`, `you`, `coffee`). Unknown agent ids become guest characters.
- The server owns `state`; the browser renders it and sends `selectTeam`, `changeTeam`, `createTeam`, `startDay`, `selectTicket`, `decide`, `reset`, `speed`.
- The side panel is generic: steps publish `sections` (list, text or code) and approvals publish `{ title, message, sections, input, actions, warnings }`. A new crew needs no UI code.
- Live and mock adapters share one interface. Mock `brain.think` builds data from the step's JSON schema, so any valid crew, including a generated one, plays in mock mode.

## Rules that must not break

- **The engine asks before every Jira write and every command.** That lives in `execJira` and `execCommand`, not in crew files, so no crew can skip it. Never add a crew field, config flag or code path that bypasses it.
- **Crew files never execute.** No eval, no shell strings, no code from templates. `pick()` reads own properties only.
- **Commands come from `office.config.json` only**, as argv arrays. Model output becomes an argument only through `safeFiles()`: an existing file inside the workspace that does not start with `-`. `assertSafeCommand()` refuses anything matching `safety.forbiddenPattern`.
- **Jira defaults to dry run** (`jira.writeEnabled: false`), and `JIRA_READ_ONLY=1` blocks writes in the client itself. The UI must keep saying when writes are off.
- **Secrets stay in `.env`.** Never log a token, put one in state or events, pass one to a model, or commit one. Agents with file tools are denied `.env*`.
- Agents never get a shell. `tools: "write"` steps are followed by a `git status` comparison and a warning when an existing file changed.
- The server binds 127.0.0.1 and checks Origin on the WebSocket and on POST /events.
- Everything the UI shows from Jira or a model goes through `esc()`; links go through `safeUrl()`.

## When you change things

- **Step types, step fields, templates or filters:** update `validateTeam()` in `server/teams.js`, `docs/TEAMS.md` and the tests together. `docs/TEAMS.md` is fed to Claude when it designs a crew, so a stale reference produces invalid crews.
- **A new adapter method:** add it to `server/adapters/mock.js` as well.
- **The Jira script:** keep it one file with zero dependencies so the skill folder can be copied anywhere. Cloud uses API v3 with ADF bodies (`textToAdf`), Server uses v2 with plain text. Cover new calls in `test/jira.test.js` against the fake Jira server.
- **A new built-in crew:** add `teams/<id>.json`, make it pass `validateTeam`, use `{{project}}` and `{{scope}}` with `statusCategory` in the briefing JQL (status names differ between Jira sites), and add a simulated day for it in `test/office.test.js`.
- Tests pass a temp folder as the custom crew directory and as `dataDir`. Do not let a test write into `teams/custom/` or `data/`.
- `data/`, `runs/`, `.env` and `office.config.local.json` are git-ignored.

## Never verified

- The Jira client against a real Jira site. It is tested only against a fake server that checks paths, auth headers and payloads. Do not claim otherwise.
- A live ticket run with real Jira data, a real workspace and a configured command.
- Verified: real Claude designed a valid crew from a role description, and that crew played end to end in mock mode.

## Known limits

- One ticket at a time. The day lives in memory, so a restart starts it over.
- Generated crews are validated for structure and safety, not for the quality of their prompts.
- `create` steps make at most 20 issues per approval and cannot be edited one by one in the UI.
