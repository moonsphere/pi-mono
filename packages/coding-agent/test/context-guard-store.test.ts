import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rankRecords } from "../examples/extensions/context-guard/search.js";
import {
	DEFAULT_CONTEXT_GUARD_SETTINGS,
	getThresholdForTool,
	mergeSettings,
} from "../examples/extensions/context-guard/settings.js";
import { ContextGuardStore, sanitizeSessionKey } from "../examples/extensions/context-guard/store.js";
import { createPreview } from "../examples/extensions/context-guard/truncate.js";

describe("context-guard store", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-guard-store-"));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("stores and opens large text output by id", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();

		const text = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n");
		const stored = await store.storeOutput({
			sessionId: "session/one",
			toolName: "bash",
			text,
			input: { command: "npm run check" },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		expect(stored.metadata.id).toMatch(/^cg_/);
		expect(stored.metadata.byteCount).toBe(Buffer.byteLength(text, "utf-8"));
		expect(stored.metadata.lineCount).toBe(300);
		expect(fs.existsSync(stored.metadata.objectPath)).toBe(true);

		const opened = await store.open(stored.metadata.id, { startLine: 10, maxLines: 3 });
		expect(opened.ok).toBe(true);
		expect(opened.text).toBe("line 10\nline 11\nline 12");
		expect(opened.hasMore).toBe(true);
	});

	it("persists replacement records byte-for-byte across reload", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "grep",
			text: "needle\nhaystack",
			input: { pattern: "needle" },
			isError: false,
			previewStrategy: "head",
		});
		const foldReference = `[context-guard] ${stored.metadata.id} stable fold-reference`;
		await store.writeFoldReference(stored.metadata, foldReference);
		await store.drain();

		const reloaded = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await reloaded.initialize();

		expect(reloaded.getReplacement(stored.metadata.id)).toBe(foldReference);
	});

	it("degrades replacement loading when replacements log is over the startup cap", async () => {
		const settings = mergeSettings(DEFAULT_CONTEXT_GUARD_SETTINGS, { replacementsLoadMaxBytes: 8 });
		const replacementsDir = path.join(tempDir, ".pi", "context-guard");
		fs.mkdirSync(replacementsDir, { recursive: true });
		fs.writeFileSync(path.join(replacementsDir, "replacements.jsonl"), "0123456789abcdef");

		const store = new ContextGuardStore(tempDir, settings);
		await store.initialize();
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "output",
			input: {},
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});
		await store.writeFoldReference(stored.metadata, "should not write");
		await store.drain();

		expect(store.isReplacementDegraded()).toBe(true);
		expect(store.getReplacement(stored.metadata.id)).toBeUndefined();
	});

	it("treats fold-reference writes as best-effort when the replacement log is unavailable", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const replacementsPath = path.join(tempDir, ".pi", "context-guard", "replacements.jsonl");
		fs.mkdirSync(replacementsPath);
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "output",
			input: {},
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		await expect(store.writeFoldReference(stored.metadata, "fold-reference")).resolves.toBeUndefined();

		expect(store.isReplacementDegraded()).toBe(true);
		expect(store.getReplacement(stored.metadata.id)).toBeUndefined();
	});

	it("writes only one fold-reference record for concurrent duplicate writes", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "output",
			input: {},
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		await Promise.all([
			store.writeFoldReference(stored.metadata, "fold-reference"),
			store.writeFoldReference(stored.metadata, "fold-reference"),
		]);
		await store.drain();

		const replacementsPath = path.join(tempDir, ".pi", "context-guard", "replacements.jsonl");
		const records = fs.readFileSync(replacementsPath, "utf-8").trim().split("\n");
		expect(records).toHaveLength(1);
	});

	it("handles concurrent store writes without corrupting metadata records", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();

		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				store.storeOutput({
					sessionId: "session-one",
					toolName: "bash",
					text: `output ${index}`,
					input: { command: `echo ${index}` },
					isError: false,
					previewStrategy: "head-tail-middle-strip",
				}),
			),
		);
		await store.drain();

		const indexPath = path.join(tempDir, ".pi", "context-guard", "index", "session-one.jsonl");
		const records = fs.readFileSync(indexPath, "utf-8").trim().split("\n");
		expect(records).toHaveLength(8);
		for (const record of records) {
			expect(() => JSON.parse(record)).not.toThrow();
		}
	});

	it("removes object files when metadata persistence fails after object write", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const indexDir = path.join(tempDir, ".pi", "context-guard", "index");
		fs.rmSync(indexDir, { recursive: true, force: true });
		fs.writeFileSync(indexDir, "not-a-directory");

		await expect(
			store.storeOutput({
				sessionId: "session-one",
				toolName: "bash",
				text: "orphan candidate",
				input: { command: "echo orphan" },
				isError: false,
				previewStrategy: "head-tail-middle-strip",
			}),
		).rejects.toThrow();

		const objectsDir = path.join(tempDir, ".pi", "context-guard", "objects");
		expect(countFiles(objectsDir)).toBe(0);
	});

	it("resets write-failure circuit breaker after a successful write", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		await forceMetadataWriteFailure(store, "failure-one");
		await forceMetadataWriteFailure(store, "failure-two");
		restoreIndexDir(store);

		await expect(
			store.storeOutput({
				sessionId: "session-one",
				toolName: "bash",
				text: "successful write",
				input: { command: "echo success" },
				isError: false,
				previewStrategy: "head-tail-middle-strip",
			}),
		).resolves.toBeDefined();

		await forceMetadataWriteFailure(store, "failure-three");
		await forceMetadataWriteFailure(store, "failure-four");
		restoreIndexDir(store);

		await expect(
			store.storeOutput({
				sessionId: "session-one",
				toolName: "bash",
				text: "still enabled",
				input: { command: "echo still-enabled" },
				isError: false,
				previewStrategy: "head-tail-middle-strip",
			}),
		).resolves.toBeDefined();
	});

	it("returns clear missing result when an object body is gone", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "read",
			text: "file body",
			input: { path: "file.txt" },
			isError: false,
			previewStrategy: "head",
		});
		fs.rmSync(stored.metadata.objectPath);

		const opened = await store.open(stored.metadata.id, { maxLines: 10 });

		expect(opened.ok).toBe(false);
		expect(opened.text).toContain("expired or missing");
	});

	it("migrates fallback session records to the real session key", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const fallbackSessionKey = sanitizeSessionKey(undefined);
		const stored = await store.storeOutput({
			sessionId: fallbackSessionKey,
			toolName: "bash",
			text: "fallback output",
			input: { command: "echo fallback" },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		await store.migrateSessionKey(fallbackSessionKey, "real-session");
		await store.drain();

		const migrated = store.getMetadata(stored.metadata.id);
		expect(migrated?.sessionKey).toBe("real-session");
		expect(migrated?.relativeObjectPath).toContain("real-session");
		expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard", "index", `${fallbackSessionKey}.jsonl`))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard", "index", "real-session.jsonl"))).toBe(true);
	});

	it("searches precomputed sketches and orders ties by recency", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const first = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "same-token old",
			input: { command: "old" },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});
		const second = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "same-token new",
			input: { command: "new" },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		const results = await store.search("same-token", { limit: 2, snippetLines: 2 });

		expect(results.map((result) => result.id)).toEqual([second.metadata.id, first.metadata.id]);
	});

	it("searches tokens that collide with object prototype keys", async () => {
		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();
		const stored = await store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text: "constructor prototype keyword",
			input: { command: "echo constructor" },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		});

		const results = await store.search("constructor", { limit: 1, snippetLines: 2 });

		expect(results.map((result) => result.id)).toEqual([stored.metadata.id]);
	});

	it("ignores persisted metadata with invalid runtime shapes", async () => {
		const indexDir = path.join(tempDir, ".pi", "context-guard", "index");
		fs.mkdirSync(indexDir, { recursive: true });
		fs.writeFileSync(
			path.join(indexDir, "session-one.jsonl"),
			`${JSON.stringify({
				recordType: "metadata",
				id: "bad",
				sessionKey: "session-one",
				toolName: "bash",
				byteCount: 1,
				lineCount: 1,
				createdTime: Date.now(),
				isError: false,
				previewStrategy: "not-a-strategy",
				objectPath: "/tmp/missing",
				relativeObjectPath: "missing",
				title: "bad",
				sketch: { constructor: "not-a-number" },
			})}\n`,
		);

		const store = new ContextGuardStore(tempDir, DEFAULT_CONTEXT_GUARD_SETTINGS);
		await store.initialize();

		expect(store.getMetadata("bad")).toBeUndefined();
	});

	it("ranks records with prototype-key tokens safely", () => {
		const records = [
			{
				id: "one",
				toolName: "bash",
				title: "one",
				createdTime: 1,
				sketch: { constructor: 2 },
			},
		];

		const ranked = rankRecords(records, "constructor", { limit: 1 });

		expect(ranked[0]?.score).toBe(2);
	});

	it("classifies web search tools before generic search tools", () => {
		expect(getThresholdForTool("webSearch", DEFAULT_CONTEXT_GUARD_SETTINGS)).toBe(
			DEFAULT_CONTEXT_GUARD_SETTINGS.thresholds.web,
		);
	});

	it("builds previews without splitting utf-8 characters", () => {
		const preview = createPreview("😀".repeat(20), "head", { maxBytes: 17, maxLines: 100 });

		expect(preview.text).toBe("😀".repeat(4));
		expect(preview.text).not.toContain("�");
	});
});

function countFiles(dir: string): number {
	if (!fs.existsSync(dir)) return 0;
	let count = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const entryPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			count += countFiles(entryPath);
		} else {
			count += 1;
		}
	}
	return count;
}

async function forceMetadataWriteFailure(store: ContextGuardStore, text: string): Promise<void> {
	const indexDir = path.join(store.cwd, ".pi", "context-guard", "index");
	fs.rmSync(indexDir, { recursive: true, force: true });
	fs.writeFileSync(indexDir, "not-a-directory");
	await expect(
		store.storeOutput({
			sessionId: "session-one",
			toolName: "bash",
			text,
			input: { command: text },
			isError: false,
			previewStrategy: "head-tail-middle-strip",
		}),
	).rejects.toThrow();
}

function restoreIndexDir(store: ContextGuardStore): void {
	const indexDir = path.join(store.cwd, ".pi", "context-guard", "index");
	fs.rmSync(indexDir, { recursive: true, force: true });
	fs.mkdirSync(indexDir, { recursive: true });
}
