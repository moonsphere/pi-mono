import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { ContextUsage } from "@mariozechner/pi-coding-agent";
import type { ContextGuardMemory } from "./memory.js";
import { type ContextGuardSettings, isCommandLikeTool, isSearchLikeTool } from "./settings.js";
import type { FoldReferenceLookup } from "./store.js";
import { countBytes } from "./truncate.js";

type ToolContent = TextContent | ImageContent;

export interface ContextTransformOptions {
	messages: AgentMessage[];
	sessionKey: string;
	settings: ContextGuardSettings;
	replacements: FoldReferenceLookup;
	memory: ContextGuardMemory;
	usage: ContextUsage | undefined;
}

export function transformContextMessages(options: ContextTransformOptions): AgentMessage[] | undefined {
	const contextWindow = options.usage?.contextWindow ?? options.settings.defaultContextWindow;
	const targetTokens = Math.max(1, Math.floor(contextWindow * options.settings.microcompactTargetRatio));
	const initialEstimate = estimateMessagesTokens(options.messages);
	const usagePercent = options.usage?.percent;
	const estimatedPercent = (initialEstimate / contextWindow) * 100;
	const effectivePercent = usagePercent ?? estimatedPercent;
	const shouldInjectMemory = effectivePercent >= options.settings.memoryInjectionPercent;
	const shouldFold =
		effectivePercent >= options.settings.requestMicrocompactPercent || initialEstimate > targetTokens * 1.5;

	if (!shouldInjectMemory && !shouldFold && !containsKnownMemoryMarker(options.messages, options)) {
		return undefined;
	}

	let transformed = options.messages.map((message) => structuredClone(message));
	transformed = removeKnownMemoryMarkers(transformed, options);
	let changed = transformed.length !== options.messages.length;

	if (
		shouldFold &&
		(initialEstimate > targetTokens * 1.5 || effectivePercent >= options.settings.requestMicrocompactPercent)
	) {
		const folded = foldToolResults(
			transformed,
			targetTokens,
			options,
			effectivePercent >= options.settings.requestMicrocompactPercent,
		);
		transformed = folded.messages;
		changed = changed || folded.changed;
	}

	if (shouldInjectMemory) {
		const memoryText = options.memory.renderRequestMemory(options.sessionKey, options.settings);
		if (memoryText) {
			const latestUserIndex = findLatestUserIndex(transformed);
			if (latestUserIndex >= 0) {
				const markerId = options.memory.nextMarkerId(options.sessionKey);
				const memoryMessage: AgentMessage = {
					role: "custom",
					customType: "context_guard_memory",
					content: `<context_guard_memory id="${markerId}">\n${memoryText}\n</context_guard_memory>`,
					display: false,
					details: { markerId },
					timestamp: Date.now(),
				};
				transformed.splice(latestUserIndex, 0, memoryMessage);
				changed = true;
			}
		}
	}

	return changed ? transformed : undefined;
}

export function shouldLoadFoldReferencesForContext(
	messages: AgentMessage[],
	settings: ContextGuardSettings,
	usage: ContextUsage | undefined,
): boolean {
	if (!messages.some((message) => message.role === "toolResult" && extractContextGuardId(message.details))) {
		return false;
	}
	const contextWindow = usage?.contextWindow ?? settings.defaultContextWindow;
	const targetTokens = Math.max(1, Math.floor(contextWindow * settings.microcompactTargetRatio));
	const initialEstimate = estimateMessagesTokens(messages);
	const usagePercent = usage?.percent;
	const estimatedPercent = (initialEstimate / contextWindow) * 100;
	const effectivePercent = usagePercent ?? estimatedPercent;
	return effectivePercent >= settings.requestMicrocompactPercent || initialEstimate > targetTokens * 1.5;
}

export function extractContextGuardId(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const contextGuard = details.contextGuard;
	if (!isRecord(contextGuard)) return undefined;
	return typeof contextGuard.id === "string" ? contextGuard.id : undefined;
}

function foldToolResults(
	messages: AgentMessage[],
	targetTokens: number,
	options: ContextTransformOptions,
	forceFirstFold: boolean,
): { messages: AgentMessage[]; changed: boolean } {
	let currentEstimate = estimateMessagesTokens(messages);
	if (currentEstimate <= targetTokens && !forceFirstFold) return { messages, changed: false };

	const protectedStart = Math.max(0, messages.length - options.settings.microcompactRecentMessages);
	const candidates = collectFoldCandidates(messages, protectedStart);
	let changed = false;

	for (const candidate of candidates) {
		if (currentEstimate <= targetTokens && !forceFirstFold) break;
		const message = messages[candidate.index];
		if (!message || message.role !== "toolResult") continue;
		const id = extractContextGuardId(message.details);
		if (!id) continue;
		const replacement = options.replacements.getReplacement(id);
		if (!replacement) continue;
		const nextContent = replaceTextWithFoldReference(message.content, replacement);
		if (contentText(nextContent) === contentText(message.content)) continue;
		message.content = nextContent;
		currentEstimate = estimateMessagesTokens(messages);
		changed = true;
		forceFirstFold = false;
	}

	return { messages, changed };
}

interface FoldCandidate {
	index: number;
	toolName: string;
	timestamp: number;
}

function collectFoldCandidates(messages: AgentMessage[], protectedStart: number): FoldCandidate[] {
	const candidates: FoldCandidate[] = [];
	for (let index = 0; index < protectedStart; index++) {
		const message = messages[index];
		if (!message || message.role !== "toolResult") continue;
		if (!extractContextGuardId(message.details)) continue;
		candidates.push({ index, toolName: message.toolName, timestamp: message.timestamp });
	}
	return candidates.sort((a, b) => {
		const priorityDelta = toolPriority(a.toolName) - toolPriority(b.toolName);
		if (priorityDelta !== 0) return priorityDelta;
		const timeDelta = a.timestamp - b.timestamp;
		if (timeDelta !== 0) return timeDelta;
		return a.index - b.index;
	});
}

function toolPriority(toolName: string): number {
	const normalized = toolName.toLowerCase();
	if (
		normalized === "bash" ||
		normalized === "read" ||
		normalized === "grep" ||
		normalized === "find" ||
		normalized === "ls" ||
		isCommandLikeTool(toolName) ||
		isSearchLikeTool(toolName) ||
		normalized.includes("webfetch") ||
		normalized.includes("websearch")
	) {
		return 0;
	}
	return 1;
}

function replaceTextWithFoldReference(content: ToolContent[], replacement: string): ToolContent[] {
	let inserted = false;
	const nextContent: ToolContent[] = [];
	for (const item of content) {
		if (item.type === "text") {
			if (!inserted) {
				nextContent.push({ type: "text", text: replacement });
				inserted = true;
			}
			continue;
		}
		nextContent.push(item);
	}
	if (!inserted) nextContent.unshift({ type: "text", text: replacement });
	return nextContent;
}

function removeKnownMemoryMarkers(messages: AgentMessage[], options: ContextTransformOptions): AgentMessage[] {
	return messages
		.map((message) => removeKnownMemoryMarkerFromMessage(message, options))
		.filter((message): message is AgentMessage => message !== undefined);
}

function removeKnownMemoryMarkerFromMessage(
	message: AgentMessage,
	options: ContextTransformOptions,
): AgentMessage | undefined {
	if (message.role === "custom" && message.customType === "context_guard_memory") {
		const markerId = extractMarkerId(message.content);
		if (markerId && options.memory.isKnownMarkerId(options.sessionKey, markerId)) return undefined;
		return message;
	}

	if (message.role !== "user" && message.role !== "toolResult") return message;
	if (typeof message.content === "string") {
		const markerId = extractMarkerId(message.content);
		if (markerId && options.memory.isKnownMarkerId(options.sessionKey, markerId)) return undefined;
		return message;
	}

	const content = message.content.filter((item) => {
		if (item.type !== "text") return true;
		const markerId = extractMarkerId(item.text);
		return !markerId || !options.memory.isKnownMarkerId(options.sessionKey, markerId);
	});
	if (content.length === message.content.length) return message;
	return { ...message, content };
}

function containsKnownMemoryMarker(messages: AgentMessage[], options: ContextTransformOptions): boolean {
	return messages.some((message) => removeKnownMemoryMarkerFromMessage(message, options) === undefined);
}

function extractMarkerId(content: string | ToolContent[]): string | undefined {
	const text = typeof content === "string" ? content : contentText(content);
	const match = text.match(/^<context_guard_memory id="([A-Za-z0-9_-]+)">[\s\S]*<\/context_guard_memory>$/);
	return match?.[1];
}

function findLatestUserIndex(messages: AgentMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "user") return index;
	}
	return -1;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let bytes = 0;
	for (const message of messages) {
		switch (message.role) {
			case "user":
				bytes += estimateContentBytes(message.content);
				break;
			case "toolResult":
				bytes += countBytes(message.toolName) + estimateContentBytes(message.content);
				break;
			case "assistant":
				bytes += estimateContentBytes(message.content);
				break;
			case "custom":
				bytes += estimateContentBytes(message.content);
				break;
			case "bashExecution":
				bytes += countBytes(message.command) + countBytes(message.output);
				break;
			case "branchSummary":
				bytes += countBytes(message.summary);
				break;
			case "compactionSummary":
				bytes += countBytes(message.summary);
				break;
			default: {
				const _exhaustive: never = message;
				return _exhaustive;
			}
		}
	}
	return Math.ceil(bytes / 4);
}

function estimateContentBytes(content: string | Array<ToolContent | { type: string }>): number {
	if (typeof content === "string") return countBytes(content);
	let bytes = 0;
	for (const item of content) {
		if (item.type === "text" && "text" in item && typeof item.text === "string") {
			bytes += countBytes(item.text);
		} else if (item.type === "thinking" && "text" in item && typeof item.text === "string") {
			bytes += countBytes(item.text);
		} else if (item.type === "tool_call" || item.type === "toolCall") {
			bytes += countBytes(JSON.stringify(item));
		} else if (item.type === "image") {
			bytes += 1024;
		}
	}
	return bytes;
}

function contentText(content: ToolContent[]): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
