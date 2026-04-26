import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contextGuardExtension from "../examples/extensions/context-guard/index.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { RegisteredTool, ToolResultEventResult } from "../src/core/extensions/types.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.js";

describe("context-guard extension", () => {
	let tempDir: string;
	let runner: ExtensionRunner;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-guard-extension-"));
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			contextGuardExtension,
			tempDir,
			createEventBus(),
			runtime,
			"<context-guard-test>",
		);
		runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("leaves small tool results unchanged", async () => {
		const result = await emitTextResult("bash", "small output", { command: "echo small" });

		expect(result).toBeUndefined();
	});

	it("externalizes large bash output and stores context guard metadata", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");

		const result = await emitTextResult("bash", largeOutput, { command: "npm run check" });
		const text = getText(result);

		expect(result).toBeDefined();
		expect(text).toContain("[context-guard] Externalized bash output as cg_");
		expect(text).toContain('context_open({ id: "cg_');
		expect(text).toContain("startLine: 1");
		expect(text).toContain("maxLines: 200");
		expect(text).toContain("line 1");
		expect(text).toContain("line 2500");
		expect(text).not.toContain("line 1200");
		expect(Buffer.byteLength(text, "utf-8")).toBeLessThan(14 * 1024);
		const details = result?.details as { contextGuard?: { id?: string; toolName?: string } } | undefined;
		expect(details?.contextGuard?.id).toMatch(/^cg_/);
		expect(details?.contextGuard?.toolName).toBe("bash");
	});

	it("uses head-only previews for search-like tools", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `grep line ${index + 1}`).join("\n");

		const result = await emitTextResult("grep", largeOutput, { pattern: "grep" });
		const text = getText(result);

		expect(text).toContain("[context-guard] Externalized grep output as cg_");
		expect(text).toContain("grep line 1");
		expect(text).not.toContain("grep line 2500");
	});

	it("preserves non-object details under original while adding context guard metadata", async () => {
		const largeOutput = "x".repeat(60 * 1024);

		const result = await emitTextResult("bash", largeOutput, { command: "yes" }, "original-details");

		const details = result?.details as { original?: unknown; contextGuard?: { id?: string } } | undefined;
		expect(details?.original).toBe("original-details");
		expect(details?.contextGuard?.id).toMatch(/^cg_/);
	});

	it("preserves image block ordering while externalizing oversized text blocks", async () => {
		const image: ImageContent = { type: "image", data: "abc", mimeType: "image/png" };

		const result = await runner.emitToolResult({
			type: "tool_result",
			toolName: "bash",
			toolCallId: "call-image",
			input: { command: "produce-image-and-text" },
			content: [image, { type: "text", text: "x".repeat(60 * 1024) }],
			details: {},
			isError: false,
		});

		expect(result?.content?.[0]).toEqual(image);
		expect(result?.content?.[1]?.type).toBe("text");
	});

	it("preserves error status while externalizing oversized error results", async () => {
		const result = await emitTextResult("bash", "error\n".repeat(3000), { command: "failing-command" }, {}, true);

		expect(result?.isError).toBe(true);
		expect(getText(result)).toContain("[context-guard] Externalized bash output as cg_");
	});

	it("proactively externalizes medium read results when aggregate budget is exceeded", async () => {
		const mediumOutput = "r".repeat(100 * 1024);
		let latest: ToolResultEventResult | undefined;

		for (let i = 0; i < 11; i++) {
			latest = await emitTextResult("read", mediumOutput, { path: `file-${i}.txt` });
		}

		expect(latest).toBeDefined();
		expect(getText(latest)).toContain("[context-guard] Externalized read output as cg_");
	});

	it("clears aggregate flood state after session compaction", async () => {
		const mediumOutput = "r".repeat(100 * 1024);
		for (let i = 0; i < 11; i++) {
			await emitTextResult("read", mediumOutput, { path: `before-compact-${i}.txt` });
		}

		await runner.emit({
			type: "session_compact",
			compactionEntry: createCompactionEntry(),
			fromExtension: false,
		});

		const result = await emitTextResult("read", mediumOutput, { path: "after-compact.txt" });

		expect(result).toBeUndefined();
	});

	it("does not externalize streaming tool execution updates", async () => {
		await runner.emit({
			type: "tool_execution_update",
			toolCallId: "partial-call",
			toolName: "bash",
			args: { command: "yes" },
			partialResult: "x".repeat(100 * 1024),
		});

		expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard"))).toBe(false);
	});

	it("registers retrieval tools and opens externalized output by bounded line range", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");
		const externalized = await emitTextResult("bash", largeOutput, { command: "long-output" });
		const id = getContextGuardId(externalized);

		const openTool = getTool("context_open");
		const opened = await openTool.definition.execute(
			"open-call",
			{ id, startLine: 20, maxLines: 2 },
			undefined,
			undefined,
			runner.createContext(),
		);

		const text = getToolText(opened.content);
		expect(text).toContain(`lines 20-21`);
		expect(text).toContain("line 20\nline 21");
		expect(text).not.toContain("line 22");
	});

	it("searches externalized output without reloading it into the transcript", async () => {
		await emitTextResult("bash", `${"prefix\n".repeat(2400)}unique-context-guard-needle`, { command: "searchable" });

		const searchTool = getTool("context_search");
		const searched = await searchTool.definition.execute(
			"search-call",
			{ query: "unique-context-guard-needle", limit: 3 },
			undefined,
			undefined,
			runner.createContext(),
		);

		const text = getToolText(searched.content);
		expect(text).toContain("unique-context-guard-needle");
		expect(text).toContain("cg_");
		expect(text.split("\n").length).toBeLessThan(20);
	});

	it("searches metadata and respects tool-name filters", async () => {
		await emitTextResult("bash", "command output\n".repeat(2500), { command: "rare-command-token" });
		await emitTextResult("read", "file output\n".repeat(2500), { path: "rare-file-token.txt" });

		const searchTool = getTool("context_search");
		const searched = await searchTool.definition.execute(
			"search-call",
			{ query: "rare-file-token.txt", toolName: "read", limit: 3 },
			undefined,
			undefined,
			runner.createContext(),
		);

		const text = getToolText(searched.content);
		expect(text).toContain("rare-file-token.txt");
		expect(text).toContain("read path:");
		expect(text).not.toContain("rare-command-token");
	});

	it("reports stats and purges only context-guard data", async () => {
		const notifications = bindNotifications();
		const unrelatedPath = path.join(tempDir, "keep.txt");
		fs.writeFileSync(unrelatedPath, "keep");
		await emitTextResult("bash", "x".repeat(60 * 1024), { command: "stats-command" });

		await getCommand("context-guard:stats").handler("", runner.createCommandContext());
		expect(notifications.at(-1)?.message).toContain("objects: 1");
		expect(notifications.at(-1)?.message).toContain("- bash: 1 outputs");

		await getCommand("context-guard:purge").handler("", runner.createCommandContext());

		expect(fs.existsSync(unrelatedPath)).toBe(true);
		expect(notifications.at(-1)?.message).toBe("context-guard store purged");
	});

	it("preserves original tool result when store initialization fails and retries later", async () => {
		const notifications = bindNotifications();
		const piPath = path.join(tempDir, ".pi");
		fs.writeFileSync(piPath, "not-a-directory");

		const failed = await emitTextResult("bash", "x".repeat(60 * 1024), { command: "first" });

		expect(failed).toBeUndefined();
		expect(notifications).toHaveLength(1);
		expect(notifications[0]?.message).toContain("failed to externalize output");

		fs.rmSync(piPath);
		const recovered = await emitTextResult("bash", "x".repeat(60 * 1024), { command: "second" });

		expect(recovered).toBeDefined();
		expect(getText(recovered)).toContain("[context-guard] Externalized bash output as cg_");
	});

	it("registers context guard commands", () => {
		const commands = runner.getRegisteredCommands().map((command) => command.name);

		expect(commands).toEqual(
			expect.arrayContaining(["context-guard:open", "context-guard:purge", "context-guard:stats"]),
		);
	});

	async function emitTextResult(
		toolName: string,
		text: string,
		input: Record<string, unknown>,
		details: unknown = {},
		isError = false,
	): Promise<ToolResultEventResult | undefined> {
		return runner.emitToolResult({
			type: "tool_result",
			toolName,
			toolCallId: `call-${Math.random()}`,
			input,
			content: [{ type: "text", text }],
			details,
			isError,
		});
	}

	function getTool(name: string): RegisteredTool {
		const tool = runner.getAllRegisteredTools().find((candidate) => candidate.definition.name === name);
		if (!tool) throw new Error(`missing tool ${name}`);
		return tool;
	}

	function getCommand(name: string) {
		const command = runner.getRegisteredCommands().find((candidate) => candidate.name === name);
		if (!command) throw new Error(`missing command ${name}`);
		return command;
	}

	function bindNotifications(): Array<{ message: string; type?: "info" | "warning" | "error" }> {
		const notifications: Array<{ message: string; type?: "info" | "warning" | "error" }> = [];
		runner.setUIContext({
			...runner.getUIContext(),
			notify: vi.fn((message: string, type?: "info" | "warning" | "error") => {
				notifications.push({ message, type });
			}),
		});
		return notifications;
	}
});

function createCompactionEntry(): CompactionEntry {
	return {
		type: "compaction",
		id: "compaction-id",
		parentId: null,
		timestamp: new Date().toISOString(),
		summary: "summary",
		firstKeptEntryId: "entry-id",
		tokensBefore: 1000,
	};
}

function getText(result: ToolResultEventResult | undefined): string {
	return getToolText(result?.content ?? []);
}

function getToolText(content: (TextContent | ImageContent)[]): string {
	return content
		.filter((item): item is TextContent => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function getContextGuardId(result: ToolResultEventResult | undefined): string {
	const details = result?.details as { contextGuard?: { id?: string } } | undefined;
	const id = details?.contextGuard?.id;
	if (!id) throw new Error("missing context guard id");
	return id;
}
