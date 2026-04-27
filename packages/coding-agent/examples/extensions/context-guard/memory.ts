import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import type { BeforeAgentStartEvent, SessionCompactEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import type { ContextGuardSettings } from "./settings.js";
import type { ContextGuardMetadata } from "./store.js";
import { countBytes, takeFirstBytes } from "./truncate.js";

type ToolContent = TextContent | ImageContent;

interface MemoryEvent {
	type: "user" | "failure" | "externalized" | "system" | "compact";
	text: string;
	timestamp: number;
	id?: string;
}

interface ActiveFile {
	path: string;
	timestamp: number;
	tool: string;
	accessKind: "read" | "modified";
}

interface SystemMetadata {
	modelId?: string;
	systemPromptHash?: string;
	contextNames: string[];
}

interface SessionMemoryState {
	events: MemoryEvent[];
	activeFiles: Map<string, ActiveFile>;
	externalizedIds: Set<string>;
	knownMarkerIds: Set<string>;
	markerSeq: number;
	systemMetadata?: SystemMetadata;
	lastCompactionId?: string;
}

export class ContextGuardMemory {
	private readonly sessions = new Map<string, SessionMemoryState>();

	reset(sessionKey: string): void {
		this.sessions.delete(sessionKey);
	}

	migrateSessionKey(fromSessionKey: string, toSessionKey: string): void {
		if (fromSessionKey === toSessionKey) return;
		const state = this.sessions.get(fromSessionKey);
		if (!state) return;
		this.sessions.set(toSessionKey, state);
		this.sessions.delete(fromSessionKey);
	}

	recordUserMessage(sessionKey: string, message: AgentMessage, settings: ContextGuardSettings): void {
		if (message.role !== "user") return;
		const text = extractMessageText(message.content);
		if (!text.trim()) return;
		this.pushEvent(sessionKey, settings, {
			type: "user",
			text: `User request: ${limitEntry(text)}`,
			timestamp: message.timestamp,
		});
	}

	recordToolResult(
		sessionKey: string,
		event: ToolResultEvent,
		settings: ContextGuardSettings,
		metadata?: ContextGuardMetadata,
	): void {
		const state = this.getState(sessionKey);
		const timestamp = Date.now();
		this.recordActiveFile(state, event.toolName, event.input, timestamp);

		if (event.isError) {
			const text = extractContentText(event.content);
			this.pushEvent(sessionKey, settings, {
				type: "failure",
				text: `${event.toolName} failed${formatInputHint(event.input)}: ${limitEntry(text || "no output")}`,
				timestamp,
			});
		}

		if (metadata) {
			state.externalizedIds.add(metadata.id);
			this.pushEvent(sessionKey, settings, {
				type: "externalized",
				id: metadata.id,
				text: `${metadata.id} ${metadata.toolName} ${metadata.commandOrPath ?? ""} (${metadata.byteCount} bytes, ${metadata.lineCount} lines)`,
				timestamp: metadata.createdTime,
			});
		}
	}

	recordSystemMetadata(sessionKey: string, event: BeforeAgentStartEvent, modelId: string | undefined): void {
		const state = this.getState(sessionKey);
		const contextNames = extractContextNames(event.systemPromptOptions);
		const metadata: SystemMetadata = {
			modelId,
			systemPromptHash: createHash("sha256").update(event.systemPrompt).digest("hex").slice(0, 12),
			contextNames,
		};
		state.systemMetadata = metadata;
	}

	recordCompaction(sessionKey: string, event: SessionCompactEvent, settings: ContextGuardSettings): void {
		const state = this.getState(sessionKey);
		state.lastCompactionId = event.compactionEntry.id;
		this.pushEvent(sessionKey, settings, {
			type: "compact",
			id: event.compactionEntry.id,
			text: `Compaction ${event.compactionEntry.id} kept from ${event.compactionEntry.firstKeptEntryId}`,
			timestamp: Date.now(),
		});
	}

	nextMarkerId(sessionKey: string): string {
		const state = this.getState(sessionKey);
		state.markerSeq += 1;
		const id = `${sessionKey}-${state.markerSeq}`;
		state.knownMarkerIds.add(id);
		return id;
	}

	isKnownMarkerId(sessionKey: string, id: string): boolean {
		return this.getState(sessionKey).knownMarkerIds.has(id);
	}

	getLiveExternalizedIds(sessionKey: string): Set<string> {
		return new Set(this.getState(sessionKey).externalizedIds);
	}

	getAllLiveExternalizedIds(): Set<string> {
		const ids = new Set<string>();
		for (const state of this.sessions.values()) {
			for (const id of state.externalizedIds) ids.add(id);
		}
		return ids;
	}

	renderRequestMemory(sessionKey: string, settings: ContextGuardSettings, now = Date.now()): string | undefined {
		const state = this.sessions.get(sessionKey);
		if (!state || !hasUsefulMemory(state)) return undefined;

		const lines: string[] = ["# Context Guard Memory"];
		const latestUser = latestEvent(state, "user");
		if (latestUser) lines.push("Goal:", `- ${latestUser.text.replace(/^User request: /, "")}`);

		const activeFiles = renderActiveFiles(state, settings, now).slice(0, 8);
		if (activeFiles.length > 0) lines.push("Active Files:", ...activeFiles.map((line) => `- ${line}`));

		const failures = latestEvents(state, "failure", 3);
		if (failures.length > 0) lines.push("Recent Failures:", ...failures.map((event) => `- ${event.text}`));

		if (latestUser) lines.push("Next Step:", `- Continue addressing the latest user request.`);

		const externalized = latestEvents(state, "externalized", 5);
		const hints = externalized.map(
			(event) =>
				`- ${event.id}: use context_open({ id: "${event.id}", startLine: 1, maxLines: ${settings.contextOpenDefaultMaxLines} })`,
		);
		if (hints.length > 0) lines.push("Retrieval Hints:", ...hints);

		return capText(lines.join("\n"), settings.requestMemoryMaxBytes, settings.requestMemoryMaxLines);
	}

	renderCompactionSummary(
		sessionKey: string,
		settings: ContextGuardSettings,
		tokensBefore: number,
		now = Date.now(),
	): string | undefined {
		const state = this.sessions.get(sessionKey);
		if (!state || !hasUsefulMemory(state)) return undefined;

		const sections: string[] = [];
		sections.push(
			"## Goal",
			latestEvent(state, "user")?.text.replace(/^User request: /, "") ?? "No explicit user goal recorded.",
		);
		sections.push("## Session Metadata", renderSessionMetadata(state.systemMetadata, tokensBefore));
		const activeFiles = renderActiveFiles(state, settings, now);
		sections.push(
			"## Active Files",
			activeFiles.length > 0 ? activeFiles.map((line) => `- ${line}`).join("\n") : "None recorded.",
		);
		const failures = latestEvents(state, "failure", 8);
		sections.push(
			"## Recent Failures",
			failures.length > 0 ? failures.map((event) => `- ${event.text}`).join("\n") : "None recorded.",
		);
		const externalized = latestEvents(state, "externalized", 20);
		sections.push(
			"## Externalized Outputs",
			externalized.length > 0 ? externalized.map((event) => `- ${event.text}`).join("\n") : "None recorded.",
		);
		sections.push(
			"## Next Steps",
			latestEvent(state, "user") ? "- Continue from the latest user request." : "None recorded.",
		);
		const hints = externalized
			.slice(0, 10)
			.map(
				(event) =>
					`- ${event.id}: recover details with context_open({ id: "${event.id}", startLine: 1, maxLines: ${settings.contextOpenDefaultMaxLines} })`,
			);
		if (state.lastCompactionId) hints.push(`- prior compaction summary id: ${state.lastCompactionId}`);
		sections.push("## Retrieval Hints", hints.length > 0 ? hints.join("\n") : "None recorded.");

		return capText(sections.join("\n\n"), settings.compactionSummaryMaxBytes, settings.compactionSummaryMaxLines);
	}

	private getState(sessionKey: string): SessionMemoryState {
		let state = this.sessions.get(sessionKey);
		if (!state) {
			state = {
				events: [],
				activeFiles: new Map(),
				externalizedIds: new Set(),
				knownMarkerIds: new Set(),
				markerSeq: 0,
			};
			this.sessions.set(sessionKey, state);
		}
		return state;
	}

	private pushEvent(sessionKey: string, settings: ContextGuardSettings, event: MemoryEvent): void {
		const state = this.getState(sessionKey);
		state.events.push({
			...event,
			text: limitEntry(event.text),
		});
		while (state.events.length > settings.memoryEventLimit) {
			state.events.shift();
		}
	}

	private recordActiveFile(
		state: SessionMemoryState,
		toolName: string,
		input: Record<string, unknown>,
		timestamp: number,
	): void {
		const normalized = toolName.toLowerCase();
		const pathValue = input.path;
		if (typeof pathValue !== "string" || pathValue.trim().length === 0) return;
		if (normalized === "read" || normalized === "grep") {
			state.activeFiles.set(pathValue, { path: pathValue, timestamp, tool: toolName, accessKind: "read" });
		} else if (normalized === "edit" || normalized === "write") {
			state.activeFiles.set(pathValue, { path: pathValue, timestamp, tool: toolName, accessKind: "modified" });
		}
	}
}

function hasUsefulMemory(state: SessionMemoryState): boolean {
	return state.events.some((event) => event.type !== "system") || state.activeFiles.size > 0;
}

function latestEvent(state: SessionMemoryState, type: MemoryEvent["type"]): MemoryEvent | undefined {
	for (let i = state.events.length - 1; i >= 0; i--) {
		const event = state.events[i];
		if (event?.type === type) return event;
	}
	return undefined;
}

function latestEvents(state: SessionMemoryState, type: MemoryEvent["type"], limit: number): MemoryEvent[] {
	const result: MemoryEvent[] = [];
	for (let i = state.events.length - 1; i >= 0 && result.length < limit; i--) {
		const event = state.events[i];
		if (event?.type === type) result.push(event);
	}
	return result;
}

function renderActiveFiles(state: SessionMemoryState, settings: ContextGuardSettings, now: number): string[] {
	return Array.from(state.activeFiles.values())
		.sort((a, b) => a.path.localeCompare(b.path))
		.map((file) => {
			const ageMs = Math.max(0, now - file.timestamp);
			const stale = ageMs > settings.activeFileFreshnessMs ? ", stale" : "";
			const verb = file.accessKind === "modified" ? "touched" : "read";
			return `${file.path} (${verb} ${formatAge(ageMs)} ago${stale}, ${file.tool})`;
		});
}

function renderSessionMetadata(metadata: SystemMetadata | undefined, tokensBefore: number): string {
	const fields = [`tokensBefore=${tokensBefore}`];
	if (metadata) fields.push(...renderSystemMetadataFields(metadata));
	return fields.join("; ");
}

function renderSystemMetadataFields(metadata: SystemMetadata): string[] {
	const fields = [
		metadata.modelId ? `model=${metadata.modelId}` : undefined,
		metadata.systemPromptHash ? `systemPromptHash=${metadata.systemPromptHash}` : undefined,
		metadata.contextNames.length > 0 ? `loaded=${metadata.contextNames.join(", ")}` : undefined,
	].filter((field): field is string => field !== undefined);
	return fields;
}

function extractMessageText(content: string | ToolContent[]): string {
	if (typeof content === "string") return content;
	return extractContentText(content);
}

function extractContentText(content: ToolContent[]): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function formatInputHint(input: Record<string, unknown>): string {
	for (const key of ["command", "path", "pattern", "query", "glob"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return ` (${key}: ${value.slice(0, 120)})`;
	}
	return "";
}

function extractContextNames(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const names: string[] = [];
	const contextFiles = value.contextFiles;
	if (Array.isArray(contextFiles)) {
		for (const item of contextFiles) {
			if (isRecord(item) && typeof item.path === "string") names.push(item.path);
		}
	}
	const skills = value.skills;
	if (Array.isArray(skills)) {
		for (const item of skills) {
			if (isRecord(item) && typeof item.name === "string") names.push(`skill:${item.name}`);
		}
	}
	return names.slice(0, 20).map(limitEntry);
}

function capText(text: string, maxBytes: number, maxLines: number): string {
	const lines = text.split("\n").slice(0, Math.max(1, maxLines));
	let capped = lines.join("\n");
	if (countBytes(capped) > maxBytes) capped = takeFirstBytes(capped, Math.max(1, maxBytes));
	return capped;
}

function limitEntry(text: string): string {
	const collapsed = text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter((line) => line.length > 0)
		.slice(0, 2)
		.join(" / ");
	return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

function formatAge(ageMs: number): string {
	const seconds = Math.floor(ageMs / 1000);
	if (seconds < 90) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 90) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
