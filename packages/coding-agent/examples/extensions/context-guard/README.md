# Context Guard Extension

`context-guard` keeps large tool results from repeatedly entering the model context. It externalizes oversized final tool results into `.pi/context-guard/objects`, leaves a bounded preview in the session, and exposes `context_open` / `context_search` for recovery.

## Usage

Load the extension from this directory:

```bash
pi --extension packages/coding-agent/examples/extensions/context-guard/index.ts
```

The extension is automatic for final `tool_result` messages. Streaming `tool_execution_update` events are not externalized.

## Defaults

- `bash` and command-like tools: 50KB or 2000 lines
- `read`: 200KB or 2000 lines
- `grep`, `find`, `ls`, and search-like tools: 100KB or 2000 lines
- web fetch/search-like tools: 50KB or 2000 lines
- unknown text tools: 50KB or 2000 lines
- aggregate budget: 1MB across the last 20 final tool results in the current session
- preview cap: 12KB
- request memory injection: 70% context usage
- request-only microcompact: 80% context usage
- recent output list: 20 entries by default, capped at 100

Request microcompact uses persisted fold-reference text from `replacements.jsonl` and does not mutate the stored session history.
If config overrides put memory injection at or after request microcompact, the extension normalizes the pair so memory injection still happens first with at least a five percentage point gap.
The extension also publishes a compact footer status with object count, stored bytes, live id count, and known context usage.

## Configuration

Project-local config lives at `.pi/context-guard/config.json`. It does not participate in Pi's user/project/global settings merge in v1.

```json
{
  "aggregateMaxBytes": 1048576,
  "memoryInjectionPercent": 70,
  "requestMicrocompactPercent": 80,
  "thresholds": {
    "bash": { "maxBytes": 51200, "maxLines": 2000, "previewStrategy": "head-tail-middle-strip" },
    "read": { "maxBytes": 204800, "maxLines": 2000, "previewStrategy": "head" }
  }
}
```

Smaller aggregate windows are more sensitive to output floods. Larger windows are quieter but allow more medium-sized results into the visible transcript before proactive externalization starts.

## Commands And Tools

- `context_open({ id, startLine, maxLines })`: open a bounded slice of an externalized output.
- `context_search({ query, toolName, limit })`: search stored output sketches and return bounded snippets.
- `/context`: show current context usage, estimated category breakdown, context-guard storage, and command/tool inventory.
- `/context-guard:context`: same report as `/context`; add `--verbose` for tool and command details.
- `/context-guard:list [--limit n] [--tool name]`: list recent externalized outputs with `context_open` recovery commands.
- `/context-guard:open <id>`: open an externalized output from the CLI.
- `/context-guard:settings`: show the effective sanitized context-guard configuration.
- `/context-guard:stats`: show object counts, bytes, and per-tool totals.
- `/context-guard:purge --force`: remove current project context-guard data. Without `--force`, purge refuses active sessions with live externalized ids.

## Known Limitations

- Aggregate budget state is in-memory and resets on extension reload or process restart.
- Request microcompact thresholds are static defaults in v1. They are not yet dynamically derived from Pi's `contextWindow - reserveTokens` auto-compaction trigger, so small-context models may compact before request microcompact runs.
- The extension does not replace Pi's normal LLM compaction when Pi has messages or turn-prefix content to summarize. It only provides a structured context-guard summary for no-body compaction preparations, avoiding data loss from dropping Pi's default summary.
- `replacements.jsonl` is append-only and kept for prompt-cache stability. It is removed by purge.
- Large image-only outputs are out of scope for v1; only text blocks are externalized.
- If an object expires but a fold-reference remains, `context_open` returns an expired or missing-object message.
