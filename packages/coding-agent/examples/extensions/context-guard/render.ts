import type { ContextGuardMetadata, OpenResult, SearchResult, StoreStats } from "./store.js";
import { formatBytes, type PreviewResult } from "./truncate.js";

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
