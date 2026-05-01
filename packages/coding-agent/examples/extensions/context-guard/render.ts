import type { ContextGuardSettings } from "./settings.js";
import type { ContextGuardMetadata, OpenResult, SearchResult, StoreStats } from "./store.js";
import { formatBytes, type PreviewResult } from "./truncate.js";

export interface ContextGuardStatusUsage {
	percent?: number | null;
}

export function renderExternalizedPreview(
	metadata: ContextGuardMetadata,
	preview: PreviewResult,
	maxLines: number,
): string {
	const lines = [
		`[context-guard] Externalized ${metadata.toolName} output as ${metadata.id} (${formatBytes(metadata.byteCount)}, ${metadata.lineCount} lines).`,
		`Use context_open({ id: "${metadata.id}", startLine: 1, maxLines: ${maxLines} }) for bounded retrieval.`,
	];
	if (preview.truncated) {
		lines.push(
			`Preview shows ${formatBytes(preview.previewBytes)} of ${formatBytes(preview.totalBytes)} using ${preview.strategy}.`,
		);
	}
	lines.push("", preview.text);
	return lines.join("\n");
}

export function createFoldReference(metadata: ContextGuardMetadata, maxLines: number): string {
	return `[context-guard] ${metadata.toolName} output ${metadata.id} externalized (${formatBytes(metadata.byteCount)}, ${metadata.lineCount} lines). Use context_open({ id: "${metadata.id}", startLine: 1, maxLines: ${maxLines} }) for bounded retrieval.`;
}

export function renderOpenResult(result: OpenResult): string {
	if (!result.ok) return result.text;
	const header = `[context-guard] ${result.id} lines ${result.startLine}-${result.endLine} of ${result.totalLines} (${formatBytes(result.totalBytes)}).`;
	const footer = result.hasMore
		? `\n[More available. Continue with context_open({ id: "${result.id}", startLine: ${result.endLine + 1}, maxLines: ${result.endLine - result.startLine + 1} }).]`
		: "";
	return `${header}\n\n${result.text}${footer}`;
}

export function renderSearchResults(results: SearchResult[]): string {
	if (results.length === 0) return "[context-guard] No matching externalized outputs.";
	return results
		.map((result, index) => {
			const snippet = result.snippet.trim().split("\n").slice(0, 8).join("\n");
			return [
				`${index + 1}. ${result.id} ${result.title} (${formatBytes(result.byteCount)}, ${result.lineCount} lines, score ${result.score})`,
				snippet,
			].join("\n");
		})
		.join("\n\n");
}

export function renderStats(stats: StoreStats): string {
	const lines = [
		`context-guard store: ${stats.storeDir}`,
		`objects: ${stats.objectCount}`,
		`stored bytes: ${formatBytes(stats.totalBytes)}`,
		`fold references: ${stats.replacementCount}${stats.replacementDegraded ? " (degraded)" : ""}`,
	];
	const toolNames = Object.keys(stats.perTool).sort();
	if (toolNames.length > 0) {
		lines.push("per tool:");
		for (const toolName of toolNames) {
			const tool = stats.perTool[toolName];
			if (!tool) continue;
			lines.push(`- ${toolName}: ${tool.count} outputs, ${formatBytes(tool.bytes)}`);
		}
	}
	return lines.join("\n");
}

export function renderOutputList(outputs: ContextGuardMetadata[], maxLines: number): string {
	if (outputs.length === 0) return "[context-guard] No externalized outputs.";
	const lines = ["[context-guard] Recent externalized outputs"];
	for (const [index, metadata] of outputs.entries()) {
		lines.push(
			`${index + 1}. ${metadata.id} ${metadata.title} (${formatBytes(metadata.byteCount)}, ${metadata.lineCount} lines)`,
		);
		lines.push(`   context_open({ id: "${metadata.id}", startLine: 1, maxLines: ${maxLines} })`);
	}
	return lines.join("\n");
}

export function renderContextGuardStatus(
	stats: StoreStats | undefined,
	liveIds: Set<string>,
	usage?: ContextGuardStatusUsage,
): string {
	const objectCount = stats?.objectCount ?? 0;
	const parts = [`guard: ${objectCount} ${objectCount === 1 ? "obj" : "objs"}`];
	if (stats) parts.push(formatBytes(stats.totalBytes));
	if (liveIds.size > 0) parts.push(`live ${liveIds.size}`);
	if (usage?.percent !== null && usage?.percent !== undefined) parts.push(`ctx ${formatPercent(usage.percent)}`);
	if (stats?.replacementDegraded) parts.push("refs degraded");
	return parts.join(", ");
}

export function renderSettings(settings: ContextGuardSettings): string {
	const lines = [
		"context-guard settings",
		`storeDir: ${settings.storeDir}`,
		`preview: ${formatBytes(settings.previewMaxBytes)} or ${settings.previewMaxLines} lines`,
		`aggregate: ${formatBytes(settings.aggregateMaxBytes)} across ${settings.aggregateWindowSize} results`,
		`memory injection: ${formatPercent(settings.memoryInjectionPercent)}`,
		`request microcompact: ${formatPercent(settings.requestMicrocompactPercent)} to ${formatPercent(settings.microcompactTargetRatio * 100)} target`,
		`context_open: default ${settings.contextOpenDefaultMaxLines} lines, max ${settings.contextOpenMaxLines}`,
		`context_search: default ${settings.contextSearchDefaultLimit}, max ${settings.contextSearchMaxLimit}`,
		`context-guard:list: default ${settings.contextListDefaultLimit}, max ${settings.contextListMaxLimit}`,
		`retention: ${formatDuration(settings.retention.maxObjectAgeMs)} or ${formatBytes(settings.retention.maxTotalStoreBytes)}`,
		"thresholds:",
	];
	for (const name of ["bash", "read", "grep", "find", "web", "fallback"] as const) {
		const threshold = settings.thresholds[name];
		lines.push(
			`- ${name}: ${formatBytes(threshold.maxBytes)} or ${threshold.maxLines} lines, preview ${threshold.previewStrategy}`,
		);
	}
	return lines.join("\n");
}

function formatPercent(value: number): string {
	return `${value.toFixed(1).replace(/\.0$/, "")}%`;
}

function formatDuration(ms: number): string {
	if (!Number.isFinite(ms)) return "unlimited";
	const dayMs = 24 * 60 * 60 * 1000;
	if (ms >= dayMs && ms % dayMs === 0) return `${Math.round(ms / dayMs)}d`;
	const hourMs = 60 * 60 * 1000;
	if (ms >= hourMs && ms % hourMs === 0) return `${Math.round(ms / hourMs)}h`;
	return `${Math.round(ms)}ms`;
}
