import { formatBytes } from "./truncate.js";
import type {
	CommandSummary,
	ContextUsageCategory,
	ContextUsageGridCell,
	ContextUsageReport,
	ToolSummary,
} from "./usage.js";

export interface RenderContextUsageReportOptions {
	columns?: number;
	maxLines?: number;
	verbose?: boolean;
}

export function renderContextUsageReport(
	report: ContextUsageReport,
	options: RenderContextUsageReportOptions = {},
): string {
	const columns = clamp(options.columns ?? process.stdout.columns ?? 80, 60, 140);
	const maxLines = clamp(options.maxLines ?? (options.verbose ? 90 : 48), 20, 140);
	const lines: string[] = [];
	lines.push("Context Usage");
	lines.push(renderGrid(report.grid, columns));
	lines.push(`Model: ${formatModel(report)}`);
	lines.push(`Usage: ${formatUsage(report)}`);
	if (report.usage.isStreaming) {
		lines.push("Note: agent is streaming; provider totals may be stale until the response finishes.");
	}
	if (!report.model.known) {
		lines.push(`Note: current model is unknown; context window comes from ${report.model.contextWindowSource}.`);
	}

	lines.push("");
	lines.push("Estimated usage by category");
	for (const category of report.categories) {
		lines.push(renderCategory(category));
	}

	lines.push("");
	lines.push("Context guard");
	lines.push(
		`- Externalized: ${report.contextGuard.objectCount} objects, ${formatBytes(report.contextGuard.totalBytes)}${report.contextGuard.storeAvailable ? "" : " (stats unavailable)"}`,
	);
	lines.push(
		`- Live ids: ${report.contextGuard.liveIdCount}${report.contextGuard.liveIdSamples.length > 0 ? ` (${report.contextGuard.liveIdSamples.join(", ")})` : ""}`,
	);
	lines.push(
		`- Projected savings: ${formatTokens(report.contextGuard.projectedSavingsTokens)} tokens; folded ${report.contextGuard.foldedCount} results`,
	);
	lines.push(
		`- Memory injection: ${renderThreshold(report.contextGuard.memoryInjectionState, report.contextGuard.memoryInjectionPercent, report.usage.authoritativePercent ?? report.usage.estimatedRequestPercent)}`,
	);
	lines.push(
		`- Request microcompact: ${renderThreshold(report.contextGuard.requestMicrocompactState, report.contextGuard.requestMicrocompactPercent, report.usage.authoritativePercent ?? report.usage.estimatedRequestPercent)}`,
	);
	lines.push(
		`- Preview cap: ${formatBytes(report.contextGuard.previewMaxBytes)} or ${report.contextGuard.previewMaxLines} lines; aggregate ${formatBytes(report.contextGuard.aggregateMaxBytes)} / ${report.contextGuard.aggregateWindowSize} results`,
	);

	lines.push("");
	lines.push("Commands / Skills / Prompts");
	lines.push(
		`- Tools: ${report.inventory.activeToolCount} active / ${report.inventory.allToolCount} registered; ${report.inventory.extensionToolCount} active extension tools`,
	);
	lines.push(
		`- Commands: ${report.inventory.extensionCommands.length} extension, ${report.inventory.prompts.length} prompts, ${report.inventory.skills.length} skills`,
	);

	if (options.verbose) {
		appendVerboseInventory(lines, report);
		appendVerboseStore(lines, report);
	} else if (lines.length >= maxLines - 2) {
		lines.push("Use /context --verbose for tool and command details.");
	}

	return limitLines(lines, maxLines).join("\n");
}

function renderGrid(cells: ContextUsageGridCell[], columns: number): string {
	const width = clamp(columns - 18, 24, 60);
	const totalPercent = cells.reduce((sum, cell) => sum + (cell.percent ?? 0), 0) || 100;
	let rendered = "";
	for (const cell of cells) {
		const charCount = Math.max(0, Math.round(((cell.percent ?? 0) / totalPercent) * width));
		rendered += cell.char.repeat(charCount);
	}
	if (rendered.length < width) rendered += ".".repeat(width - rendered.length);
	if (rendered.length > width) rendered = rendered.slice(0, width);
	return `[${rendered}]`;
}

function formatModel(report: ContextUsageReport): string {
	const thinking =
		report.model.thinkingLevel && report.model.thinkingLevel !== "off" ? ` ${report.model.thinkingLevel}` : "";
	return `${report.model.name}${thinking} (${report.model.provider}, ${report.model.contextWindowSource} window)`;
}

function formatUsage(report: ContextUsageReport): string {
	if (report.usage.authoritativeTokens === null) {
		return `unknown/${formatTokens(report.usage.contextWindow)} tokens; local estimate ${formatTokens(report.usage.estimatedRequestTokens)} (${formatPercent(report.usage.estimatedRequestPercent)})`;
	}
	return `${formatTokens(report.usage.authoritativeTokens)}/${formatTokens(report.usage.contextWindow)} tokens (${formatPercent(report.usage.authoritativePercent ?? 0)})`;
}

function renderCategory(category: ContextUsageCategory): string {
	const prefix = category.estimated ? "[estimate] " : "";
	const value = category.tokens === null ? "unknown" : `${formatTokens(category.tokens)} tokens`;
	const percent = category.percent === null ? "" : ` (${formatPercent(category.percent)})`;
	const note = category.note ? ` - ${category.note}` : "";
	return `- ${prefix}${category.label}: ${value}${percent}${note}`;
}

function renderThreshold(state: string, threshold: number, currentPercent: number): string {
	return `${state} at ${formatPercent(threshold)}, currently ${formatPercent(currentPercent)}`;
}

function appendVerboseInventory(lines: string[], report: ContextUsageReport): void {
	lines.push("");
	lines.push("Verbose inventory");
	appendToolList(lines, "Active tools", report.inventory.activeTools);
	appendToolList(lines, "Active extension tools", report.inventory.extensionTools);
	appendCommandList(lines, "Extension commands", report.inventory.extensionCommands);
	appendCommandList(lines, "Prompts", report.inventory.prompts);
	appendCommandList(lines, "Skills", report.inventory.skills);
}

function appendVerboseStore(lines: string[], report: ContextUsageReport): void {
	const toolNames = Object.keys(report.contextGuard.perTool).sort();
	if (toolNames.length === 0) return;
	lines.push("");
	lines.push("Context guard storage by tool");
	for (const toolName of toolNames.slice(0, 12)) {
		const stats = report.contextGuard.perTool[toolName];
		if (!stats) continue;
		lines.push(`- ${toolName}: ${stats.count} objects, ${formatBytes(stats.bytes)}`);
	}
	if (toolNames.length > 12) lines.push(`- ... ${toolNames.length - 12} more tools`);
}

function appendToolList(lines: string[], label: string, tools: ToolSummary[]): void {
	if (tools.length === 0) return;
	lines.push(`${label}:`);
	for (const tool of tools.slice(0, 20)) {
		lines.push(`- ${tool.name} (${tool.source}, ${formatTokens(tool.tokens)} tokens est.)`);
	}
	if (tools.length > 20) lines.push(`- ... ${tools.length - 20} more`);
}

function appendCommandList(lines: string[], label: string, commands: CommandSummary[]): void {
	if (commands.length === 0) return;
	lines.push(`${label}:`);
	for (const command of commands.slice(0, 20)) {
		const description = command.description ? ` - ${command.description}` : "";
		lines.push(`- /${command.name} (${command.origin}, ${formatTokens(command.tokens)} tokens est.)${description}`);
	}
	if (commands.length > 20) lines.push(`- ... ${commands.length - 20} more`);
}

function limitLines(lines: string[], maxLines: number): string[] {
	if (lines.length <= maxLines) return lines;
	return [
		...lines.slice(0, maxLines - 1),
		`... truncated ${lines.length - maxLines + 1} lines; rerun with --verbose or increase terminal height`,
	];
}

function formatTokens(tokens: number): string {
	const absolute = Math.abs(tokens);
	if (absolute >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}m`;
	if (absolute >= 1_000) return `${trimFixed(tokens / 1_000)}k`;
	return String(Math.round(tokens));
}

function formatPercent(percent: number): string {
	return `${trimFixed(percent)}%`;
}

function trimFixed(value: number): string {
	return value.toFixed(1).replace(/\.0$/, "");
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(Math.floor(value), min), max);
}
