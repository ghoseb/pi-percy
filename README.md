# pi-percy

[![NPM Version](https://img.shields.io/npm/v/pi-percy)](https://www.npmjs.com/package/pi-percy)
[![Node.js Version](https://img.shields.io/node/v/pi-percy)](https://nodejs.org)
[![License](https://img.shields.io/npm/l/pi-percy)](LICENSE)

pi-percy is an extension for [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent).
It lets the agent make its own context smaller before the context window is full.
The agent replaces old tool outputs with short pointers and replaces old message ranges with short notes.
The session keeps the original messages.
With `recall`, the agent can search them and read them again.

pi-percy is useful for long sessions in which the conversation grows, not only the tool output:

- The edits are permanent Pi session entries.
  Pi uses the compacted context, also if you turn off pi-percy.
- The model that does the work selects what to keep.
- pi-percy uses no second model, so it has no extra model cost or configuration.
- pi-percy checks each compaction before it applies it.
  Thus, the messages stay in an order that the provider accepts.
- pi-percy changes old context only when the agent compacts.
  Thus, the provider prompt cache stays valid between compactions.

## Terms

This document uses these terms with one meaning each:

- **Context**: the message history that Pi sends to the model.
- **Compaction**: a change that makes the context smaller.
- **Nudge**: a message from pi-percy that tells the agent to compact its context.
- **Index**: a list of old messages that the agent can compact.
- **Row**: one line of the index.
  A row is one message, or one tool call with its outputs.
- **Trim**: replace an old tool output with a short pointer.
- **Collapse**: replace a range of messages with a short note.
- **Unit**: a safe range that the agent can collapse by its ID.
- **Recall**: get the original content of a message after a compaction.
- **Recent part**: the newest messages. pi-percy does not change them.

Pi's own compaction replaces most of the history with one summary. pi-percy changes only the parts
that the agent selects.
All other messages stay as they are.

## Requirements

- Pi 1.4 or later. pi-percy does not support older Pi versions.
- Node.js 22.6 or later.

## Install

To install pi-percy from npm, run this command:

```sh
pi install npm:pi-percy
```

This command adds the package to `~/.pi/agent/settings.json`.
To add the package to the project settings in `.pi/settings.json`, add `--local`.

To use pi-percy for one session only, run this command.
It does not change your settings.

```sh
pi -e npm:pi-percy
```

To load a local copy of the repository, give its path:

```sh
pi -e /absolute/path/to/pi-percy
```

Run `/reload` after you change the extension code or the `percy` settings.
`/reload` starts a new extension runtime, and the new runtime reads the settings.

## How it works

### 1. pi-percy sends a nudge

By default, pi-percy sends the first nudge when a response reports 200k context tokens.
After that, it sends one more nudge for each 50k tokens.

pi-percy does not make an extra model request for a nudge.
As in Shelley, the nudge goes with the next model request:

- If the agent continues with tool calls, the nudge comes after the tool results.
- If the response is a final reply, the nudge comes after your next message.

Shelley puts messages that you queue during a run before the nudge.
Pi puts them after the pi-percy entries.
Thus, while you have queued messages, the nudge waits for a later request.

The nudge gives the agent these items:

- the approximate context size
- the index
- instructions for the notes

pi-percy keeps the newest 20k tokens unchanged.
This is the recent part.
The index does not show it.

### 2. Pi's own compaction stays on as a fallback

pi-percy does not turn off Pi's own compaction.
Pi's compaction is the fallback if the agent does not compact.
For example, on a model with a one-million-token window, Pi starts its compaction at approximately 984k tokens.
This gives pi-percy time to compact first.

Pi's compaction keeps the newest messages, and these can include a nudge.
The index in that nudge names messages that Pi summarized,
so its IDs are not correct. pi-percy removes such a nudge from the index and from all later requests.
This includes the request that Pi sends again after a context overflow.

If Pi's compaction runs, it summarizes the context that pi-percy edited.
The original session entries stay available. pi-percy does not collapse Pi's own summaries.

### 3. The agent selects what to compact

The model can use two tools:

- `compact_in_place`
  - `action: "index"` shows the index.
  - `action: "compact"` applies trims and collapses.
    It accepts `trim` (row IDs), `collapse` (message ranges with notes), and `collapseUnits` (unit IDs with notes).
- `recall` gets original messages by message number, message range, or note ID.
  It also searches messages and notes.

The agent can do these actions:

- **Trim** an old tool output. pi-percy replaces the content that the model sees with a short recall pointer.
- **Collapse** one continuous message range into a short note.
  The note must keep decisions, findings, paths, commands, IDs, and later corrections.

A user message, an old note, and a Pi summary are protected rows.
The agent can collapse a protected row only by itself.
The agent cannot put a protected row in a larger range.

#### The index

The index puts a tool call and its outputs on one row.
It marks protected rows.

The index does not show small items one by one.
If a protected row has fewer than approximately 500 tokens, a collapse of that row saves little.
The index shows a sequence of these rows as one line, for example:

```text
85-1319  *  2315  49 rows: 29 notes, 20 user messages
```

The numbers at the start are the first and the last message of the sequence.
To read the original messages, the agent calls `recall` with the ID `85-1319`.

The index lists only units of approximately 500 tokens or more.
It gives the number of smaller units.
The smaller units stay valid.

#### The validator

The validator checks each compaction request.
It rejects a request in these conditions:

- A range separates a tool call from its outputs.
- Two ranges overlap.
- A range includes messages from the recent part.
- A range is larger than the configured maximum size.
- A note is not shorter than the range that it replaces.
- A unit ID is not in the current index.

The validator reports all the errors in one response.
The agent can then send one corrected request.
If many unit IDs are unknown, the validator reports one error.
This error tells the agent that the index is old and that the agent must get a new index.

#### After a compaction

After a compaction, Pi uses the compacted context for the next model request. pi-percy also removes old nudges
and completed `compact_in_place` calls from the context.
These messages have no more use after the compaction.

pi-percy applies a compaction only when the result of the tool call ends the turn.
Then it removes that call from the context.

#### Calls from scripts

Only the model can call `compact_in_place`.
Other tools cannot call it, for example a Pi codemode script.
A call from a script has no tool call of its own, so pi-percy cannot apply it.

A script can call `recall`.
The script gets data, not text:

- A read by `ids` gives `{ messages: [{ id, header, text }] }`. pi-percy does not truncate the text.
  Thus, a script can filter long output before the model sees it.
- A search gives `{ search: { total, offset, hits } }`.
  Each hit has `id`, `kind` (`message` or `note`), `header`, `matches`, and `snippet`.
  A note hit also has `range`: the first and the last message that the note replaced.

The two tools declare annotations for permission extensions:

- `recall` is read-only.
- `compact_in_place` is not read-only, but it is not destructive.
  It only adds session entries, and the original entries stay.
- Neither tool goes outside the session.

### 4. pi-percy keeps the original data

Pi sessions use append-only JSONL files and trees. pi-percy does not delete or overwrite original messages.

For each compaction, pi-percy adds these entries:

1. One `percy-compaction` record.
   The record stores the original entry IDs, the notes, the trimmed outputs, and the token estimates.
2. Pi `context_edit` entries.
   These entries replace or omit only the content that the model sees.

Pi applies the edits when it builds the context.

#### Recall

The `recall` tool reads the original session entries.
Thus, the agent can get content after a collapse or a trim:

```text
recall { ids: ["42", "50-57", "s103.0"] }
```

Recall can get all messages on the current branch.
This includes messages before a Pi summary.
The index row of a Pi summary shows which messages the summary replaced,
for example `pi summary of messages 1-4800 (recall them for details)`.

Recall returns text, tool calls, and tool outputs.
It does not return thinking blocks, because some providers refuse a request that sends old reasoning back to the model.
If a message has only thinking, recall does not show that message.

Recall shows each tool call argument on its own line as `name: value`.
It shows a string value as written, with real quotes and new lines.

The `recall` tool description tells the agent when to use recall:

- Use recall to get exact text that a note or a summary did not keep.
  Examples are commands, IDs, error messages, measured numbers, and the exact words of a user decision.
- Use recall when a note is not clear, or when a note does not agree with the current state.
- Use recall before you say that an earlier check passed, if only a note says so.
- Use recall when the source is not available in a different location, for example a deleted file or old command output.
- Do not use recall when the source is still available.
  Read the file or run the command again.
- Do not use recall to examine a decision again if a note records it.

#### Search

If the agent does not know the message number, it can search.
To search, give `query` instead of `ids`:

```text
recall { query: "connection refused", tool: "bash" }
```

Search returns one line for each message or note that matches.
Each line shows the ID, the header, and some text near the first match.
The agent then recalls the IDs that it needs.

Search uses these rules:

- Search reads the same text that recall returns, and the compaction notes.
  Thus, a query can use plain text for tool call arguments.
- Search ignores thinking and nudges.
- Search ignores the calls and outputs of `compact_in_place` and `recall`, because they repeat notes and old messages.
- Search ignores a tool call that called `recall` or `compact_in_place`, and its output.
  An example is a codemode script.
  Pi records these nested calls in the tool result.
  Search ignores the full script, also if the script did other work.
- While a script runs, its result does not exist.
  Pi gives each nested call an ID that starts with the ID of the script.
  Thus, search also ignores a script that is running.
- By default, search matches plain text and ignores case.
  To use a JavaScript regular expression, set `regex`.
  To match case, set `caseSensitive`.
- The newest matches come first.
  To change the order, set `oldestFirst`.
- Search shows 20 matches.
  To see more, use `limit` (up to 100) and `offset`.
- A search stops after 2 seconds.
  Thus, a regular expression that does not end cannot stop the agent.

The `role` parameter limits the search to one type of text:

| Role        | Text                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| `user`      | What the user typed or ran.                                                       |
| `assistant` | Messages from the model.                                                          |
| `tool`      | Tool calls and tool outputs.                                                      |
| `summary`   | Summaries from Pi's own compaction or from `/tree`.                               |
| `custom`    | Messages from extensions, for example a summary from a context-pruning extension. |
| `note`      | pi-percy compaction notes.                                                        |

The hit header of a `custom` message gives its message type.

The `tool` parameter limits the search to the calls to one tool and to the outputs of that tool.
Search reads a call by its arguments.
If you use `tool` with the role `user`, `summary`, `custom`, or `note`, search returns an error.

The `range` parameter (for example `30000-34000`) limits the search to those messages.
A note is in the range if a message that it replaced is in the range.
If the range continues after the last message, the search stops at the last message.

#### The session tree

`/tree` shows the `percy-nudge`, `percy-compaction`, and `context_edit` entries.
These entries are a permanent record of the compactions on the active branch.
After a compaction, Pi does not send the related nudge or the completed `compact_in_place` call to the model.

A compaction is one change: a `percy-compaction` record and the `context_edit` entries after it.
A `/tree` jump to the record, or to any edit except the last edit, puts only part of the compaction on the branch.
Thus, pi-percy cancels such a jump.

- To keep the compaction, select its last `context_edit` entry.
- To go back to before the compaction, select the entry before its record.

### 5. pi-percy compacts an idle conversation once

After the configured idle time, pi-percy starts one housekeeping turn.
It starts this turn only in these conditions:

- The context is large enough.
- The context has content that is older than the recent part.

The idle prompt tells the model not to reply to the user.

New user input stops the idle timer.
An idle compaction does not start a new idle timer.
A later user input can start a new timer.
When Pi loads or reloads a session, the idle timer waits the full idle time again.

### 6. pi-percy keeps the prompt cache valid

Many providers keep a prompt cache.
If the start of a request is the same as in an earlier request, the provider reads that part from the cache.
This is faster and costs less.
A change to an old message makes the cache not valid from that message to the end.
Then the provider must process that part again.

A compaction changes old messages, so each compaction has this cost. pi-percy keeps the number of these changes small:

- pi-percy changes old context only when the agent compacts.
  A nudge goes at the end of the context, so it does not change old messages.
- pi-percy sends nudges only at large intervals.
  By default, it sends the first nudge at 200k tokens, then one nudge for each 50k tokens.
- The index tells the agent to make one large compaction (tens of thousands of tokens) instead of many small
  compactions.
- By default, an idle compaction starts after 8 minutes without input.
  Some provider caches stop after a shorter time, for example after 5 minutes.
  Then the idle compaction does not cause an extra cache loss.
- pi-percy does not change its tools or its tool descriptions during a session.
  Thus, the tool part of the cache stays valid.
  `/percy:toggle-compaction` also does not change the tools.

## Commands

| Command                                      | Purpose                                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/percy:compact-in-place [instructions]`     | Tell the agent to compact its context. The instructions can say what to keep.                                     |
| `/percy:compact-debug [index\|squish\|trim]` | Show the index or record a test compaction. Use this command for development only.                                |
| `/percy:rewind-compaction`                   | Move the active branch back to before the newest pi-percy compaction.                                             |
| `/percy:toggle-compaction`                   | Turn pi-percy compaction on or off for this session.                                                              |
| `/percy:status`                              | Show the pi-percy state, the context estimate, the nudge schedule, and the idle timer. It sends no model request. |
| `/reload`                                    | Reload the Pi extensions and read the changed settings.                                                           |

Usually, you do not have to do anything. pi-percy sends a nudge, and the agent uses the index to compact.
To tell the agent to compact before the nudge, use `/percy:compact-in-place`.

### Use `/percy:compact-debug`

`/percy:compact-debug` is a development command.
It records a test compaction without a model request.
The model context changes at the next response boundary.

Type `/percy:compact-debug` and push Tab to select a subcommand:

| Command                                                | Action                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `/percy:compact-debug` or `/percy:compact-debug index` | Show the current index. This command does not change the context.                                                           |
| `/percy:compact-debug squish <from>-<to> <summary>`    | Record a test collapse. `from` and `to` are message numbers from the index. The remaining text is the note.                 |
| `/percy:compact-debug trim <id>`                       | Record a trim of the tool output on the row with this index ID. If the row has many outputs, the command trims all of them. |

The command rejects these requests:

- a row that does not exist
- a row that has no tool output to trim
- a collapse that is not valid for the current context

### Rewind a compaction

Use `/percy:rewind-compaction` if a compaction makes a context that the provider refuses.
This command sends no model request.

1. The command asks you to confirm.
   It tells you how many later entries go to the other branch.
2. If you confirm, the command moves the active branch to the entry before the newest `percy-compaction` record.

Pi keeps the other branch and its original messages in the session file.
To go back to that branch, use `/tree`.

The command does not run while the agent works.
Wait until the current turn ends.

### Turn compaction off for a session

`/percy:toggle-compaction` turns pi-percy compaction off or on for the current session.
When compaction is off, pi-percy does not send nudges and does not start idle compaction turns.
To turn it on again, run the command again.
The command does not change `settings.json`.

The command does not change the active tools.
`compact_in_place` and `recall` stay available, so the prompt cache stays valid.

## Configuration

Configuration is optional.
If there is no `percy` key, pi-percy uses the default values.
To change a value, put it in the Pi agent or project `settings.json`.
A setting in a trusted project replaces the agent setting.

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

| Setting             | Default | Meaning                                                                                                                                               |
| ------------------- | ------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nudgeTokens`       |  200000 | Send the first nudge at this context size. The value must be more than 0.                                                                             |
| `nudgeStepTokens`   |   50000 | Send one more nudge for each increase of this many tokens. The value must be more than 0.                                                             |
| `keepRecentTokens`  |   20000 | Keep approximately this many of the newest tokens unchanged.                                                                                          |
| `maxCollapseTokens` |   20000 | A collapse of many messages can have approximately this many tokens at most. The value must be more than 0. A collapse of one large row has no limit. |
| `idleMinutes`       |       8 | Wait this many minutes before an idle compaction. To turn off idle compaction, set `0`.                                                               |
| `idleMinTokens`     |   50000 | An idle compaction needs an estimated context of at least this size. To allow all context sizes, set `0`.                                             |

pi-percy checks the settings when it starts.
It shows a warning for an unknown or incorrect value.
It also shows a warning if the nudge threshold is too near to the point where Pi compacts for the selected model.

## Limits

- The token counts in the index are estimates. pi-percy uses Pi-style token estimates for the index and the recent part.
  For the nudge timing, it uses the context usage that the model reports, if that data exists.
- A Pi `context_edit` can change the content of a message, but not its role.
  Thus, a note keeps the role of the first message in its range.
  Shelley makes a new user message for each note.
  Some providers refuse two adjacent messages that have the same role.
- Compaction makes the context smaller, but not the session file.
  The JSONL session file keeps the original entries, the compaction records,
  and the edits for recall and for branch history.

## Development

Development needs pnpm 10.33 or later.
To install the dependencies and run all checks, run these commands:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

`pnpm run check` runs Prettier, typed ESLint, strict TypeScript checks, and the test suite.

`test/session-model.test.ts` runs random sequences of actions on a real Pi session.
After each action, the test checks that the session is correct.
The actions include these items:

- prompts, tool calls, provider errors, and aborts
- tool changes and system prompt changes from other sources
- idle runs, compactions, and recall
- messages that you steer or queue during a run
- resume and reload
- `/tree` jumps, with and without branch summaries
- Pi's own compaction: manual, at its threshold, and after a context overflow

These environment variables control the test:

| Variable            | Effect                                                                        |
| ------------------- | ----------------------------------------------------------------------------- |
| `PERCY_PBT_RUNS`    | Sets the number of sequences. The default is 1000 (approximately 30 seconds). |
| `PERCY_PBT_SEED`    | Runs the sequences of a reported seed again.                                  |
| `PERCY_PBT_ACTIONS` | Runs one reported counterexample (JSON) again.                                |
| `PERCY_PBT_DUMP`    | Adds the session branch to the failure report.                                |
| `PERCY_PBT_STATS`   | Shows the number of each action in the sequences.                             |

### Release

To make a release, run this command on `main`:

```sh
pnpm release [patch | minor | major | <x.y.z>]
```

The command does these steps:

1. It checks that the working tree has no changes and that the branch is `main`.
2. It runs `pnpm run check`.
3. It sets the new version in `package.json`.
4. It writes `CHANGELOG.md` with [git-cliff](https://git-cliff.org) from the conventional commits.
   `cliff.toml` holds the configuration.
5. It commits the two files as `chore(release): v<version>` and adds the tag `v<version>`.

If you do not give a version, git-cliff selects the next version from the commits after the last tag.
A feature increases the minor version, a fix increases the patch version,
and a breaking change increases the major version.
Before the first tag, the command uses the version in `package.json`.

To see the version and the new changelog section without a change, add `--dry-run`.

The command does not push or publish.
To do these steps, run these commands:

```sh
git push --follow-tags origin main
npm publish
```

## Credits

pi-percy uses the in-place compaction design from [Shelley](https://github.com/boldsoftware/shelley).
For an explanation of the design, read ["Compaction"](https://blog.exe.dev/compaction).

## License

MIT.
See [LICENSE](LICENSE).
