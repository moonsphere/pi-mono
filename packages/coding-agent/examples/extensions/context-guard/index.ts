import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import {
	createFoldReference,
	renderExternalizedPreview,
	renderOpenResult,
	renderSearchResults,
	renderStats,
} from "./render.js";
import {
	type ContextGuardSettings,
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	getThresholdForTool,
	type ToolThreshold,
} from "./settings.js";
import { ContextGuardStore, mergeContextGuardDetails, sanitizeSessionKey } from "./store.js";
import { countBytes, countLines, createPreview } from "./truncate.js";

type ToolContent = TextContent | ImageContent;

interface TextExtraction {
	text: string;
	byteCount: number;
	lineCount: number;
}

const ContextOpenParams = Type.Object({
	id: Type.String({ description: "Externalized context id returned by context-guard." }),
	startLine: Type.Optional(Type.Number({ description: "1-based line number to start from.", minimum: 1 })),
	maxLines: Type.Optional(Type.Number({ description: "Maximum lines to return.", minimum: 1 })),
});

const ContextSearchParams = Type.Object({
	query: Type.String({ description: "Search query for externalized tool output." }),
	toolName: Type.Optional(Type.String({ description: "Optional tool name filter." })),
	limit: Type.Optional(Type.Number({ description: "Maximum results to return.", minimum: 1 })),
});

export default function contextGuardExtension(pi: ExtensionAPI) {
	const settings = DEFAULT_CONTEXT_GUARD_SETTINGS;
	const storesByCwd = new Map<string, Promise<ContextGuardStore>>();
	const aggregateWindows = new Map<string, number[]>();
	let warnedWriteFailure = false;

	pi.on("session_start", async (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const fallbackSessionKey = getFallbackSessionKey();
		const fallbackWindow = aggregateWindows.get(fallbackSessionKey);
		if (fallbackWindow && fallbackSessionKey !== sessionKey) {
			aggregateWindows.set(sessionKey, fallbackWindow);
			aggregateWindows.delete(fallbackSessionKey);
		} else {
			aggregateWindows.delete(sessionKey);
		}
		const storePromise = storesByCwd.get(ctx.cwd);
		if (storePromise && fallbackSessionKey !== sessionKey) {
			const store = await storePromise;
			await store.migrateSessionKey(fallbackSessionKey, sessionKey);
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		aggregateWindows.delete(getSessionKey(ctx));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		try {
			const storePromise = storesByCwd.get(ctx.cwd);
			if (storePromise) {
				const store = await storePromise;
				await store.drain();
			}
		} finally {
			aggregateWindows.delete(getSessionKey(ctx));
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		const extracted = extractText(event.content);
		if (!extracted || extracted.byteCount === 0) return undefined;

		const sessionKey = getSessionKey(ctx);
		const aggregateExceeded = recordAggregateBytes(sessionKey, extracted.byteCount, aggregateWindows, settings);
		const threshold = getThresholdForTool(event.toolName, settings);
		if (!shouldExternalize(extracted, threshold, aggregateExceeded)) return undefined;

		try {
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			const preview = createPreview(extracted.text, threshold.previewStrategy, {
				maxBytes: Math.max(1024, settings.previewMaxBytes - 1024),
				maxLines: settings.previewMaxLines,
			});
			const stored = await store.storeOutput({
				sessionId: sessionKey,
				toolName: event.toolName,
				text: extracted.text,
				input: event.input,
				isError: event.isError,
				previewStrategy: threshold.previewStrategy,
			});
			const foldReference = createFoldReference(stored.metadata, settings.contextOpenDefaultMaxLines);
			await store.writeFoldReference(stored.metadata, foldReference);
			const previewText = renderExternalizedPreview(stored.metadata, preview, settings.contextOpenDefaultMaxLines);

			return {
				content: replaceTextWithPreview(event.content, previewText),
				details: mergeContextGuardDetails(event.details, stored.contextGuard),
				isError: event.isError,
			};
		} catch (error) {
			if (!warnedWriteFailure) {
				warnedWriteFailure = true;
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(
					`context-guard: failed to externalize output (${message}); preserving original result`,
					"warning",
				);
			}
			return undefined;
		}
	});

	pi.registerTool({
		name: "context_open",
		label: "context_open",
		description:
			"Open a bounded slice of an externalized context-guard tool output. Prefer startLine and maxLines instead of reading the whole object.",
		parameters: ContextOpenParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			const result = await store.open(params.id, {
				startLine: params.startLine,
				maxLines: clampNumber(
					params.maxLines,
					settings.contextOpenDefaultMaxLines,
					1,
					settings.contextOpenMaxLines,
				),
			});
			return {
				content: [{ type: "text", text: renderOpenResult(result) }],
				details: {
					id: result.id,
					ok: result.ok,
					startLine: result.startLine,
					endLine: result.endLine,
					totalLines: result.totalLines,
					hasMore: result.hasMore,
				},
			};
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Opening context..."), 0, 0);
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			const firstLine = text.split("\n")[0] ?? "";
			return new Text(theme.fg(text.includes("expired or missing") ? "warning" : "success", firstLine), 0, 0);
		},
	});

	pi.registerTool({
		name: "context_search",
		label: "context_search",
		description: "Search externalized context-guard tool outputs by token overlap and return bounded snippets.",
		parameters: ContextSearchParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			const limit = clampNumber(params.limit, settings.contextSearchDefaultLimit, 1, settings.contextSearchMaxLimit);
			const results = await store.search(params.query, {
				toolName: params.toolName,
				limit,
				snippetLines: 12,
			});
			return {
				content: [{ type: "text", text: renderSearchResults(results) }],
				details: { query: params.query, count: results.length },
			};
		},
		renderResult(result, { isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Searching context..."), 0, 0);
			const content = result.content[0];
			const text = content?.type === "text" ? content.text : "";
			return new Text(theme.fg("success", text.split("\n")[0] ?? "context_search complete"), 0, 0);
		},
	});

	pi.registerCommand("context-guard:stats", {
		description: "Show context-guard storage statistics",
		handler: async (_args, ctx) => {
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			ctx.ui.notify(renderStats(store.getStats()), "info");
		},
	});

	pi.registerCommand("context-guard:purge", {
		description: "Delete context-guard data for this project",
		handler: async (_args, ctx) => {
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			await store.purge();
			aggregateWindows.delete(getSessionKey(ctx));
			ctx.ui.notify("context-guard store purged", "info");
		},
	});

	pi.registerCommand("context-guard:open", {
		description: "Open an externalized context-guard output by id",
		handler: async (args, ctx) => {
			const id = args.trim().split(/\s+/)[0];
			if (!id) {
				ctx.ui.notify("Usage: /context-guard:open <id>", "warning");
				return;
			}
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			const result = await store.open(id, { maxLines: settings.contextOpenDefaultMaxLines });
			ctx.ui.notify(renderOpenResult(result), result.ok ? "info" : "warning");
		},
	});
}

async function getStore(
	cwd: string,
	settings: ContextGuardSettings,
	storesByCwd: Map<string, Promise<ContextGuardStore>>,
): Promise<ContextGuardStore> {
	let storePromise = storesByCwd.get(cwd);
	if (!storePromise) {
		storePromise = createStore(cwd, settings).catch((error: unknown) => {
			storesByCwd.delete(cwd);
			throw error;
		});
		storesByCwd.set(cwd, storePromise);
	}
	return storePromise;
}

async function createStore(cwd: string, settings: ContextGuardSettings): Promise<ContextGuardStore> {
	const store = new ContextGuardStore(cwd, settings);
	await store.initialize();
	return store;
}

function extractText(content: ToolContent[]): TextExtraction | undefined {
	const textParts: string[] = [];
	for (const item of content) {
		if (item.type === "text") {
			textParts.push(item.text);
		}
	}
	if (textParts.length === 0) return undefined;
	const text = textParts.join("\n");
	return {
		text,
		byteCount: countBytes(text),
		lineCount: countLines(text),
	};
}

function replaceTextWithPreview(content: ToolContent[], previewText: string): ToolContent[] {
	let inserted = false;
	const nextContent: ToolContent[] = [];
	for (const item of content) {
		if (item.type === "text") {
			if (!inserted) {
				nextContent.push({ type: "text", text: previewText });
				inserted = true;
			}
			continue;
		}
		nextContent.push(item);
	}
	if (!inserted) nextContent.unshift({ type: "text", text: previewText });
	return nextContent;
}

function recordAggregateBytes(
	sessionKey: string,
	byteCount: number,
	aggregateWindows: Map<string, number[]>,
	settings: ContextGuardSettings,
): boolean {
	const window = aggregateWindows.get(sessionKey) ?? [];
	window.push(byteCount);
	while (window.length > settings.aggregateWindowSize) {
		window.shift();
	}
	aggregateWindows.set(sessionKey, window);
	return window.reduce((sum, value) => sum + value, 0) > settings.aggregateMaxBytes;
}

function shouldExternalize(extracted: TextExtraction, threshold: ToolThreshold, aggregateExceeded: boolean): boolean {
	return aggregateExceeded || extracted.byteCount > threshold.maxBytes || extracted.lineCount > threshold.maxLines;
}

function getSessionKey(ctx: ExtensionContext): string {
	return sanitizeSessionKey(ctx.sessionManager.getSessionId());
}

function getFallbackSessionKey(): string {
	return sanitizeSessionKey(undefined);
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.floor(value), min), max);
}
