---
title: Separate Tool Result Display Content From Model-Visible Content
date: 2026-04-27
category: best-practices
module: pi-agent
problem_type: best_practice
component: assistant
severity: medium
applies_when:
  - "Extensions or hooks need to shrink, redact, or summarize tool output before the next LLM call"
  - "The UI/session transcript must preserve full tool output while the model sees a bounded representation"
  - "Context management code externalizes tool output and later folds old results"
related_components:
  - tooling
  - development_workflow
tags:
  - tool-results
  - llm-content
  - context-management
  - extensions
  - coding-agent
---

# Separate Tool Result Display Content From Model-Visible Content

## Context

Tool result post-processing originally had one `content` channel. That was too coarse for context-guard style extensions: replacing `content` with a preview kept the model context small, but also changed the durable session and display content. Keeping the full output in `content` and adding a separate `llmContent` override lets hooks shrink what the model sees without losing the original transcript payload.

The pattern was added in commit `3ef0edbd feat(agent): add tool result llm content channel` after implementing the context-guard extension. The follow-up review verified that `llmContent` is stripped before provider calls, while fields such as `isError`, `toolCallId`, `toolName`, `details`, and `timestamp` are preserved.

## Guidance

Use `content` for session/display state. Use `llmContent` only for the model-visible replacement.

```ts
return {
  llmContent: replaceTextWithPreview(event.content, previewText),
  details: mergeContextGuardDetails(event.details, stored.contextGuard),
  isError: event.isError,
};
```

Carry `llmContent` through hook and agent-loop boundaries as an optional field, not as a mutation of the original content:

- `AfterToolCallResult.llmContent` lets agent hooks return a model-only override.
- `ToolResultEventResult.llmContent` lets coding-agent extensions chain model-only edits.
- `ToolResultMessage.llmContent` stores the override on the message until conversion.
- `convertToLlm` replaces provider-facing `content` with `llmContent` and strips the non-provider field.

Converters must remove `llmContent` before the message reaches a provider:

```ts
if (message.role === "toolResult") {
  const { llmContent, ...toolResultMessage } = message;
  return [{
    ...toolResultMessage,
    content: llmContent ?? toolResultMessage.content,
  }];
}
```

For request-time folding, rewrite `message.llmContent` rather than `message.content`:

```ts
const currentContent = message.llmContent ?? message.content;
const nextContent = replaceTextWithFoldReference(currentContent, replacement);
message.llmContent = nextContent;
```

## Why This Matters

Display/session content and model context have different invariants. Display content should remain faithful to what the tool produced. Model-visible content should be bounded, cache-stable, and safe to send to the provider. Collapsing both into one field forces extensions to choose between transcript fidelity and context control.

The separate channel also keeps error and metadata semantics intact. Oversized error outputs can be summarized for the model while preserving `isError`; mixed text/image results can preserve image ordering; downstream UI can still inspect full content while the LLM receives only the preview or fold reference.

## When to Apply

- When `afterToolCall` needs to summarize or redact a tool result for the next LLM call.
- When a `tool_result` extension externalizes large text but should keep the visible transcript unchanged.
- When old externalized results are folded at context time and only the request view should change.
- When provider-facing converters need to support app-specific message fields without leaking them to LLM APIs.

Do not use `llmContent` for UI-only annotations. If the display/session result should change, return `content` instead.

## Examples

Context-guard externalization now returns a model-only preview:

```ts
// packages/coding-agent/examples/extensions/context-guard/index.ts
return {
  llmContent: replaceTextWithPreview(event.content, previewText),
  details: mergeContextGuardDetails(event.details, stored.contextGuard),
  isError: event.isError,
};
```

The session message can keep full output while the next LLM call sees only the preview:

```ts
// packages/agent/src/agent-loop.ts
const message: ToolResultMessage = {
  role: "toolResult",
  toolCallId: finalized.toolCall.id,
  toolName: finalized.toolCall.name,
  content: finalized.result.content,
  details: finalized.result.details,
  isError: finalized.isError,
  timestamp: Date.now(),
};

if (finalized.llmContent !== undefined) {
  message.llmContent = finalized.llmContent;
}
```

Regression coverage should assert both halves of the contract:

- The emitted/session tool result keeps full `content`.
- The provider-facing conversion uses `llmContent` as `content`.
- The converted message does not include `llmContent`.
- `isError` and details survive conversion.
- Multiple extensions can chain `llmContent` changes without mutating display content.

Implemented tests:

- `packages/agent/test/agent-loop.test.ts` covers `afterToolCall` `llmContent` with preserved result content.
- `packages/agent/test/agent.test.ts` covers the default converter stripping `llmContent`.
- `packages/coding-agent/test/extensions-runner.test.ts` covers chained extension `llmContent` modifications.
- `packages/coding-agent/test/context-guard-extension.test.ts` covers context-guard previews and fold references using model-visible content.

## Related

- `docs/solutions/architecture-patterns/pi-context-guard-extension-architecture-2026-04-27.md` documents the broader context-guard architecture that motivated this channel.
- `packages/agent/src/types.ts` defines hook semantics for `AfterToolCallResult.llmContent`.
- `packages/ai/src/types.ts` defines `ToolResultMessage.llmContent`.
- `packages/agent/src/agent.ts` and `packages/coding-agent/src/core/messages.ts` strip `llmContent` during LLM conversion.
- `packages/coding-agent/src/core/extensions/runner.ts` chains extension-level `llmContent` patches.
