import type { ContextUsage, ExtensionContext, SlashCommandInfo, ToolInfo } from "@mariozechner/pi-coding-agent";
import { buildSessionContext, DEFAULT_COMPACTION_SETTINGS } from "@mariozechner/pi-coding-agent";
import { type ContextProjection, projectContextMessages } from "./context.js";
import type { ContextGuardMemory } from "./memory.js";
import type { ContextGuardSettings } from "./settings.js";
import type { FoldReferenceLookup, StoreStats } from "./store.js";
import { countBytes } from "./truncate.js";

export interface ContextUsageCategory {
	label: string;
	tokens: number | null;
	percent: number | null;
	estimated: boolean;
	note?: string;
}

export interface ContextUsageGridCell {
	label: string;
	tokens: number | null;
	percent: number | null;
	char: string;
	estimated: boolean;
}

export interface ContextGuardUsageDetails {
	storeAvailable: boolean;
	storeDir?: string;
	objectCount: number;
	totalBytes: number;
	replacementCount: number;
	replacementDegraded: boolean;
	perTool: Record<string, { count: number; bytes: number }>;
	liveIdCount: number;
	liveIdSamples: string[];
	rawMessageTokens: number;
	projectedMessageTokens: number;
	projectedSavingsTokens: number;
	foldedCount: number;
	removedMemoryMarkers: number;
	memoryAvailableTokens: number;
	memoryInjected: boolean;
	shouldInjectMemory: boolean;
	shouldFold: boolean;
	memoryInjectionPercent: number;
	requestMicrocompactPercent: number;
	microcompactTargetRatio: number;
	aggregateWindowSize: number;
	aggregateMaxBytes: number;
	previewMaxBytes: number;
	previewMaxLines: number;
	memoryInjectionState: ThresholdState;
	requestMicrocompactState: ThresholdState;
}

export interface ContextUsageInventory {
	activeTools: ToolSummary[];
	extensionTools: ToolSummary[];
	allToolCount: number;
	activeToolCount: number;
	extensionToolCount: number;
	extensionCommands: CommandSummary[];
	prompts: CommandSummary[];
	skills: CommandSummary[];
	commandCount: number;
}

export interface ToolSummary {
	name: string;
	source: string;
	tokens: number;
}

export interface CommandSummary {
	name: string;
	description?: string;
	source: SlashCommandInfo["source"];
	origin: string;
	tokens: number;
}

export type ThresholdState = "inactive" | "active";

export interface ContextUsageReport {
	model: {
		id: string;
		name: string;
		provider: string;
		api: string;
		thinkingLevel: string;
		contextWindow: number;
		contextWindowSource: "usage" | "model" | "settings";
		known: boolean;
	};
	usage: {
		authoritativeTokens: number | null;
		authoritativePercent: number | null;
		estimatedRequestTokens: number;
		estimatedRequestPercent: number;
		freeTokens: number | null;
		estimatedFreeTokens: number;
		compactionReserveTokens: number;
		contextWindow: number;
		isStreaming: boolean;
	};
	categories: ContextUsageCategory[];
	grid: ContextUsageGridCell[];
	messages: {
		count: number;
		rawTokens: number;
		projectedTokens: number;
		projectedSavingsTokens: number;
		projectionChanged: boolean;
	};
	contextGuard: ContextGuardUsageDetails;
	inventory: ContextUsageInventory;
}

export interface BuildContextUsageReportOptions {
	ctx: ExtensionContext;
	sessionKey: string;
	settings: ContextGuardSettings;
	replacements: FoldReferenceLookup;
	memory: ContextGuardMemory;
	storeStats?: StoreStats;
	liveIds: Set<string>;
	tools: ToolInfo[];
	activeToolNames: string[];
	commands: SlashCommandInfo[];
	thinkingLevel: string;
	usage?: ContextUsage;
}

export function buildContextUsageReport(options: BuildContextUsageReportOptions): ContextUsageReport {
	const usage = options.usage ?? options.ctx.getContextUsage();
	const contextWindowInfo = resolveContextWindow(options.ctx, usage, options.settings);
	const activeMessages = buildSessionContext(
		options.ctx.sessionManager.getEntries(),
		options.ctx.sessionManager.getLeafId(),
	).messages;
	const projection = projectContextMessages(
		{
			messages: activeMessages,
			sessionKey: options.sessionKey,
			settings: options.settings,
			replacements: options.replacements,
			memory: options.memory,
			usage,
		},
		{ allocateMemoryMarker: false, includeMemory: false },
	);
	const systemPromptTokens = estimateTextTokens(options.ctx.getSystemPrompt());
	const inventory = buildInventory(options.tools, options.activeToolNames, options.commands);
	const activeToolTokens = sumTokens(inventory.activeTools);
	const extensionToolTokens = sumTokens(inventory.extensionTools);
	const builtinActiveToolTokens = Math.max(0, activeToolTokens - extensionToolTokens);
	const commandTokens = sumTokens([...inventory.extensionCommands, ...inventory.prompts, ...inventory.skills]);
	const memoryText = options.memory.renderRequestMemory(options.sessionKey, options.settings);
	const memoryAvailableTokens = estimateTextTokens(memoryText ?? "");
	const memoryRequestTokens = projection.shouldInjectMemory ? memoryAvailableTokens : 0;
	const estimatedRequestTokens =
		systemPromptTokens + activeToolTokens + commandTokens + projection.projectedTokens + memoryRequestTokens;
	const estimatedRequestPercent = percentOf(estimatedRequestTokens, contextWindowInfo.contextWindow);
	const authoritativeTokens = usage?.tokens ?? null;
	const authoritativePercent = usage?.percent ?? null;
	const compactionReserveTokens = Math.min(
		contextWindowInfo.contextWindow,
		Math.max(0, DEFAULT_COMPACTION_SETTINGS.reserveTokens),
	);
	const freeTokens =
		authoritativeTokens === null
			? null
			: Math.max(0, contextWindowInfo.contextWindow - authoritativeTokens - compactionReserveTokens);
	const estimatedFreeTokens = Math.max(
		0,
		contextWindowInfo.contextWindow - estimatedRequestTokens - compactionReserveTokens,
	);
	const effectivePercent = authoritativePercent ?? projection.effectivePercent;
	const contextGuard = buildContextGuardDetails(options, projection, memoryAvailableTokens, effectivePercent);
	const categories = buildCategories({
		contextWindow: contextWindowInfo.contextWindow,
		systemPromptTokens,
		builtinActiveToolTokens,
		extensionToolTokens,
		commandTokens,
		projection,
		memoryAvailableTokens,
		memoryRequestTokens,
		freeTokens,
		estimatedFreeTokens,
		freeIsEstimated: authoritativeTokens === null,
		compactionReserveTokens,
	});
	const grid = buildGrid({
		contextWindow: contextWindowInfo.contextWindow,
		usedTokens: authoritativeTokens ?? estimatedRequestTokens,
		usedEstimated: authoritativeTokens === null,
		compactionReserveTokens,
		freeTokens: freeTokens ?? estimatedFreeTokens,
		freeEstimated: authoritativeTokens === null,
	});

	return {
		model: {
			id: options.ctx.model?.id ?? "unknown",
			name: options.ctx.model?.name ?? options.ctx.model?.id ?? "unknown",
			provider: options.ctx.model?.provider ?? "unknown",
			api: options.ctx.model?.api ?? "unknown",
			thinkingLevel: options.thinkingLevel,
			contextWindow: contextWindowInfo.contextWindow,
			contextWindowSource: contextWindowInfo.source,
			known: options.ctx.model !== undefined,
		},
		usage: {
			authoritativeTokens,
			authoritativePercent,
			estimatedRequestTokens,
			estimatedRequestPercent,
			freeTokens,
			estimatedFreeTokens,
			compactionReserveTokens,
			contextWindow: contextWindowInfo.contextWindow,
			isStreaming: !options.ctx.isIdle(),
		},
		categories,
		grid,
		messages: {
			count: activeMessages.length,
			rawTokens: projection.initialTokens,
			projectedTokens: projection.projectedTokens,
			projectedSavingsTokens: Math.max(0, projection.initialTokens - projection.projectedTokens),
			projectionChanged: projection.changed,
		},
		contextGuard,
		inventory,
	};
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(countBytes(text) / 4);
}

function buildContextGuardDetails(
	options: BuildContextUsageReportOptions,
	projection: ContextProjection,
	memoryAvailableTokens: number,
	effectivePercent: number,
): ContextGuardUsageDetails {
	const storeStats = options.storeStats;
	const liveIdSamples = Array.from(options.liveIds).sort().slice(0, 8);
	return {
		storeAvailable: storeStats !== undefined,
		storeDir: storeStats?.storeDir,
		objectCount: storeStats?.objectCount ?? 0,
		totalBytes: storeStats?.totalBytes ?? 0,
		replacementCount: storeStats?.replacementCount ?? 0,
		replacementDegraded: storeStats?.replacementDegraded ?? false,
		perTool: storeStats?.perTool ?? {},
		liveIdCount: options.liveIds.size,
		liveIdSamples,
		rawMessageTokens: projection.initialTokens,
		projectedMessageTokens: projection.projectedTokens,
		projectedSavingsTokens: Math.max(0, projection.initialTokens - projection.projectedTokens),
		foldedCount: projection.foldedCount,
		removedMemoryMarkers: projection.removedMemoryMarkers,
		memoryAvailableTokens,
		memoryInjected: projection.memoryInjected,
		shouldInjectMemory: projection.shouldInjectMemory,
		shouldFold: projection.shouldFold,
		memoryInjectionPercent: options.settings.memoryInjectionPercent,
		requestMicrocompactPercent: options.settings.requestMicrocompactPercent,
		microcompactTargetRatio: options.settings.microcompactTargetRatio,
		aggregateWindowSize: options.settings.aggregateWindowSize,
		aggregateMaxBytes: options.settings.aggregateMaxBytes,
		previewMaxBytes: options.settings.previewMaxBytes,
		previewMaxLines: options.settings.previewMaxLines,
		memoryInjectionState: thresholdState(effectivePercent, options.settings.memoryInjectionPercent),
		requestMicrocompactState: thresholdState(effectivePercent, options.settings.requestMicrocompactPercent),
	};
}

function buildCategories(args: {
	contextWindow: number;
	systemPromptTokens: number;
	builtinActiveToolTokens: number;
	extensionToolTokens: number;
	commandTokens: number;
	projection: ContextProjection;
	memoryAvailableTokens: number;
	memoryRequestTokens: number;
	freeTokens: number | null;
	estimatedFreeTokens: number;
	freeIsEstimated: boolean;
	compactionReserveTokens: number;
}): ContextUsageCategory[] {
	return [
		estimateCategory("System prompt", args.systemPromptTokens, args.contextWindow),
		estimateCategory("Active tools", args.builtinActiveToolTokens, args.contextWindow),
		estimateCategory("Extension tools", args.extensionToolTokens, args.contextWindow),
		estimateCategory("Commands / prompts / skills metadata", args.commandTokens, args.contextWindow),
		estimateCategory("Messages, raw", args.projection.initialTokens, args.contextWindow),
		estimateCategory(
			"Messages, projected",
			args.projection.projectedTokens,
			args.contextWindow,
			args.projection.changed ? "context-guard request view" : "same as raw",
		),
		estimateCategory(
			"Context guard memory",
			args.memoryRequestTokens,
			args.contextWindow,
			args.projection.shouldInjectMemory
				? "would be injected"
				: `${args.memoryAvailableTokens} tokens available below injection threshold`,
		),
		{
			label: "Free space",
			tokens: args.freeTokens ?? args.estimatedFreeTokens,
			percent: percentOf(args.freeTokens ?? args.estimatedFreeTokens, args.contextWindow),
			estimated: args.freeIsEstimated,
			note: args.freeIsEstimated ? "local estimate; provider total unknown" : "from provider total",
		},
		{
			label: "Compaction reserve",
			tokens: args.compactionReserveTokens,
			percent: percentOf(args.compactionReserveTokens, args.contextWindow),
			estimated: false,
			note: "configured default reserve",
		},
	];
}

function buildGrid(args: {
	contextWindow: number;
	usedTokens: number;
	usedEstimated: boolean;
	compactionReserveTokens: number;
	freeTokens: number;
	freeEstimated: boolean;
}): ContextUsageGridCell[] {
	const usedTokens = Math.max(0, Math.min(args.contextWindow, args.usedTokens));
	const reserveTokens = Math.max(0, Math.min(args.contextWindow - usedTokens, args.compactionReserveTokens));
	const freeTokens = Math.max(0, Math.min(args.contextWindow - usedTokens - reserveTokens, args.freeTokens));
	return [
		{
			label: "used",
			tokens: usedTokens,
			percent: percentOf(usedTokens, args.contextWindow),
			char: "#",
			estimated: args.usedEstimated,
		},
		{
			label: "reserve",
			tokens: reserveTokens,
			percent: percentOf(reserveTokens, args.contextWindow),
			char: "=",
			estimated: false,
		},
		{
			label: "free",
			tokens: freeTokens,
			percent: percentOf(freeTokens, args.contextWindow),
			char: ".",
			estimated: args.freeEstimated,
		},
	];
}

function buildInventory(
	tools: ToolInfo[],
	activeToolNames: string[],
	commands: SlashCommandInfo[],
): ContextUsageInventory {
	const activeToolNameSet = new Set(activeToolNames);
	const activeTools = tools.filter((tool) => activeToolNameSet.has(tool.name)).map(summarizeTool);
	const extensionTools = tools
		.filter((tool) => activeToolNameSet.has(tool.name) && isExtensionSource(tool.sourceInfo.source))
		.map(summarizeTool);
	const summaries = commands.map(summarizeCommand);
	return {
		activeTools,
		extensionTools,
		allToolCount: tools.length,
		activeToolCount: activeTools.length,
		extensionToolCount: extensionTools.length,
		extensionCommands: summaries.filter((command) => command.source === "extension"),
		prompts: summaries.filter((command) => command.source === "prompt"),
		skills: summaries.filter((command) => command.source === "skill"),
		commandCount: summaries.length,
	};
}

function summarizeTool(tool: ToolInfo): ToolSummary {
	return {
		name: tool.name,
		source: tool.sourceInfo.source,
		tokens: estimateTextTokens(`${tool.name}\n${tool.description ?? ""}\n${safeStringify(tool.parameters)}`),
	};
}

function summarizeCommand(command: SlashCommandInfo): CommandSummary {
	return {
		name: command.name,
		description: command.description,
		source: command.source,
		origin: command.sourceInfo.source,
		tokens: estimateTextTokens(`/${command.name}\n${command.description ?? ""}\n${command.sourceInfo.source}`),
	};
}

function estimateCategory(label: string, tokens: number, contextWindow: number, note?: string): ContextUsageCategory {
	return {
		label,
		tokens,
		percent: percentOf(tokens, contextWindow),
		estimated: true,
		note,
	};
}

function resolveContextWindow(
	ctx: ExtensionContext,
	usage: ContextUsage | undefined,
	settings: ContextGuardSettings,
): { contextWindow: number; source: "usage" | "model" | "settings" } {
	if (usage?.contextWindow && usage.contextWindow > 0) {
		return { contextWindow: usage.contextWindow, source: "usage" };
	}
	if (ctx.model?.contextWindow && ctx.model.contextWindow > 0) {
		return { contextWindow: ctx.model.contextWindow, source: "model" };
	}
	return { contextWindow: settings.defaultContextWindow, source: "settings" };
}

function thresholdState(percent: number, threshold: number): ThresholdState {
	return percent >= threshold ? "active" : "inactive";
}

function sumTokens(items: Array<{ tokens: number }>): number {
	return items.reduce((sum, item) => sum + item.tokens, 0);
}

function percentOf(tokens: number, contextWindow: number): number {
	if (contextWindow <= 0) return 0;
	return (tokens / contextWindow) * 100;
}

function isExtensionSource(source: string): boolean {
	return source !== "builtin" && source !== "sdk";
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}
