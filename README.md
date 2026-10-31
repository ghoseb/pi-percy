# pi-percy

pi-percy adds Shelley-style context compaction to [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).

Context is the message history that Pi sends to the model. pi-percy lets the agent compact selected old context. It does not wait for the model context window to become nearly full. The agent receives an index. It selects tool outputs to trim and message ranges to replace with notes. The original session data stays available for recall.

## Requirements

- Pi 1.4 or later. pi-percy does not support older Pi versions.
- Node.js 22.6 or later.
- pnpm 10.33 or later for development and local installation.

## Install and load

Install dependencies:

```sh
pnpm install --frozen-lockfile
```

Start Pi with the extension path:

```sh
pi -e /absolute/path/to/pi-percy
```

For this checkout, use:

```sh
pi -e ~/Code/src/pi-percy
```

Run `/reload` after you change extension code or `percy` settings. Reload creates a new extension runtime. The new runtime reads the settings.

## How it works

### 1. pi-percy sends a context nudge

By default, pi-percy sends a nudge after a response reports 200k context tokens. As in Shelley, the nudge goes with the next model request: after the tool results when the agent continues, or after your next message when the response was a final reply. pi-percy does not make an extra model request for it. The nudge gives the agent:

- the approximate context size;
- an index of old messages that it can compact; and
- instructions for notes.

pi-percy sends another nudge for each 50k tokens after the first nudge. It keeps the newest 20k tokens unchanged. The index does not show this recent part.

Pi's own compaction stays enabled. On a model with a one-million-token window and Pi's default reserve, Pi starts its fallback compaction at about 984k tokens. pi-percy therefore has time to compact first. Pi's compaction is still the safety fallback if the agent does not compact successfully.

### 2. The agent selects what to compact

The model can use two tools:

- `compact_in_place`
  - `action: "index"` lists old context that the agent can compact.
  - `action: "compact"` accepts `trim` and `collapse` operations.
- `recall` gets original messages by message number, message range, or note ID.

The index groups a tool call with its outputs. It marks protected rows. It does not show the recent part.

The agent can do these actions:

- **Trim** an old tool output. pi-percy replaces its model-visible content with a small recall pointer.
- **Collapse** one continuous message range into a short note. The note must keep decisions, findings, paths, commands, identifiers, and later corrections.

The validator rejects unsafe compaction requests. It rejects ranges that split tool calls from their outputs. It rejects overlapping ranges. It rejects ranges in the recent part. It rejects ranges that exceed the configured size. It also rejects a note that is not shorter than the replaced range.

A user message, an old note, or a Pi summary is a protected row. The agent can collapse one protected row by itself. It cannot include that row in a larger range.

The validator reports all detected errors in one response. The agent can then send one corrected request.

After a successful compaction, Pi uses the compacted view for the next model request. pi-percy also removes old nudges and completed compaction calls from later model context. These records do not increase model context after they have served their purpose.

### 3. pi-percy keeps original data

Pi sessions use append-only JSONL files and trees. pi-percy does not delete or overwrite original messages.

For each compaction, pi-percy adds:

1. A `percy-compaction` record. This record stores original entry IDs, notes, trimmed outputs, and token estimates.
2. Pi `context_edit` entries. These entries replace or omit only model-visible message content.

Pi applies the edits when it builds model context. The `recall` tool reads the original session entries. The agent can get original content after it was collapsed or trimmed:

```text
recall { ids: ["42", "50-57", "s103.0"] }
```

`/tree` shows raw `percy-nudge`, `percy-compaction`, and `context_edit` entries. These records provide a durable audit trail for the active branch. After compaction, Pi does not send the related nudge or completed compaction call to the model.

### 4. pi-percy compacts an idle conversation once

pi-percy starts one housekeeping turn after the configured idle time. It starts this turn only when the context is large enough and has content older than the recent part. The idle prompt tells the model not to reply to the user.

New user input cancels the idle timer. An idle compaction does not start another idle timer. A later user input can start a new timer.

## Commands

| Command                                      | Purpose                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/percy:compact-in-place [instructions]`     | Activate `compact_in_place` if needed. Ask the agent to compact context. Instructions can say what to keep. |
| `/percy:compact-debug [index\|squish\|trim]` | Show the index or record a direct test compaction. Use this command for development.                        |
| `/percy:rewind-compaction`                   | Rewind the active branch to before the newest pi-percy compaction.                                          |
| `/percy:toggle-compaction`                   | Enable or disable pi-percy context compaction for this session.                                             |
| `/percy:status`                              | Show pi-percy state, context estimate, nudge schedule, and idle timer without a model request.              |
| `/reload`                                    | Reload Pi extensions and read changed settings.                                                             |

The usual workflow is automatic. Wait for a context nudge. The agent uses its index and calls `compact_in_place`. Use `/percy:compact-in-place` when you want to request compaction earlier.

### Use `percy:compact-debug`

`/percy:compact-debug` is a development command. It records a test compaction without the normal tool request flow. It does not change the model context until the next response boundary.

Type `/percy:compact-debug` and press Tab to select a subcommand:

| Command                                                | Action                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `/percy:compact-debug` or `/percy:compact-debug index` | Show the current compaction index. It does not change context.                                              |
| `/percy:compact-debug squish <from>-<to> <summary>`    | Record a test collapse. `from` and `to` are message numbers from the index. The remaining text is the note. |
| `/percy:compact-debug trim <id>`                       | Record trimming for the tool-output row with this index ID. A shared tool-call row trims all its outputs.   |

The command rejects an unknown row, a row without trim-able output, or a collapse that does not fit the current view.

### Rewind a compaction

`/percy:rewind-compaction` needs no model request. It first asks for confirmation and states how many later entries will remain on the alternate branch. If confirmed, it moves the active session-tree leaf to the entry before the newest `percy-compaction` record. This rewinds the active branch. Pi keeps that branch and its original messages in the session file; use `/tree` to return to it.

Use this command if a compaction produces a provider-invalid context. The command does not run while the agent is working. Wait for the current turn to end first.

### Temporarily disable compaction

`/percy:toggle-compaction` enables or disables pi-percy compaction for the current session. When it is disabled, pi-percy does not send context nudges or start idle compaction turns. Run the command again to enable it. The setting does not change `settings.json`.

## Configuration

Configuration is optional. If no `percy` key exists, pi-percy uses the default values. Put overrides in Pi's agent or project `settings.json`. A trusted project setting overrides the agent setting.

```json
{
  "percy": {
    "nudgeTokens": 200000,
    "nudgeStepTokens": 50000,
    "keepRecentTokens": 20000,
    "maxCollapseTokens": 20000,
    "idleMinutes": 8,
    "idleMinTokens": 50000
  }
}
```

| Setting             | Default | Meaning                                                                                                         |
| ------------------- | ------: | --------------------------------------------------------------------------------------------------------------- |
| `nudgeTokens`       |  200000 | Send the first nudge at this context size. The value must be positive.                                          |
| `nudgeStepTokens`   |   50000 | Send a later nudge after this many more tokens. The value must be positive.                                     |
| `keepRecentTokens`  |   20000 | Keep about this many newest tokens unchanged.                                                                   |
| `maxCollapseTokens` |   20000 | Limit a multi-message collapse to about this many tokens. The value must be positive. One large row is allowed. |
| `idleMinutes`       |       8 | Wait this many minutes before an idle compaction. Set `0` to disable idle compaction.                           |
| `idleMinTokens`     |   50000 | Require at least this estimated context size for idle compaction. Set `0` to allow any compactable context.     |

pi-percy checks settings at startup. It shows a warning for an unknown or invalid value. It also warns when the nudge threshold is too close to Pi's compaction point for the selected model.

## Limits

- Token counts in the index are estimates. pi-percy uses Pi-style token estimates for the index and compaction boundary. It uses reported model context usage for nudge timing when that data exists.
- A Pi `context_edit` can change message content. It cannot change message role. A collapsed note keeps the role of the first message in its range. Shelley creates a new user message for a note. Some providers reject adjacent messages that have the same role.
- Compaction reduces model context. It does not reduce disk use. The JSONL session file keeps original entries, compaction records, and edits for recall and branch history.
- If Pi's own compaction runs, it uses the pi-percy edited view. Original session entries stay available. pi-percy does not collapse Pi's own summaries.

## Development

Install dependencies and run all checks:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs Prettier, typed ESLint, strict TypeScript checks, and the test suite.

`test/session-model.test.ts` runs random action sequences on a real Pi session: prompts, tool calls, provider errors, aborts, external tool and system prompt changes, idle runs, compactions, recall, resume, reload, and `/tree` jumps. After each action, it checks that the session stays consistent. Set these environment variables to control it:

| Variable            | Effect                                                    |
| ------------------- | --------------------------------------------------------- |
| `PERCY_PBT_RUNS`    | The number of sequences. The default is 1000 (about 30s). |
| `PERCY_PBT_SEED`    | Replays the sequences of a reported seed.                 |
| `PERCY_PBT_ACTIONS` | Replays one reported counterexample (JSON).               |
| `PERCY_PBT_DUMP`    | Adds the session branch to a failure.                     |
| `PERCY_PBT_STATS`   | Prints counts of what the sequences did.                  |

## Credits

pi-percy ports the in-place compaction design from [Shelley](https://github.com/boldsoftware/shelley). Read the design explanation in ["Compaction"](https://blog.exe.dev/compaction).
