import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contextGuardExtension from "../examples/extensions/context-guard/index.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { DEFAULT_COMPACTION_SETTINGS } from "../src/core/compaction/index.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import type {
	ContextUsage,
	ExtensionActions,
	ExtensionContextActions,
	RegisteredTool,
	ToolResultEventResult,
} from "../src/core/extensions/types.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { type CompactionEntry, SessionManager } from "../src/core/session-manager.js";

describe("context-guard extension", () => {
	let tempDir: string;
	let runner: ExtensionRunner;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;
	let contextUsage: ContextUsage | undefined;

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-context-guard-extension-"));
		contextUsage = undefined;
		sessionManager = SessionManager.inMemory();
		const authStorage = AuthStorage.create(path.join(tempDir, "auth.json"));
		modelRegistry = ModelRegistry.create(authStorage);
		await reloadExtension();
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function reloadExtension(): Promise<void> {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			contextGuardExtension,
			tempDir,
			createEventBus(),
			runtime,
			"<context-guard-test>",
		);
		runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, createContextActions());
	}

	function createContextActions(): ExtensionContextActions {
		return {
			getModel: () => undefined,
			isIdle: () => true,
			getSignal: () => undefined,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => contextUsage,
			compact: () => {},
			getSystemPrompt: () => "",
		};
	}

	it("leaves small tool results unchanged", async () => {
		const result = await emitTextResult("bash", "small output", { command: "echo small" });

		expect(result).toBeUndefined();
	});

	it("externalizes large bash output and stores context guard metadata", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n");

		const result = await emitTextResult("bash", largeOutput, { command: "npm run check" });
		const text = getLlmText(result);

		expect(result).toBeDefined();
		expect(getText(result)).toContain("line 1200");
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

	it("preserves display content while sending previews through llmContent", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `display line ${index + 1}`).join("\n");

		const result = await emitTextResult("bash", largeOutput, { command: "npm run check" });
		const message = toolResultMessage("bash", result, { command: "npm run check" }, Date.now());
		const [llmMessage] = convertToLlm([message]);

		expect(getText(result)).toContain("display line 1200");
		expect(getLlmText(result)).toContain("[context-guard] Externalized bash output as cg_");
		expect(getLlmText(result)).not.toContain("display line 1200");
		expect(llmMessage?.role).toBe("toolResult");
		if (llmMessage?.role === "toolResult") {
			expect(getToolText(llmMessage.content)).toContain("[context-guard] Externalized bash output as cg_");
			expect(getToolText(llmMessage.content)).not.toContain("display line 1200");
			expect(Object.hasOwn(llmMessage, "llmContent")).toBe(false);
		}
	});

	it("uses head-only previews for search-like tools", async () => {
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `grep line ${index + 1}`).join("\n");

		const result = await emitTextResult("grep", largeOutput, { pattern: "grep" });
		const text = getLlmText(result);

		expect(getText(result)).toContain("grep line 2500");
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
		expect(result?.llmContent?.[0]).toEqual(image);
		expect(result?.llmContent?.[1]?.type).toBe("text");
		expect(getLlmText(result)).toContain("[context-guard] Externalized bash output as cg_");
	});

	it("preserves error status while externalizing oversized error results", async () => {
		const result = await emitTextResult("bash", "error\n".repeat(3000), { command: "failing-command" }, {}, true);

		expect(result?.isError).toBe(true);
		expect(getLlmText(result)).toContain("[context-guard] Externalized bash output as cg_");
	});

	it("proactively externalizes medium read results when aggregate budget is exceeded", async () => {
		const mediumOutput = "r".repeat(100 * 1024);
		let latest: ToolResultEventResult | undefined;

		for (let i = 0; i < 11; i++) {
			latest = await emitTextResult("read", mediumOutput, { path: `file-${i}.txt` });
		}

		expect(latest).toBeDefined();
		expect(getLlmText(latest)).toContain("[context-guard] Externalized read output as cg_");
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

	it("leaves request context unchanged below the injection and microcompact thresholds", async () => {
		contextUsage = { tokens: 1000, contextWindow: 200_000, percent: 0.5 };
		const messages = [userMessage("hello")];

		const transformed = await runner.emitContext(messages);

		expect(transformed).toEqual(messages);
	});

	it("folds old externalized tool results in request context without mutating session messages", async () => {
		writeContextGuardConfig({ microcompactRecentMessages: 1 });
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `fold line ${index + 1}`).join("\n");
		const externalized = await emitTextResult("bash", largeOutput, { command: "long-output" });
		const id = getContextGuardId(externalized);
		contextUsage = { tokens: 3500, contextWindow: 4000, percent: 87.5 };
		const messages = [
			userMessage("start"),
			toolResultMessage("bash", externalized, { command: "long-output" }, Date.now() - 1000),
			userMessage("latest prompt"),
		];

		const transformed = await runner.emitContext(messages);

		expect(getModelVisibleAgentMessageText(transformed[1])).toContain(
			`[context-guard] bash output ${id} externalized`,
		);
		expect(getModelVisibleAgentMessageText(transformed[1])).not.toContain("fold line 2500");
		expect(getAgentMessageText(messages[1])).toContain("fold line 2500");
		expect(transformed.at(-1)).toEqual(messages.at(-1));
	});

	it("loads persisted fold references during request microcompact after extension reload", async () => {
		writeContextGuardConfig({ microcompactRecentMessages: 1 });
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `reload fold line ${index + 1}`).join("\n");
		const externalized = await emitTextResult("bash", largeOutput, { command: "reload-long-output" });
		const id = getContextGuardId(externalized);
		await reloadExtension();
		await runner.emitBeforeAgentStart("latest prompt", undefined, "system prompt", { cwd: tempDir });
		contextUsage = { tokens: 3500, contextWindow: 4000, percent: 87.5 };

		const transformed = await runner.emitContext([
			userMessage("start"),
			toolResultMessage("bash", externalized, { command: "reload-long-output" }, Date.now() - 1000),
			userMessage("latest prompt"),
		]);

		expect(getModelVisibleAgentMessageText(transformed[1])).toContain(
			`[context-guard] bash output ${id} externalized`,
		);
		expect(getModelVisibleAgentMessageText(transformed[1])).not.toContain("reload fold line 2500");
	});

	it("folds by estimated request size when live usage is unavailable", async () => {
		writeContextGuardConfig({
			defaultContextWindow: 1000,
			microcompactTargetRatio: 0.2,
			microcompactRecentMessages: 1,
		});
		const largeOutput = Array.from({ length: 2500 }, (_, index) => `estimate fold line ${index + 1}`).join("\n");
		const externalized = await emitTextResult("bash", largeOutput, { command: "estimated-long-output" });
		const id = getContextGuardId(externalized);
		contextUsage = undefined;
		const messages = [
			userMessage("start"),
			toolResultMessage("bash", externalized, { command: "estimated-long-output" }, Date.now() - 1000),
			userMessage("latest prompt"),
		];

		const transformed = await runner.emitContext(messages);

		expect(getModelVisibleAgentMessageText(transformed[1])).toContain(
			`[context-guard] bash output ${id} externalized`,
		);
		expect(getModelVisibleAgentMessageText(transformed[1])).not.toContain("estimate fold line 2500");
		expect(getAgentMessageText(messages[1])).toContain("estimate fold line 2500");
	});

	it("injects bounded request memory before the latest user message and replaces prior generated markers", async () => {
		await runner.emitMessageEnd({ type: "message_end", message: userMessage("Remember the active task") });
		contextUsage = { tokens: 7500, contextWindow: 10_000, percent: 75 };
		const messages = [userMessage("latest prompt")];

		const first = await runner.emitContext(messages);
		const second = await runner.emitContext(first);
		const firstMarkerId = extractContextGuardMemoryMarkerId(first);
		const secondMarkerId = extractContextGuardMemoryMarkerId(second);

		expect(first).toHaveLength(2);
		expect(first[0]?.role).toBe("custom");
		expect(first.at(-1)).toEqual(messages[0]);
		expect(countContextGuardMemoryMarkers(second)).toBe(1);
		expect(secondMarkerId).toBeDefined();
		expect(secondMarkerId).not.toBe(firstMarkerId);
		expect(getAgentMessageText(second[0])).not.toContain(`id="${firstMarkerId}"`);
		expect(second.at(-1)).toEqual(messages[0]);
	});

	it("skips request memory injection when no latest user message exists", async () => {
		await runner.emitMessageEnd({ type: "message_end", message: userMessage("Remember the active task") });
		contextUsage = { tokens: 7500, contextWindow: 10_000, percent: 75 };

		const transformed = await runner.emitContext([
			toolResultMessage("bash", undefined, { command: "echo done" }, Date.now(), "done"),
		]);

		expect(countContextGuardMemoryMarkers(transformed)).toBe(0);
	});

	it("uses latest context usage to proactively externalize below-threshold outputs", async () => {
		contextUsage = { tokens: 7500, contextWindow: 10_000, percent: 75 };
		await runner.emitContext([userMessage("prime usage")]);

		const result = await emitTextResult("read", "r".repeat(100 * 1024), { path: "medium.txt" });

		expect(result).toBeDefined();
		expect(getLlmText(result)).toContain("[context-guard] Externalized read output as cg_");
	});

	it("treats missing usage as non-triggering and clears cached usage on session compaction", async () => {
		const mediumOutput = "r".repeat(100 * 1024);

		const quietBeforeUsage = await emitTextResult("read", mediumOutput, { path: "before-usage.txt" });
		contextUsage = { tokens: 7500, contextWindow: 10_000, percent: 75 };
		await runner.emitContext([userMessage("prime usage")]);
		const externalized = await emitTextResult("read", mediumOutput, { path: "after-usage.txt" });
		await runner.emit({
			type: "session_compact",
			compactionEntry: createCompactionEntry(),
			fromExtension: false,
		});
		contextUsage = undefined;
		const quietAfterCompact = await emitTextResult("read", mediumOutput, { path: "after-compact-usage.txt" });

		expect(quietBeforeUsage).toBeUndefined();
		expect(externalized).toBeDefined();
		expect(quietAfterCompact).toBeUndefined();
	});

	it("builds custom compaction summaries from structured memory", async () => {
		await runner.emitMessageEnd({ type: "message_end", message: userMessage("Fix context guard compaction") });
		await emitTextResult("read", "small file", { path: "src/context.ts" });
		await emitTextResult("bash", "command failed", { command: "npm run check" }, {}, true);
		const externalized = await emitTextResult("bash", "x".repeat(60 * 1024), { command: "long-output" });
		const id = getContextGuardId(externalized);

		const result = await runner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1234,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			branchEntries: [],
			signal: new AbortController().signal,
		});

		expect(result?.compaction?.firstKeptEntryId).toBe("keep-entry");
		expect(result?.compaction?.summary).toContain("## Goal");
		expect(result?.compaction?.summary).toContain("Fix context guard compaction");
		expect(result?.compaction?.summary).toContain("tokensBefore=1234");
		expect(result?.compaction?.summary).toContain("src/context.ts");
		expect(result?.compaction?.summary).toContain("command failed");
		expect(result?.compaction?.summary).toContain(id);
		expect(result?.compaction?.summary).not.toContain("## Decisions");
		expect(Buffer.byteLength(result?.compaction?.summary ?? "", "utf-8")).toBeLessThan(25 * 1024);
	});

	it("does not replace core compaction when Pi has messages to summarize", async () => {
		await runner.emitMessageEnd({ type: "message_end", message: userMessage("Keep default compaction") });

		const result = await runner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [userMessage("important branch content")],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1234,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			branchEntries: [],
			signal: new AbortController().signal,
		});

		expect(result).toBeUndefined();
	});

	it("loads extension-local config overrides before classifying tool results", async () => {
		writeContextGuardConfig({ thresholds: { read: { maxBytes: 10, maxLines: 2000, previewStrategy: "head" } } });

		const result = await emitTextResult("read", "small but configured large", { path: "config.txt" });

		expect(result).toBeDefined();
		expect(getLlmText(result)).toContain("[context-guard] Externalized read output as cg_");
	});

	it("ignores unsafe numeric config overrides", async () => {
		writeContextGuardConfig({
			aggregateWindowSize: -1,
			thresholds: { read: { maxBytes: -1, maxLines: -1, previewStrategy: "head" } },
		});

		const result = await emitTextResult("read", "small output", { path: "config.txt" });

		expect(result).toBeUndefined();
	});

	it("ignores unsafe store directory overrides", async () => {
		writeContextGuardConfig({ storeDir: ".", thresholds: { bash: { maxBytes: 10 } } });
		const parentSentinel = path.join(
			path.dirname(tempDir),
			`context-guard-parent-sentinel-${path.basename(tempDir)}`,
		);
		const projectSentinel = path.join(tempDir, "project-sentinel");
		fs.writeFileSync(parentSentinel, "keep");
		fs.writeFileSync(projectSentinel, "keep");

		try {
			const result = await emitTextResult("bash", "x".repeat(100), { command: "echo unsafe-store" });
			await getCommand("context-guard:purge").handler("--force", runner.createCommandContext());

			expect(result).toBeDefined();
			expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard"))).toBe(true);
			expect(fs.existsSync(parentSentinel)).toBe(true);
			expect(fs.existsSync(projectSentinel)).toBe(true);
		} finally {
			fs.rmSync(parentSentinel, { force: true });
		}
	});

	it("ignores parent-relative store directory overrides", async () => {
		writeContextGuardConfig({ storeDir: "..", thresholds: { bash: { maxBytes: 10 } } });
		const parentSentinel = path.join(
			path.dirname(tempDir),
			`context-guard-parent-sentinel-${path.basename(tempDir)}`,
		);
		fs.writeFileSync(parentSentinel, "keep");

		try {
			const result = await emitTextResult("bash", "x".repeat(100), { command: "echo unsafe-parent-store" });
			await getCommand("context-guard:purge").handler("--force", runner.createCommandContext());

			expect(result).toBeDefined();
			expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard"))).toBe(true);
			expect(fs.existsSync(parentSentinel)).toBe(true);
		} finally {
			fs.rmSync(parentSentinel, { force: true });
		}
	});

	it("refuses active-session purge without force", async () => {
		const notifications = bindNotifications();
		const externalized = await emitTextResult("bash", "x".repeat(60 * 1024), { command: "active-purge" });
		const id = getContextGuardId(externalized);

		await getCommand("context-guard:purge").handler("", runner.createCommandContext());
		const opened = await getTool("context_open").definition.execute(
			"open-active",
			{ id, maxLines: 1 },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(notifications.at(-1)?.message).toContain("purge refused");
		expect(getToolText(opened.content)).toContain(id);
		expect(fs.existsSync(path.join(tempDir, ".pi", "context-guard"))).toBe(true);
	});

	it("retention keeps ids referenced by resumed session history", async () => {
		writeContextGuardConfig({ retention: { maxObjectAgeMs: 30 * 24 * 60 * 60 * 1000, maxTotalStoreBytes: 1 } });
		const first = await emitTextResult("bash", "x".repeat(60 * 1024), { command: "resumed-live" });
		const firstId = getContextGuardId(first);
		sessionManager.appendMessage(toolResultMessage("bash", first, { command: "resumed-live" }, Date.now()));
		await reloadExtension();

		await emitTextResult("bash", "y".repeat(60 * 1024), { command: "trigger-retention" });
		const opened = await getTool("context_open").definition.execute(
			"open-retained",
			{ id: firstId, maxLines: 1 },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(getToolText(opened.content)).toContain(firstId);
		expect(getToolText(opened.content)).not.toContain("expired or missing");
	});

	it("keeps system metadata from evicting user memory events", async () => {
		writeContextGuardConfig({ memoryEventLimit: 1 });
		await runner.emitMessageEnd({ type: "message_end", message: userMessage("Keep this goal") });
		await runner.emitBeforeAgentStart("ignored", undefined, "system prompt one", { cwd: tempDir });
		await runner.emitBeforeAgentStart("ignored", undefined, "system prompt two", { cwd: tempDir });

		const result = await runner.emit({
			type: "session_before_compact",
			preparation: {
				firstKeptEntryId: "keep-entry",
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 1234,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: DEFAULT_COMPACTION_SETTINGS,
			},
			branchEntries: [],
			signal: new AbortController().signal,
		});

		expect(result?.compaction?.summary).toContain("Keep this goal");
		expect(result?.compaction?.summary).toContain("systemPromptHash=");
	});

	it("warns on curl stdout and blocks predictably unbounded commands", async () => {
		const notifications = bindNotifications();

		const warned = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "curl-call",
			input: { command: "curl https://example.com" },
		});
		const allowed = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "curl-output-call",
			input: { command: "curl -o page.html https://example.com" },
		});
		const wgetDefault = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "wget-default-call",
			input: { command: "wget https://example.com/page.html" },
		});
		const echoYes = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "echo-yes-call",
			input: { command: "echo yes" },
		});
		const boundedYes = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "yes-head-call",
			input: { command: "yes | head -n 1" },
		});
		const boundedUrandom = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "urandom-head-call",
			input: { command: "head -c 16 /dev/urandom" },
		});
		const blockedUrandom = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "urandom-call",
			input: { command: "cat /dev/urandom" },
		});
		const laterUnboundedYes = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "yes-compound-call",
			input: { command: "yes | head -n 1; yes" },
		});
		const blocked = await runner.emitToolCall({
			type: "tool_call",
			toolName: "bash",
			toolCallId: "yes-call",
			input: { command: "yes" },
		});

		expect(warned).toBeUndefined();
		expect(notifications.at(-1)?.message).toContain("curl/wget");
		expect(allowed).toBeUndefined();
		expect(wgetDefault).toBeUndefined();
		expect(echoYes).toBeUndefined();
		expect(boundedYes).toBeUndefined();
		expect(boundedUrandom).toBeUndefined();
		expect(blockedUrandom?.block).toBe(true);
		expect(laterUnboundedYes?.block).toBe(true);
		expect(blocked?.block).toBe(true);
	});

	it("clamps configured context_open defaults to max limits", async () => {
		writeContextGuardConfig({
			contextOpenDefaultMaxLines: 100,
			contextOpenMaxLines: 3,
			thresholds: { bash: { maxBytes: 10 } },
		});
		const externalized = await emitTextResult(
			"bash",
			Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"),
			{
				command: "clamp-open",
			},
		);
		const id = getContextGuardId(externalized);

		const opened = await getTool("context_open").definition.execute(
			"open-clamped",
			{ id },
			undefined,
			undefined,
			runner.createContext(),
		);

		expect(getToolText(opened.content)).toContain("lines 1-3");
		expect(getToolText(opened.content)).not.toContain("line 4");
	});

	it("reports stats and purges only context-guard data", async () => {
		const notifications = bindNotifications();
		const unrelatedPath = path.join(tempDir, "keep.txt");
		fs.writeFileSync(unrelatedPath, "keep");
		await emitTextResult("bash", "x".repeat(60 * 1024), { command: "stats-command" });

		await getCommand("context-guard:stats").handler("", runner.createCommandContext());
		expect(notifications.at(-1)?.message).toContain("objects: 1");
		expect(notifications.at(-1)?.message).toContain("- bash: 1 outputs");

		await getCommand("context-guard:purge").handler("--force", runner.createCommandContext());

		expect(fs.existsSync(unrelatedPath)).toBe(true);
		expect(notifications.at(-1)?.message).toBe("context-guard store purged");
	});

	it("updates footer status with storage and context usage", async () => {
		const statuses = bindStatus();
		contextUsage = { tokens: 7500, contextWindow: 10_000, percent: 75 };
		await runner.emitContext([userMessage("prime status usage")]);

		await emitTextResult("bash", "x".repeat(60 * 1024), { command: "status-command" });

		expect(statuses.at(-1)).toMatchObject({ key: "context-guard" });
		expect(statuses.at(-1)?.text).toContain("guard: 1 obj");
		expect(statuses.at(-1)?.text).toContain("60 KB");
		expect(statuses.at(-1)?.text).toContain("live 1");
		expect(statuses.at(-1)?.text).toContain("ctx 75%");
	});

	it("lists recent externalized outputs from a command", async () => {
		const notifications = bindNotifications();
		await emitTextResult("bash", "old command output\n".repeat(2500), { command: "old-command-token" });
		await emitTextResult("read", "recent file output\n".repeat(2500), { path: "recent-file-token.txt" });

		await getCommand("context-guard:list").handler("--limit 1", runner.createCommandContext());
		const latestList = notifications.at(-1)?.message ?? "";

		expect(latestList).toContain("[context-guard] Recent externalized outputs");
		expect(latestList).toContain("read path: recent-file-token.txt");
		expect(latestList).not.toContain("old-command-token");

		await getCommand("context-guard:list").handler("--tool bash --limit 10", runner.createCommandContext());
		const bashList = notifications.at(-1)?.message ?? "";

		expect(bashList).toContain("bash command: old-command-token");
		expect(bashList).not.toContain("recent-file-token.txt");
	});

	it("reports effective settings from a command", async () => {
		const notifications = bindNotifications();
		writeContextGuardConfig({
			contextListDefaultLimit: 7,
			thresholds: { bash: { maxBytes: 10 } },
		});

		await getCommand("context-guard:settings").handler("", runner.createCommandContext());
		const message = notifications.at(-1)?.message ?? "";

		expect(message).toContain("context-guard settings");
		expect(message).toContain("storeDir: .pi/context-guard");
		expect(message).toContain("context-guard:list: default 7");
		expect(message).toContain("- bash: 10 B or 2000 lines");
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
		expect(getLlmText(recovered)).toContain("[context-guard] Externalized bash output as cg_");
	});

	it("registers context guard commands", () => {
		const commands = runner.getRegisteredCommands().map((command) => command.name);

		expect(commands).toEqual(
			expect.arrayContaining([
				"context-guard:list",
				"context-guard:open",
				"context-guard:purge",
				"context-guard:settings",
				"context-guard:stats",
			]),
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

	function bindStatus(): Array<{ key: string; text: string | undefined }> {
		const statuses: Array<{ key: string; text: string | undefined }> = [];
		runner.setUIContext({
			...runner.getUIContext(),
			setStatus: vi.fn((key: string, text: string | undefined) => {
				statuses.push({ key, text });
			}),
		});
		return statuses;
	}

	function writeContextGuardConfig(config: Record<string, unknown>): void {
		const configDir = path.join(tempDir, ".pi", "context-guard");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(config), "utf-8");
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

function userMessage(text: string, timestamp = Date.now()): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp,
	};
}

function toolResultMessage(
	toolName: string,
	result: ToolResultEventResult | undefined,
	_input: Record<string, unknown>,
	timestamp: number,
	fallbackText?: string,
): ToolResultMessage {
	const message: ToolResultMessage = {
		role: "toolResult",
		toolName,
		toolCallId: `context-${toolName}-${timestamp}`,
		content: result?.content ?? [{ type: "text", text: fallbackText ?? "" }],
		details: result?.details ?? {},
		isError: false,
		timestamp,
	};
	if (result?.llmContent !== undefined) {
		message.llmContent = result.llmContent;
	}
	return message;
}

function getText(result: ToolResultEventResult | undefined): string {
	return getToolText(result?.content ?? []);
}

function getLlmText(result: ToolResultEventResult | undefined): string {
	return getToolText(result?.llmContent ?? result?.content ?? []);
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

function getAgentMessageText(message: AgentMessage | undefined): string {
	if (!message) return "";
	switch (message.role) {
		case "user":
		case "custom":
			return typeof message.content === "string" ? message.content : getToolText(message.content);
		case "toolResult":
			return getToolText(message.content);
		case "assistant":
			return message.content
				.filter((item): item is TextContent => item.type === "text")
				.map((item) => item.text)
				.join("\n");
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		case "branchSummary":
		case "compactionSummary":
			return message.summary;
		default: {
			const _exhaustive: never = message;
			return _exhaustive;
		}
	}
}

function getModelVisibleAgentMessageText(message: AgentMessage | undefined): string {
	if (!message) return "";
	if (message.role === "toolResult") {
		return getToolText(message.llmContent ?? message.content);
	}
	return getAgentMessageText(message);
}

function countContextGuardMemoryMarkers(messages: AgentMessage[]): number {
	return messages.filter((message) => getAgentMessageText(message).includes("<context_guard_memory id=")).length;
}

function extractContextGuardMemoryMarkerId(messages: AgentMessage[]): string | undefined {
	for (const message of messages) {
		const match = getAgentMessageText(message).match(/<context_guard_memory id="([^"]+)">/);
		if (match) return match[1];
	}
	return undefined;
}
