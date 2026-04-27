---
title: Pi Context Guard Extension Architecture
date: 2026-04-27
category: architecture-patterns
module: pi-mono
problem_type: architecture_pattern
component: assistant
severity: medium
applies_when:
  - "Building coding-agent extensions that must keep large tool outputs out of model context"
  - "Adding retrieval-backed context management without changing Pi core"
  - "Preserving cache-stable placeholders while supporting bounded recall"
related_components:
  - tooling
  - development_workflow
  - testing_framework
tags:
  - pi
  - coding-agent
  - context-management
  - tool-results
  - externalization
  - retrieval
  - prompt-cache
  - extensions
---

# Pi Context Guard Extension Architecture

## Context

Pi's session model can allow large tool results to enter durable transcript history before compaction has a chance to help. Codex and Claude Code avoid this earlier in the pipeline with tool-output caps, persisted full-output storage, microcompact paths, and cache-stable replacement text. Pi's plugin surface made it possible to implement a userland version without forcing the philosophy into core.

The Phase 1 implementation lives in `packages/coding-agent/examples/extensions/context-guard/` and intercepts final `tool_result` events. It externalizes bulky text to `.pi/context-guard/`, returns a bounded preview to the transcript, and exposes `context_open` / `context_search` so the model or user can retrieve slices on demand.

Session history showed one earlier option that was rejected: relying on `context-mode` alone. It is useful as generic external retrieval, but it does not prevent Pi's built-in `tool_result` output from entering the transcript unless the model chooses the right tools first. The context guard has to sit on Pi's `tool_result` seam instead. (session history)

## Guidance

Externalize only final `tool_result` content. Do not externalize `tool_execution_update` streaming chunks; they are not the durable transcript boundary and are harder to make idempotent.

```ts
pi.on("tool_result", async (event, ctx) => {
  const extracted = extractText(event.content);
  const aggregateExceeded = recordAggregateBytes(sessionKey, extracted.byteCount);

  if (!shouldExternalize(extracted, threshold, aggregateExceeded)) {
    return undefined;
  }

  // Store full text out of band, then return a bounded preview.
});
```

Use three separate representations:

- Full body: `.pi/context-guard/objects/<session>/<id>.txt`
- Metadata/search index: `.pi/context-guard/index/<session>.jsonl`
- Future fold reference: `.pi/context-guard/replacements.jsonl`

Keep preview text and fold-reference text distinct. The preview goes into session history and can be around 12 KB. The fold reference is a one-line, byte-stable replacement for later microcompact work. For the same id, the fold reference must never be regenerated with different wording.

Use per-tool thresholds plus an aggregate window. Single huge outputs are obvious, but transcript floods often come from many medium results.

```ts
bash: 50 * KB
grep: 100 * KB
read: 200 * KB
web: 50 * KB
fallback: 50 * KB

// Last 20 final tool_result original text byte counts.
aggregateMaxBytes: 1 * MB
```

Choose preview strategy by tool shape:

- command-like output: head + middle-strip + tail
- search-like output: head-only
- all byte truncation: UTF-8 safe

Make retrieval bounded in implementation, not only in the API description. `context_open` and `context_search` should stream line ranges and snippets instead of `readFile()` on the full externalized object.

```ts
await context_open({
  id: "cg_...",
  startLine: 400,
  maxLines: 80,
});

await context_search({
  query: "TypeError constructor",
  toolName: "bash",
  limit: 5,
});
```

Rank search from stored metadata/sketches first, then open only top candidates for bounded snippets. Use null-prototype maps or own-property checks for token sketches because tool output is untrusted text and may contain keys like `constructor` or `__proto__`.

Use a single metadata write queue for append-only JSONL writes. This prevents interleaved records and makes duplicate fold-reference writes idempotent.

```ts
metadataQueue = metadataQueue.then(async () => {
  if (replacementsById.has(id)) return;
  await appendFile(replacementsPath, `${JSON.stringify(record)}\n`);
});
```

Fail open. The extension should reduce context pressure without making ordinary tool execution brittle:

- store initialization failure returns the original result and emits one warning
- rejected store promises are removed so later calls can retry
- replacement append failure marks degraded mode but does not block externalization
- metadata write failure rolls back the object file to avoid orphan data
- repeated write failures trip a circuit breaker
- `session_start`, `session_shutdown`, and `session_compact` reset session-scoped aggregate state

Preserve tool-result semantics:

- keep `isError`
- preserve existing details under `details.contextGuard`, or under `{ original, contextGuard }` for non-object details
- preserve mixed text/image ordering
- do not externalize image bytes in Phase 1

## Why This Matters

Transcript floods are expensive and degrade reasoning. Waiting for normal compaction means the model may already have paid for large tool results, and compaction can blur exact details the model later needs.

Prompt cache stability is easy to lose. If old placeholders are generated differently on each request, the changing bytes invalidate cache after that point. Freezing fold references at the same time as externalization keeps later microcompact work cache-stable.

Externalization can accidentally move the bottleneck instead of solving it. If retrieval tools read multi-megabyte files into memory before slicing, the transcript is smaller but the request path can still hit local latency or memory failures. Bounded retrieval must be enforced by streaming or equivalent limits.

Out-of-band storage needs cleanup invariants. Writing the object before metadata is fine only if metadata failure unlinks the object; otherwise retention cannot discover the orphaned file.

## When To Apply

- When an agent framework stores tool results in durable session history.
- When tools can emit unbounded text output.
- When core compaction is late, opaque, or not plugin-aware.
- When users need recoverable full output rather than silent truncation.
- When prompt-cache stability matters for cost or latency.

Do not apply this exact Phase 1 pattern to large binary/image payloads. This implementation externalizes text only and leaves image content in place.

## Examples

Externalized result lifecycle:

```text
final tool_result full text
  -> classify by original bytes and aggregate window
  -> write .pi/context-guard/objects/<session>/<id>.txt
  -> append metadata JSONL
  -> append fold-reference JSONL
  -> return bounded preview into session
```

Review fixes worth preserving as regression tests:

- `context_open` / `context_search` initially read full object bodies; fixed with bounded streaming line reads.
- `getStore()` cached rejected initialization promises; fixed by deleting failed promises and retrying.
- replacement append failure initially broke externalization; fixed as best-effort degraded mode.
- `TokenSketch` used a normal object; fixed with null-prototype maps and own-property scoring.
- `session_compact` aggregate reset was missing; fixed by clearing the ring buffer after compaction.
- metadata half-failure left orphan object files; fixed with unlink rollback.
- `webSearch` matched generic `search` before web thresholds; fixed by checking web tools first.
- timestamp-only temp filenames had collision risk; fixed with UUID suffixes.

Verification for the Phase 1 implementation:

```text
npx tsx ../../node_modules/vitest/dist/cli.js --run test/context-guard-store.test.ts test/context-guard-extension.test.ts
# 31 tests passed

npm run check
# passed

npx biome check --error-on-warnings packages/coding-agent/examples/extensions/context-guard \
  packages/coding-agent/test/context-guard-store.test.ts \
  packages/coding-agent/test/context-guard-extension.test.ts
# passed
```

Implementation commit:

- `ac4f9dc4 feat(coding-agent): add context guard extension`
- pushed to `moon/feat/pi-context-guard`

## Related

Implementation files:

- `packages/coding-agent/examples/extensions/context-guard/index.ts`
- `packages/coding-agent/examples/extensions/context-guard/store.ts`
- `packages/coding-agent/examples/extensions/context-guard/truncate.ts`
- `packages/coding-agent/examples/extensions/context-guard/search.ts`
- `packages/coding-agent/examples/extensions/context-guard/render.ts`
- `packages/coding-agent/examples/extensions/context-guard/settings.ts`

Regression tests:

- `packages/coding-agent/test/context-guard-store.test.ts`
- `packages/coding-agent/test/context-guard-extension.test.ts`

Related GitHub issues surfaced during compound research:

- `#3114` — collapsible tool output for non-destructive tools
- `#3383` — crash on large tool output
- `#2608` — compaction kept-message loss after second compaction
- `#2626` — context overflow not detected by auto-compaction
- `#3556` — extension hook errors should not crash the agent loop
- `#2773` — `tool_result` event handlers and custom rendering

Future phases:

- U4: microcompact request view using `replacements.jsonl`
- U5: bounded session memory summary
- U6: config, retention, documentation, and tuning controls
