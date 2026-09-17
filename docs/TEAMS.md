# Crew files

A crew is one JSON file in `teams/` (built in) or `teams/custom/` (yours). It says who the agents are, how the morning list is built, and what the crew does with one ticket. A crew file is data: nothing in it runs as code.

```json
{
  "id": "qa",
  "name": "QA crew",
  "role": "QA engineer",
  "description": "One sentence shown on the crew picker.",
  "stationLabels": { "board": "Sprint board", "bench": "Bug desk" },
  "agents": [ { "id": "ana", "name": "Ana", "title": "QA Analyst", "shirt": "#3a66c9" } ],
  "briefing": { "agent": "ana", "jql": "...", "rankPrompt": "..." },
  "workflow": [ ...steps ]
}
```

## Agents

1 to 6 agents. `id` is a lowercase slug, `name` has 8 characters at most (it is drawn under the character), `title` is the job. `shirt`, `hair` and `skin` are optional `#rrggbb` colours.

## Stations

Where an agent walks while a step runs: `board` (the Jira board), `rack` (servers and CI), `terminal`, `bench` (a second desk), `you` (the human's desk), `coffee` (idle). `stationLabels` renames the signs.

## Briefing

`agent` builds the morning list. `jql` may use `{{project}}` and `{{scope}}` (from `jira.project` and `jira.scopeJql` in the config). Prefer `statusCategory` (`"To Do"`, `"In Progress"`, `Done`) over status names, because status names differ between Jira sites. `rankPrompt` tells the agent what matters to this role when ordering the tickets.

## Templates

Strings may contain `{{path}}` placeholders that read the ticket context.

| Placeholder | Gives |
|---|---|
| `{{ticket.key}}`, `{{ticket.summary}}`, `{{ticket.description}}`, `{{ticket.type}}`, `{{ticket.status}}`, `{{ticket.priority}}`, `{{ticket.url}}` | The Jira ticket |
| `{{<save>.<field>}}` | What an earlier step saved, for example `{{cases.cases}}` |
| `{{project}}`, `{{language}}`, `{{today}}`, `{{issueTypes.bug}}`, `{{issueTypes.story}}`, `{{issueTypes.task}}`, `{{issueTypes.subtask}}`, `{{linkTypes.blocks}}`, `{{linkTypes.relates}}` | Configuration |
| `{{item.<field>}}` | The current element inside a `jira` `create` step that uses `from` |
| `{{changes.created}}` | Files the last `"tools": "write"` step created |

Filters: `{{x|titles}}` bullet list of each item's main text, `{{x|numbered}}`, `{{x|json}}`, `{{x|count}}`. A path can map over a list: `regression.suites[].file`.

## Steps

Steps run top to bottom. Every step has a unique lowercase `id` and a `type`. Any step may carry `"goto": "<top-level step id>"` to jump after it finishes; `"goto": "end"` stops. A step that runs more than 3 times stops the ticket.

### think
An agent reasons and returns JSON.

```json
{ "id": "cases", "type": "think", "agent": "sid", "station": "terminal", "label": "Turn the ticket into test cases",
  "message": "Reading {{ticket.key}}", "doneMessage": "{{cases.cases|count}} test cases ready",
  "prompt": "Read this ticket...\n{{ticket.description}}",
  "schema": { "type": "object", "properties": { "cases": { "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string" } } } } } },
  "save": "cases", "tools": "none",
  "show": [ { "title": "Test cases", "path": "cases.cases" } ] }
```

- `schema` is a JSON schema of type `object`. The result is stored under `save`.
- `tools`: `"none"` (default), `"read"` (the agent may read the workspace repository), `"write"` (it may also create and edit files there). No agent has a shell, and none can read `.env` files. Steps with tools are skipped when no workspace is configured.
- `show` adds sections to the side panel. List items show their `title`, `summary`, `name`, `file` or `key`, with `reason`, `why`, `kind`, `description` or `error` underneath.
- `appendTo` + `appendFrom`: append one list to another, for example `"appendTo": "cases.cases", "appendFrom": "extra.cases"`.

### parallel
`{ "id": "prep", "type": "parallel", "branches": [ [think steps], [think steps] ] }`. Branches may only hold `think` steps.

### command
Runs a command from `commands` in `office.config.json`. The crew file only names it: `"command": "test"`. **The office always asks the human first and shows the exact command.**

```json
{ "id": "run-tests", "type": "command", "agent": "sid", "label": "Run the tests", "command": "test",
  "files": ["spec.testFile", "regression.suites[].file"], "save": "run", "onSkip": "not-run" }
```

`files` are context paths. Their values replace `{{files}}` in the configured command, and only real files inside the workspace are accepted. The result is saved with `executed`, `exitCode`, `total`, `passed`, `failed`, `skipped`, `failures` (each with `title`, `file`, `error`) and `summary`. When the command is not configured, the step is skipped with `executed: false` and `failed: 0`.

### jira
Writes to Jira. **The office always asks the human first, shows exactly what will be written, and lets them edit comment and description text.** With `jira.writeEnabled: false` nothing is sent.

| `action` | Fields |
|---|---|
| `comment` | `body`, optional `issue` (defaults to the ticket) |
| `update` | `body` (replaces the description), optional `summary`, `issue` |
| `create` | `issueType`, `summary`, optional `body`, `priority`, `labels`, `parent`, `linkTo` + `linkType`. With `from` (a path to a list) it creates one issue per element, read through `{{item.…}}` |
| `transition` | `to` (a status or transition name), optional `issue` |
| `link` | `inward`, `outward`, optional `linkType` (inward blocks outward when the type is Blocks) |

The result is saved under `save` with `dryRun`, `keys` and `keysText`. `onSkip` names the step to jump to when the human skips. `extraActions` adds buttons to the approval.

### gate
A decision that is not a Jira write or a command: which path to take.

```json
{ "id": "review", "type": "gate", "agent": "sid", "label": "Review the results", "title": "All tests passed for {{ticket.key}}",
  "message": "{{run.summary}}", "show": [ { "title": "Test cases", "path": "cases.cases" } ],
  "actions": [ { "id": "continue", "label": "Continue to sign-off", "primary": true },
               { "id": "rework", "label": "Ask for more cases", "goto": "more-cases", "once": true },
               { "id": "stop", "label": "Not now", "result": { "label": "Needs a manual check", "tone": "muted" } } ] }
```

An action continues to the next step, jumps with `goto`, or ends the ticket with `result`. `once` hides the button after its first use. `input` (`label`, `value`, `save`) adds an editable text box and stores what the human wrote.

### branch
`{ "id": "failed", "type": "branch", "when": { "path": "run.failed", "op": "gt", "value": 0 }, "goto": "draft-bug" }`. Ops: `truthy`, `falsy`, `eq`, `ne`, `gt`, `lt`. Lists compare by length. Optional `else`.

### end
`{ "id": "signed", "type": "end", "result": { "label": "Signed off", "tone": "ok" } }`. Tones: `ok`, `err`, `muted`. A ticket that ended `muted` can be picked again.

## Rules the engine enforces for every crew

- Every Jira write and every command stops for the human's approval. A crew file cannot turn that off.
- Commands come from the config file, never from a crew file or a model.
- Model output becomes a command argument only when it is an existing file inside the workspace.
- Anything matching `safety.forbiddenPattern` (default `prod`) in a command is refused at startup.
