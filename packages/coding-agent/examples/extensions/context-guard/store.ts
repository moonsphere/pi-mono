import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { createTokenSketch, rankRecords, type SearchableRecord, type TokenSketch, tokenize } from "./search.js";
import type { ContextGuardSettings, PreviewStrategy } from "./settings.js";
import { countBytes, countLines, takeFirstBytes, takeLastBytes } from "./truncate.js";

export interface ContextGuardMetadata extends SearchableRecord {
	sessionKey: string;
	toolName: string;
	commandOrPath: string | undefined;
	byteCount: number;
	lineCount: number;
	createdTime: number;
	isError: boolean;
	previewStrategy: PreviewStrategy;
	objectPath: string;
	relativeObjectPath: string;
}

export interface ContextGuardDetails {
	id: string;
	toolName: string;
	byteCount: number;
	lineCount: number;
	objectPath: string;
	previewStrategy: PreviewStrategy;
}

export interface StoredOutput {
	metadata: ContextGuardMetadata;
	contextGuard: ContextGuardDetails;
}

export interface OpenResult {
	ok: boolean;
	id: string;
	text: string;
	startLine: number;
	endLine: number;
	totalLines: number;
	totalBytes: number;
	hasMore: boolean;
	error?: string;
	metadata?: ContextGuardMetadata;
}

export interface SearchResult {
	id: string;
	toolName: string;
	title: string;
	score: number;
	createdTime: number;
	byteCount: number;
	lineCount: number;
	snippet: string;
}

export interface StoreStats {
	objectCount: number;
	totalBytes: number;
	perTool: Record<string, { count: number; bytes: number }>;
	replacementCount: number;
	replacementDegraded: boolean;
	storeDir: string;
}

export interface FoldReferenceLookup {
	getReplacement(id: string): string | undefined;
}

interface ReplacementRecord {
	id: string;
	foldReference: string;
	createdTime: number;
}

interface MetadataRecord extends ContextGuardMetadata {
	recordType: "metadata";
}

export class ContextGuardStore {
	readonly storeDir: string;
	private readonly objectsDir: string;
	private readonly indexDir: string;
	private readonly replacementsPath: string;
	private readonly metadataById = new Map<string, ContextGuardMetadata>();
	private readonly replacementsById = new Map<string, string>();
	private readonly writeFailures: number[] = [];
	private metadataQueue: Promise<void> = Promise.resolve();
	private replacementDegraded = false;
	private idCounter = 0;
	private lastCreatedTime = 0;

	constructor(
		readonly cwd: string,
		readonly settings: ContextGuardSettings,
	) {
		this.storeDir = path.resolve(cwd, settings.storeDir);
		this.objectsDir = path.join(this.storeDir, "objects");
		this.indexDir = path.join(this.storeDir, "index");
		this.replacementsPath = path.join(this.storeDir, "replacements.jsonl");
	}

	async initialize(): Promise<void> {
		await this.ensureDirectories();
		await this.loadIndexSegments();
		await this.loadReplacements();
	}

	isReplacementDegraded(): boolean {
		return this.replacementDegraded;
	}

	getReplacement(id: string): string | undefined {
		return this.replacementsById.get(id);
	}

	getMetadata(id: string): ContextGuardMetadata | undefined {
		return this.metadataById.get(id);
	}

	async storeOutput(args: {
		sessionId: string;
		toolName: string;
		text: string;
		input: Record<string, unknown>;
		isError: boolean;
		previewStrategy: PreviewStrategy;
	}): Promise<StoredOutput> {
		if (this.isWriteCircuitOpen()) {
			throw new Error("context-guard externalization disabled after repeated write failures");
		}

		const sessionKey = sanitizeSessionKey(args.sessionId);
		const createdTime = this.nextCreatedTime();
		const byteCount = countBytes(args.text);
		const lineCount = countLines(args.text);
		const commandOrPath = extractCommandOrPath(args.input);
		const id = this.createId(args.toolName, byteCount, commandOrPath, args.text, createdTime);
		const objectPath = path.join(this.objectsDir, sessionKey, `${id}.txt`);
		const relativeObjectPath = path.relative(this.cwd, objectPath);
		const title = createTitle(args.toolName, commandOrPath);
		const metadata: ContextGuardMetadata = {
			id,
			sessionKey,
			toolName: args.toolName,
			commandOrPath,
			byteCount,
			lineCount,
			createdTime,
			isError: args.isError,
			previewStrategy: args.previewStrategy,
			objectPath,
			relativeObjectPath,
			title,
			sketch: createTokenSketch(`${title}\n${createSketchInput(args.text, this.settings)}`, {
				maxTokens: this.settings.sketchMaxTokens,
			}),
		};

		try {
			await mkdir(path.dirname(objectPath), { recursive: true });
			await atomicWriteFile(objectPath, args.text);
			await this.enqueueMetadataWrite(async () => {
				await this.appendIndexRecord(sessionKey, { ...metadata, recordType: "metadata" });
			});
			this.writeFailures.length = 0;
		} catch (error) {
			await unlink(objectPath).catch(() => {});
			this.recordWriteFailure();
			throw error;
		}

		this.metadataById.set(id, metadata);
		return {
			metadata,
			contextGuard: {
				id,
				toolName: args.toolName,
				byteCount,
				lineCount,
				objectPath: relativeObjectPath,
				previewStrategy: args.previewStrategy,
			},
		};
	}

	async writeFoldReference(metadata: ContextGuardMetadata, foldReference: string): Promise<void> {
		if (this.replacementDegraded) return;
		await this.enqueueMetadataWrite(async () => {
			if (this.replacementDegraded || this.replacementsById.has(metadata.id)) return;
			const record: ReplacementRecord = {
				id: metadata.id,
				foldReference,
				createdTime: metadata.createdTime,
			};
			try {
				await appendFile(this.replacementsPath, `${JSON.stringify(record)}\n`, "utf-8");
				this.replacementsById.set(metadata.id, foldReference);
			} catch {
				this.replacementDegraded = true;
			}
		});
	}

	async open(id: string, options: { startLine?: number; maxLines: number }): Promise<OpenResult> {
		const metadata = this.metadataById.get(id);
		if (!metadata) {
			return missingOpenResult(id, "unknown context-guard id");
		}

		try {
			const startLine = clampLine(options.startLine ?? 1, metadata.lineCount);
			const maxLines = Math.max(1, options.maxLines);
			const range = await readLineRange(metadata.objectPath, startLine, maxLines, metadata.lineCount);
			return {
				ok: true,
				id,
				text: range.text,
				startLine,
				endLine: range.endLine,
				totalLines: metadata.lineCount,
				totalBytes: metadata.byteCount,
				hasMore: range.hasMore,
				metadata,
			};
		} catch {
			return missingOpenResult(id, "context-guard object is expired or missing", metadata);
		}
	}

	async search(
		query: string,
		options: { toolName?: string; limit: number; snippetLines: number },
	): Promise<SearchResult[]> {
		const ranked = rankRecords(Array.from(this.metadataById.values()), query, {
			toolName: options.toolName,
			limit: options.limit,
		});
		const results: SearchResult[] = [];
		for (const item of ranked) {
			const startLine = await this.findSnippetStartLine(item.record, query);
			const opened = await this.open(item.record.id, { startLine, maxLines: options.snippetLines });
			results.push({
				id: item.record.id,
				toolName: item.record.toolName,
				title: item.record.title,
				score: item.score,
				createdTime: item.record.createdTime,
				byteCount: item.record.byteCount,
				lineCount: item.record.lineCount,
				snippet: opened.text,
			});
		}
		return results;
	}

	private async findSnippetStartLine(metadata: ContextGuardMetadata, query: string): Promise<number> {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0) return 1;
		return findFirstMatchingLine(metadata.objectPath, queryTokens);
	}

	getStats(): StoreStats {
		const perTool: Record<string, { count: number; bytes: number }> = {};
		let totalBytes = 0;
		for (const metadata of this.metadataById.values()) {
			totalBytes += metadata.byteCount;
			const stats = perTool[metadata.toolName] ?? { count: 0, bytes: 0 };
			stats.count += 1;
			stats.bytes += metadata.byteCount;
			perTool[metadata.toolName] = stats;
		}
		return {
			objectCount: this.metadataById.size,
			totalBytes,
			perTool,
			replacementCount: this.replacementsById.size,
			replacementDegraded: this.replacementDegraded,
			storeDir: path.relative(this.cwd, this.storeDir),
		};
	}

	listOutputs(options: { limit: number; toolName?: string }): ContextGuardMetadata[] {
		const limit = Math.max(0, Math.floor(options.limit));
		const toolName = options.toolName?.toLowerCase();
		return Array.from(this.metadataById.values())
			.filter((metadata) => !toolName || metadata.toolName.toLowerCase() === toolName)
			.sort((a, b) => b.createdTime - a.createdTime || a.id.localeCompare(b.id))
			.slice(0, limit);
	}

	async purge(): Promise<void> {
		await this.drain();
		await rm(this.storeDir, { recursive: true, force: true });
		this.metadataById.clear();
		this.replacementsById.clear();
		this.replacementDegraded = false;
		await this.ensureDirectories();
	}

	async migrateSessionKey(fromSessionKey: string, toSessionKey: string): Promise<void> {
		if (fromSessionKey === toSessionKey) return;
		await this.enqueueMetadataWrite(async () => {
			const movedMetadata = Array.from(this.metadataById.values()).filter(
				(metadata) => metadata.sessionKey === fromSessionKey,
			);
			if (movedMetadata.length === 0) return;

			const fromObjectsDir = path.join(this.objectsDir, fromSessionKey);
			const toObjectsDir = path.join(this.objectsDir, toSessionKey);
			await mkdir(toObjectsDir, { recursive: true });
			for (const metadata of movedMetadata) {
				const nextObjectPath = path.join(toObjectsDir, `${metadata.id}.txt`);
				await rename(metadata.objectPath, nextObjectPath).catch(() => {});
				metadata.sessionKey = toSessionKey;
				metadata.objectPath = nextObjectPath;
				metadata.relativeObjectPath = path.relative(this.cwd, nextObjectPath);
				await this.appendIndexRecord(toSessionKey, { ...metadata, recordType: "metadata" });
			}
			await rm(path.join(this.indexDir, `${fromSessionKey}.jsonl`), { force: true }).catch(() => {});
			await rm(fromObjectsDir, { recursive: true, force: true }).catch(() => {});
		});
	}

	async applyRetention(options: { liveIds?: Set<string>; now?: number } = {}): Promise<void> {
		const liveIds = options.liveIds ?? new Set<string>();
		const now = options.now ?? Date.now();
		await this.enqueueMetadataWrite(async () => {
			const deleteIds = new Set<string>();
			const maxAgeMs = this.settings.retention.maxObjectAgeMs;
			if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0) {
				const cutoff = now - maxAgeMs;
				for (const metadata of this.metadataById.values()) {
					if (!liveIds.has(metadata.id) && metadata.createdTime < cutoff) {
						deleteIds.add(metadata.id);
					}
				}
			}

			const maxTotalBytes = this.settings.retention.maxTotalStoreBytes;
			if (Number.isFinite(maxTotalBytes) && maxTotalBytes >= 0) {
				let totalBytes = 0;
				const retained = Array.from(this.metadataById.values())
					.filter((metadata) => !deleteIds.has(metadata.id))
					.sort((a, b) => a.createdTime - b.createdTime);
				for (const metadata of retained) totalBytes += metadata.byteCount;
				for (const metadata of retained) {
					if (totalBytes <= maxTotalBytes) break;
					if (liveIds.has(metadata.id)) continue;
					deleteIds.add(metadata.id);
					totalBytes -= metadata.byteCount;
				}
			}

			if (deleteIds.size === 0) return;
			for (const id of deleteIds) {
				const metadata = this.metadataById.get(id);
				if (!metadata) continue;
				await unlink(metadata.objectPath).catch(() => {});
				this.metadataById.delete(id);
			}
			await this.rewriteIndexSegments();
		});
	}

	async drain(): Promise<void> {
		await this.metadataQueue;
	}

	private async ensureDirectories(): Promise<void> {
		await mkdir(this.objectsDir, { recursive: true });
		await mkdir(this.indexDir, { recursive: true });
	}

	private async loadIndexSegments(): Promise<void> {
		const entries = await readdir(this.indexDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const content = await readFile(path.join(this.indexDir, entry.name), "utf-8").catch(() => "");
			for (const line of content.split("\n")) {
				if (!line.trim()) continue;
				const parsed = parseMetadataRecord(line, this.cwd, this.objectsDir);
				if (parsed) this.metadataById.set(parsed.id, parsed);
			}
		}
	}

	private async loadReplacements(): Promise<void> {
		const fileStat = await stat(this.replacementsPath).catch(() => undefined);
		if (!fileStat) return;
		if (fileStat.size > this.settings.replacementsLoadMaxBytes) {
			this.replacementDegraded = true;
			return;
		}
		const content = await readFile(this.replacementsPath, "utf-8").catch(() => undefined);
		if (content === undefined) {
			this.replacementDegraded = true;
			return;
		}
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			const parsed = parseReplacementRecord(line);
			if (parsed && !this.replacementsById.has(parsed.id)) {
				this.replacementsById.set(parsed.id, parsed.foldReference);
			}
		}
	}

	private async appendIndexRecord(sessionKey: string, record: MetadataRecord): Promise<void> {
		const segmentPath = path.join(this.indexDir, `${sessionKey}.jsonl`);
		await appendFile(segmentPath, `${JSON.stringify(record)}\n`, "utf-8");
	}

	private async rewriteIndexSegments(): Promise<void> {
		const grouped = new Map<string, ContextGuardMetadata[]>();
		for (const metadata of this.metadataById.values()) {
			const records = grouped.get(metadata.sessionKey) ?? [];
			records.push(metadata);
			grouped.set(metadata.sessionKey, records);
		}
		await mkdir(this.indexDir, { recursive: true });
		const existingSegments = await readdir(this.indexDir, { withFileTypes: true }).catch(() => []);
		for (const [sessionKey, records] of grouped) {
			if (records.length === 0) continue;
			const content = records.map((record) => JSON.stringify({ ...record, recordType: "metadata" })).join("\n");
			await atomicWriteFile(path.join(this.indexDir, `${sessionKey}.jsonl`), `${content}\n`);
		}
		for (const entry of existingSegments) {
			if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
			const sessionKey = entry.name.slice(0, -".jsonl".length);
			if (!grouped.has(sessionKey)) {
				await rm(path.join(this.indexDir, entry.name), { force: true }).catch(() => {});
			}
		}
	}

	private enqueueMetadataWrite(task: () => Promise<void>): Promise<void> {
		const next = this.metadataQueue.then(task, task);
		this.metadataQueue = next.catch(() => {});
		return next;
	}

	private createId(
		toolName: string,
		byteCount: number,
		commandOrPath: string | undefined,
		text: string,
		createdTime: number,
	): string {
		this.idCounter += 1;
		const hash = createHash("sha256")
			.update(toolName)
			.update("\0")
			.update(String(byteCount))
			.update("\0")
			.update(commandOrPath ?? "")
			.update("\0")
			.update(text.slice(0, 4096))
			.digest("hex")
			.slice(0, 12);
		return `cg_${createdTime.toString(36)}_${this.idCounter.toString(36)}_${hash}`;
	}

	private nextCreatedTime(): number {
		const now = Date.now();
		this.lastCreatedTime = Math.max(now, this.lastCreatedTime + 1);
		return this.lastCreatedTime;
	}

	private recordWriteFailure(): void {
		const now = Date.now();
		const cutoff = now - this.settings.writeFailureCircuitBreaker.windowMs;
		this.writeFailures.push(now);
		while (this.writeFailures.length > 0 && (this.writeFailures[0] ?? 0) < cutoff) {
			this.writeFailures.shift();
		}
	}

	private isWriteCircuitOpen(): boolean {
		const now = Date.now();
		const cutoff = now - this.settings.writeFailureCircuitBreaker.windowMs;
		while (this.writeFailures.length > 0 && (this.writeFailures[0] ?? 0) < cutoff) {
			this.writeFailures.shift();
		}
		return this.writeFailures.length >= this.settings.writeFailureCircuitBreaker.failures;
	}
}

export async function loadFoldReferences(cwd: string, settings: ContextGuardSettings): Promise<Map<string, string>> {
	const replacements = new Map<string, string>();
	const replacementsPath = path.join(path.resolve(cwd, settings.storeDir), "replacements.jsonl");
	const fileStat = await stat(replacementsPath).catch(() => undefined);
	if (!fileStat || fileStat.size > settings.replacementsLoadMaxBytes) return replacements;
	const content = await readFile(replacementsPath, "utf-8").catch(() => undefined);
	if (content === undefined) return replacements;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		const parsed = parseReplacementRecord(line);
		if (parsed && !replacements.has(parsed.id)) {
			replacements.set(parsed.id, parsed.foldReference);
		}
	}
	return replacements;
}

export function sanitizeSessionKey(sessionId: string | undefined): string {
	const raw = sessionId && sessionId.trim().length > 0 ? sessionId : `session_${process.pid}`;
	return raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128);
}

export function mergeContextGuardDetails(details: unknown, contextGuard: ContextGuardDetails): unknown {
	if (details && typeof details === "object" && !Array.isArray(details)) {
		return { ...details, contextGuard };
	}
	return { original: details, contextGuard };
}

function createSketchInput(text: string, settings: ContextGuardSettings): string {
	const buffer = Buffer.from(text, "utf-8");
	const budget = settings.sketchHeadBytes + settings.sketchTailBytes;
	if (buffer.byteLength <= budget) return text;
	const head = takeFirstBytes(text, settings.sketchHeadBytes);
	const tail = takeLastBytes(text, settings.sketchTailBytes);
	return `${head}\n${tail}`;
}

function extractCommandOrPath(input: Record<string, unknown>): string | undefined {
	for (const key of ["command", "path", "pattern", "query", "glob"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return `${key}: ${value.slice(0, 160)}`;
		}
	}
	return undefined;
}

function createTitle(toolName: string, commandOrPath: string | undefined): string {
	return commandOrPath ? `${toolName} ${commandOrPath}` : toolName;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	try {
		await writeFile(tempPath, content, "utf-8");
		await rename(tempPath, filePath);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		throw error;
	}
}

async function readLineRange(
	filePath: string,
	startLine: number,
	maxLines: number,
	totalLines: number,
): Promise<{ text: string; endLine: number; hasMore: boolean }> {
	const stream = createReadStream(filePath, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	const selected: string[] = [];
	const lastWantedLine = startLine + maxLines - 1;
	let currentLine = 0;

	try {
		for await (const line of lines) {
			currentLine += 1;
			if (currentLine >= startLine && selected.length < maxLines) {
				selected.push(line);
			}
			if (currentLine >= lastWantedLine) break;
		}
	} finally {
		lines.close();
		stream.destroy();
	}

	const endLine = selected.length === 0 ? startLine : startLine + selected.length - 1;
	return {
		text: selected.join("\n"),
		endLine,
		hasMore: endLine < totalLines,
	};
}

async function findFirstMatchingLine(filePath: string, queryTokens: string[]): Promise<number> {
	const stream = createReadStream(filePath, { encoding: "utf-8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	let currentLine = 0;

	try {
		for await (const line of lines) {
			currentLine += 1;
			const lowerLine = line.toLowerCase();
			if (queryTokens.some((token) => lowerLine.includes(token))) {
				return Math.max(1, currentLine - 1);
			}
		}
	} catch {
		return 1;
	} finally {
		lines.close();
		stream.destroy();
	}
	return 1;
}

function missingOpenResult(id: string, error: string, metadata?: ContextGuardMetadata): OpenResult {
	return {
		ok: false,
		id,
		text: `[context-guard: ${error} for id ${id}]`,
		startLine: 0,
		endLine: 0,
		totalLines: 0,
		totalBytes: 0,
		hasMore: false,
		error,
		metadata,
	};
}

function clampLine(line: number, totalLines: number): number {
	if (totalLines <= 0) return 1;
	if (!Number.isFinite(line)) return 1;
	return Math.min(Math.max(1, Math.floor(line)), totalLines);
}

function parseMetadataRecord(line: string, cwd: string, objectsDir: string): ContextGuardMetadata | undefined {
	const parsed = parseJsonObject(line);
	if (!parsed) return undefined;
	const sketch = parseTokenSketch(parsed.sketch);
	if (
		parsed.recordType !== "metadata" ||
		typeof parsed.id !== "string" ||
		!isSafeContextGuardId(parsed.id) ||
		typeof parsed.toolName !== "string" ||
		typeof parsed.title !== "string" ||
		typeof parsed.createdTime !== "number" ||
		typeof parsed.byteCount !== "number" ||
		typeof parsed.lineCount !== "number" ||
		typeof parsed.sessionKey !== "string" ||
		sanitizeSessionKey(parsed.sessionKey) !== parsed.sessionKey ||
		typeof parsed.isError !== "boolean" ||
		!isPreviewStrategy(parsed.previewStrategy) ||
		!sketch
	) {
		return undefined;
	}
	const objectPath = path.join(objectsDir, parsed.sessionKey, `${parsed.id}.txt`);
	return {
		id: parsed.id,
		sessionKey: parsed.sessionKey,
		toolName: parsed.toolName,
		commandOrPath: typeof parsed.commandOrPath === "string" ? parsed.commandOrPath : undefined,
		byteCount: parsed.byteCount,
		lineCount: parsed.lineCount,
		createdTime: parsed.createdTime,
		isError: parsed.isError,
		previewStrategy: parsed.previewStrategy,
		objectPath,
		relativeObjectPath: path.relative(cwd, objectPath),
		title: parsed.title,
		sketch,
	};
}

function isSafeContextGuardId(value: string): boolean {
	return /^cg_[A-Za-z0-9_-]+$/.test(value);
}

function parseReplacementRecord(line: string): ReplacementRecord | undefined {
	const parsed = parseJsonObject(line);
	if (!parsed) return undefined;
	if (
		typeof parsed.id !== "string" ||
		typeof parsed.foldReference !== "string" ||
		typeof parsed.createdTime !== "number"
	) {
		return undefined;
	}
	return {
		id: parsed.id,
		foldReference: parsed.foldReference,
		createdTime: parsed.createdTime,
	};
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	return isRecord(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPreviewStrategy(value: unknown): value is PreviewStrategy {
	return value === "head" || value === "head-tail-middle-strip";
}

function parseTokenSketch(value: unknown): TokenSketch | undefined {
	if (!isRecord(value)) return undefined;
	const sketch = Object.create(null) as TokenSketch;
	for (const [token, count] of Object.entries(value)) {
		if (typeof count !== "number" || !Number.isFinite(count)) return undefined;
		sketch[token] = count;
	}
	return sketch;
}
