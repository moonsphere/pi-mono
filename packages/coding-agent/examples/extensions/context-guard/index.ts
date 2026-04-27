import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ContextUsage, ExtensionAPI, ExtensionContext, ToolCallEvent } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { extractContextGuardId, shouldLoadFoldReferencesForContext, transformContextMessages } from "./context.js";
import { ContextGuardMemory } from "./memory.js";
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
	isCommandLikeTool,
	loadContextGuardSettings,
	type ToolThreshold,
} from "./settings.js";
import {
	ContextGuardStore,
	type FoldReferenceLookup,
	loadFoldReferences,
	mergeContextGuardDetails,
	sanitizeSessionKey,
} from "./store.js";
import { countBytes, countLines, createPreview } from "./truncate.js";

type ToolContent = TextContent | ImageContent;

const RETENTION_INTERVAL_MS = 5 * 60 * 1000;

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
	const settingsByCwd = new Map<string, Promise<ContextGuardSettings>>();
	const storesByCwd = new Map<string, Promise<ContextGuardStore>>();
	const foldReferencesByCwd = new Map<string, Promise<Map<string, string>>>();
	const aggregateWindows = new Map<string, number[]>();
	const latestContextUsage = new Map<string, ContextUsage>();
	const lastRetentionByCwd = new Map<string, number>();
	const memory = new ContextGuardMemory();
	let warnedWriteFailure = false;

	pi.on("session_start", async (_event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		const sessionKey = getSessionKey(ctx);
		const fallbackSessionKey = getFallbackSessionKey();
		await preloadFoldReferences(ctx.cwd, settings, foldReferencesByCwd);
		const fallbackWindow = aggregateWindows.get(fallbackSessionKey);
		if (fallbackWindow && fallbackSessionKey !== sessionKey) {
			aggregateWindows.set(sessionKey, fallbackWindow);
			aggregateWindows.delete(fallbackSessionKey);
		} else {
			aggregateWindows.delete(sessionKey);
		}
		const fallbackUsage = latestContextUsage.get(fallbackSessionKey);
		if (fallbackUsage && fallbackSessionKey !== sessionKey) {
			latestContextUsage.set(sessionKey, fallbackUsage);
			latestContextUsage.delete(fallbackSessionKey);
		} else {
			latestContextUsage.delete(sessionKey);
		}
		memory.migrateSessionKey(fallbackSessionKey, sessionKey);
		const storePromise = storesByCwd.get(ctx.cwd);
		if (storePromise && fallbackSessionKey !== sessionKey) {
			const store = await storePromise;
			await store.migrateSessionKey(fallbackSessionKey, sessionKey);
			await store.applyRetention({ liveIds: getLiveContextGuardIds(ctx, memory, sessionKey) }).catch(() => {});
		}
	});

	pi.on("session_compact", async (event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		const sessionKey = getSessionKey(ctx);
		memory.recordCompaction(sessionKey, event, settings);
		aggregateWindows.delete(sessionKey);
		latestContextUsage.delete(sessionKey);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		try {
			const storePromise = storesByCwd.get(ctx.cwd);
			if (storePromise) {
				const store = await storePromise;
				await store.drain();
			}
		} finally {
			aggregateWindows.delete(sessionKey);
			latestContextUsage.delete(sessionKey);
			memory.reset(sessionKey);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		await preloadFoldReferences(ctx.cwd, settings, foldReferencesByCwd);
		memory.recordSystemMetadata(getSessionKey(ctx), event, ctx.model?.id);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "user") return;
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		memory.recordUserMessage(getSessionKey(ctx), event.message, settings);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		const sessionKey = getSessionKey(ctx);
		if (event.preparation.messagesToSummarize.length > 0 || event.preparation.turnPrefixMessages.length > 0) {
			return undefined;
		}
		const summary = memory.renderCompactionSummary(sessionKey, settings, event.preparation.tokensBefore);
		if (!summary) return undefined;
		return {
			compaction: {
				summary,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { contextGuard: true },
			},
		};
	});

	pi.on("context", async (event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		const sessionKey = getSessionKey(ctx);
		const usage = ctx.getContextUsage();
		if (usage?.percent !== null && usage?.percent !== undefined) {
			latestContextUsage.set(sessionKey, usage);
		}
		const replacements = await getFoldReferenceLookup(
			ctx.cwd,
			storesByCwd,
			foldReferencesByCwd,
			shouldLoadFoldReferencesForContext(event.messages, settings, usage),
		);
		const messages = transformContextMessages({
			messages: event.messages,
			sessionKey,
			settings,
			replacements,
			memory,
			usage,
		});
		return messages ? { messages } : undefined;
	});

	pi.on("tool_call", async (event, ctx) => {
		return guardToolCall(event, ctx);
	});

	pi.on("tool_result", async (event, ctx) => {
		const settings = await getSettings(ctx.cwd, settingsByCwd);
		const extracted = extractText(event.content);
		if (!extracted || extracted.byteCount === 0) {
			memory.recordToolResult(getSessionKey(ctx), event, settings);
			return undefined;
		}

		const sessionKey = getSessionKey(ctx);
		const aggregateExceeded = recordAggregateBytes(sessionKey, extracted.byteCount, aggregateWindows, settings);
		const usageExceeded = isUsageExternalizationSignal(latestContextUsage.get(sessionKey), settings);
		const threshold = getThresholdForTool(event.toolName, settings);
		if (!shouldExternalize(extracted, threshold, aggregateExceeded, usageExceeded)) {
			memory.recordToolResult(sessionKey, event, settings);
			return undefined;
		}

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
			foldReferencesByCwd.delete(ctx.cwd);
			memory.recordToolResult(sessionKey, event, settings, stored.metadata);
			await maybeApplyRetention(ctx, store, memory, sessionKey, lastRetentionByCwd).catch(() => {});
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
			memory.recordToolResult(sessionKey, event, settings);
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
			const settings = await getSettings(ctx.cwd, settingsByCwd);
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
			const settings = await getSettings(ctx.cwd, settingsByCwd);
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
			const settings = await getSettings(ctx.cwd, settingsByCwd);
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			ctx.ui.notify(renderStats(store.getStats()), "info");
		},
	});

	pi.registerCommand("context-guard:purge", {
		description: "Delete context-guard data for this project",
		handler: async (_args, ctx) => {
			const force = _args.split(/\s+/).includes("--force");
			const sessionKey = getSessionKey(ctx);
			if (!force && getLiveContextGuardIds(ctx, memory, sessionKey).size > 0) {
				ctx.ui.notify("context-guard purge refused for active session; rerun with --force", "warning");
				return;
			}
			const settings = await getSettings(ctx.cwd, settingsByCwd);
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			await store.purge();
			aggregateWindows.delete(sessionKey);
			latestContextUsage.delete(sessionKey);
			lastRetentionByCwd.delete(ctx.cwd);
			memory.reset(sessionKey);
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
			const settings = await getSettings(ctx.cwd, settingsByCwd);
			const store = await getStore(ctx.cwd, settings, storesByCwd);
			const result = await store.open(id, { maxLines: settings.contextOpenDefaultMaxLines });
			ctx.ui.notify(renderOpenResult(result), result.ok ? "info" : "warning");
		},
	});
}

async function getSettings(
	cwd: string,
	settingsByCwd: Map<string, Promise<ContextGuardSettings>>,
): Promise<ContextGuardSettings> {
	let settingsPromise = settingsByCwd.get(cwd);
	if (!settingsPromise) {
		settingsPromise = loadContextGuardSettings(cwd).catch(() => DEFAULT_CONTEXT_GUARD_SETTINGS);
		settingsByCwd.set(cwd, settingsPromise);
	}
	return settingsPromise;
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

async function getFoldReferenceLookup(
	cwd: string,
	storesByCwd: Map<string, Promise<ContextGuardStore>>,
	foldReferencesByCwd: Map<string, Promise<Map<string, string>>>,
	shouldLoad: boolean,
): Promise<FoldReferenceLookup> {
	const storePromise = storesByCwd.get(cwd);
	if (storePromise) return storePromise;
	if (!shouldLoad) return { getReplacement: () => undefined };
	const referencesPromise = foldReferencesByCwd.get(cwd);
	if (!referencesPromise) return { getReplacement: () => undefined };
	const references = await referencesPromise;
	return {
		getReplacement: (id) => references.get(id),
	};
}

async function preloadFoldReferences(
	cwd: string,
	settings: ContextGuardSettings,
	foldReferencesByCwd: Map<string, Promise<Map<string, string>>>,
): Promise<void> {
	if (foldReferencesByCwd.has(cwd)) return;
	const referencesPromise = loadFoldReferences(cwd, settings).catch(() => new Map<string, string>());
	foldReferencesByCwd.set(cwd, referencesPromise);
	await referencesPromise;
}

async function maybeApplyRetention(
	ctx: ExtensionContext,
	store: ContextGuardStore,
	memory: ContextGuardMemory,
	sessionKey: string,
	lastRetentionByCwd: Map<string, number>,
): Promise<void> {
	const now = Date.now();
	const lastRetention = lastRetentionByCwd.get(ctx.cwd) ?? 0;
	if (now - lastRetention < RETENTION_INTERVAL_MS) return;
	lastRetentionByCwd.set(ctx.cwd, now);
	await store.applyRetention({ liveIds: getLiveContextGuardIds(ctx, memory, sessionKey), now });
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

function shouldExternalize(
	extracted: TextExtraction,
	threshold: ToolThreshold,
	aggregateExceeded: boolean,
	usageExceeded: boolean,
): boolean {
	return (
		aggregateExceeded ||
		usageExceeded ||
		extracted.byteCount > threshold.maxBytes ||
		extracted.lineCount > threshold.maxLines
	);
}

function isUsageExternalizationSignal(usage: ContextUsage | undefined, settings: ContextGuardSettings): boolean {
	return usage?.percent !== null && usage?.percent !== undefined && usage.percent >= settings.memoryInjectionPercent;
}

function guardToolCall(event: ToolCallEvent, ctx: ExtensionContext) {
	if (!isCommandLikeTool(event.toolName)) return undefined;
	const command = extractCommand(event.input);
	if (!command) return undefined;
	if (hasUnboundedYesCommand(command) || hasUnboundedDevUrandom(command)) {
		return {
			block: true,
			reason:
				"context-guard blocked a predictably unbounded command. Pipe through head or write bounded output to a file.",
		};
	}
	if (hasCurlOrWgetToStdout(command)) {
		const message = "context-guard: curl/wget appears to write to stdout; prefer -o/--output or bounded output.";
		ctx.ui.notify(message, "warning");
		return undefined;
	}
	return undefined;
}

function extractCommand(input: Record<string, unknown>): string | undefined {
	const command = input.command;
	return typeof command === "string" ? command : undefined;
}

function hasCurlOrWgetToStdout(command: string): boolean {
	if (/(^|[;&|]\s*)curl\b/.test(command)) {
		if (/\s(-o|--output)\s+\S+/.test(command)) return false;
		if (/(^|\s)>/.test(command)) return false;
		return true;
	}
	if (/(^|[;&|]\s*)wget\b/.test(command)) {
		return /\s(-q?O\s*-|-q?O-|--output-document[=\s]-)/.test(command);
	}
	return false;
}

function hasUnboundedYesCommand(command: string): boolean {
	return splitShellCommandSegments(command).some((segment) => {
		if (/\byes\b[\s\S]*\|\s*head\b/.test(segment) || /\btimeout\s+\S+\s+yes\b/.test(segment)) return false;
		return /(^|\|\s*)yes(\s|$)/.test(segment.trim());
	});
}

function hasUnboundedDevUrandom(command: string): boolean {
	return splitShellCommandSegments(command).some((segment) => {
		if (!/\/dev\/urandom/.test(segment)) return false;
		if (/\bhead\s+-c\s+\S+\s+\/dev\/urandom\b/.test(segment)) return false;
		if (/\bdd\b[\s\S]*\bif=\/dev\/urandom\b[\s\S]*\bcount=\S+/.test(segment)) return false;
		if (/\/dev\/urandom[\s\S]*\|\s*head\b/.test(segment)) return false;
		if (/\btimeout\s+\S+\s+/.test(segment)) return false;
		return true;
	});
}

function splitShellCommandSegments(command: string): string[] {
	return command
		.split(/(?:&&|\|\||;|\n)/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
}

function getSessionKey(ctx: ExtensionContext): string {
	return sanitizeSessionKey(ctx.sessionManager.getSessionId());
}

function getFallbackSessionKey(): string {
	return sanitizeSessionKey(undefined);
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
	const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
	return Math.min(Math.max(Math.floor(candidate), min), max);
}

function getLiveContextGuardIds(ctx: ExtensionContext, memory: ContextGuardMemory, sessionKey: string): Set<string> {
	const ids = memory.getAllLiveExternalizedIds();
	for (const id of memory.getLiveExternalizedIds(sessionKey)) ids.add(id);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "message") {
			collectIdsFromUnknown(entry.message, ids);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			collectIdsFromText(entry.summary, ids);
		} else if (entry.type === "custom_message") {
			collectIdsFromUnknown(entry.content, ids);
			collectIdsFromUnknown(entry.details, ids);
		} else if (entry.type === "custom") {
			collectIdsFromUnknown(entry.data, ids);
		}
	}
	return ids;
}

function collectIdsFromUnknown(value: unknown, ids: Set<string>): void {
	if (typeof value === "string") {
		collectIdsFromText(value, ids);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectIdsFromUnknown(item, ids);
		return;
	}
	if (!isRecord(value)) return;
	const id = extractContextGuardId(value);
	if (id) ids.add(id);
	for (const [key, field] of Object.entries(value)) {
		if (key === "data" && typeof field === "string" && field.length > 1024) continue;
		collectIdsFromUnknown(field, ids);
	}
}

function collectIdsFromText(text: string, ids: Set<string>): void {
	for (const match of text.matchAll(/\bcg_[A-Za-z0-9_-]+\b/g)) {
		ids.add(match[0]);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
