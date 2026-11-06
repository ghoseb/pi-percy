# Changelog

All notable changes to pi-percy. Generated from the git history by [git-cliff](https://git-cliff.org).

## [1.1.1] - 2026-11-06

### Features

- **compaction:** Add in-place context compaction core for pi
- **compaction:** Add compact_in_place and recall tools for pi sessions
- **compaction:** Nudge the agent to compact as its context grows
- **compaction:** Compact idle conversations in one extra turn
- **compaction:** Add settings, commands and TUI rendering
- **compaction:** Improve compaction card rendering
- **compaction:** Clarify tool guidance and calls
- **debug:** Add compact-debug command completions
- **compaction:** Collapse validation results in TUI
- **compaction:** Clarify tool result feedback
- **commands:** Add pi-percy recovery controls
- **compaction:** Guide completed task cleanup
- **compaction:** Offer validated collapse units
- **compaction:** Batch automatic context savings
- **commands:** Add compaction status and rewind confirmation
- **tools:** Record compact results in details
- **recall:** Tell the agent when to use recall
- **recall:** Search messages and compaction notes
- **recall:** Return results as data to scripts
- **index:** Label pi's summary and favor substantial compactions
- **index:** Fold small protected rows and list only worthwhile units
- **recall:** Show tool call arguments as readable lines
- **recall:** Search messages from extensions with role custom

### Bug fixes

- **compaction:** Keep message numbers across forks, warn on small model windows
- **idle:** Restore timer after reload and resume
- **compaction:** Preserve system message boundaries
- **compaction:** Tolerate existing system-boundary errors
- **idle:** Force system prompt before compaction
- **idle:** Wait full interval after session load
- **idle:** Fence stale compaction timers
- **compaction:** Check system boundaries as pi-ai sends them
- **commands:** Never change the active tools
- **idle:** Stop forcing the system prompt
- **nudge:** Take nudges before each request, as Shelley does
- **idle:** No second idle run after a /tree jump
- **nudge:** Defer a nudge while messages are queued
- **compaction:** Report unit problems with the others
- **render:** Count collapse units on the call card
- **tree:** Cancel a jump into the middle of a compaction
- **recall:** Drop thinking blocks from recalled messages
- **tools:** Stop scripts from calling compact_in_place
- **nudge:** Drop nudges made stale by pi's own compaction

### Refactoring

- **commands:** Rename compaction undo to rewind
- **compaction:** Drop the minimum automatic saving
- **compaction:** Format problem lists in one place
- **messages:** One guard for editable messages
- One predicate per pi-percy entry kind
- **messages:** One content-to-text helper
- One plain-object guard
- **index:** Hold at most one pending compaction
- **idle:** Let armIdle decide whether to arm
- **compaction:** Pass system boundaries directly
- **view:** Default the record number
- **tools:** List the id fields in tables
- **units:** Document collapsesAlone where it lives
- **nudge:** Decide nudges in nudge.ts
- **idle:** Own the idle timer in a scheduler
- **commands:** Move the commands to commands.ts
- **tools:** Move the tools to tools.ts
- **render:** Show compact results from details
- **render:** Store idle minutes and index rows for their cards
- **render:** One label header
- **render:** Store the context size in context nudges

### Documentation

- Add README.md
- **readme:** Describe npm install and rewrite in simplified English

### Tests

- **compaction:** Check pi's own compaction runs on the compacted view
- **recall:** Cover direct message ranges
- **compaction:** Add generated edit projection checks
- **compaction:** Cover recall and idle regressions
- **compaction:** Preserve generated system boundaries
- Property-test whole sessions
- Cover queued messages, branch summaries and pi's compaction

### Build

- **release:** Generate the changelog with git-cliff and add pnpm release

### Miscellaneous

- **tooling:** Add pnpm strict checks and formatting
- **package:** Prepare pi-percy 1.1.0 for npm
