import type { PreviewStrategy } from "./settings.js";

export interface PreviewResult {
	text: string;
	strategy: PreviewStrategy;
	truncated: boolean;
	totalBytes: number;
	totalLines: number;
	previewBytes: number;
	previewLines: number;
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length;
}

export function countBytes(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

export function createPreview(
	text: string,
	strategy: PreviewStrategy,
	options: { maxBytes: number; maxLines: number },
): PreviewResult {
	if (strategy === "head-tail-middle-strip") {
		return createHeadTailMiddlePreview(text, options);
	}
	return createHeadPreview(text, options);
}

function createHeadPreview(text: string, options: { maxBytes: number; maxLines: number }): PreviewResult {
	const totalBytes = countBytes(text);
	const totalLines = countLines(text);
	const lineLimited = text.split("\n").slice(0, options.maxLines).join("\n");
	const byteLimited = takeFirstBytes(lineLimited, options.maxBytes);
	const truncated =
		byteLimited.length !== text.length || totalBytes > countBytes(byteLimited) || totalLines > options.maxLines;

	return {
		text: byteLimited,
		strategy: "head",
		truncated,
		totalBytes,
		totalLines,
		previewBytes: countBytes(byteLimited),
		previewLines: countLines(byteLimited),
	};
}

function createHeadTailMiddlePreview(text: string, options: { maxBytes: number; maxLines: number }): PreviewResult {
	const totalBytes = countBytes(text);
	const totalLines = countLines(text);

	if (totalBytes <= options.maxBytes && totalLines <= options.maxLines) {
		return {
			text,
			strategy: "head-tail-middle-strip",
			truncated: false,
			totalBytes,
			totalLines,
			previewBytes: totalBytes,
			previewLines: totalLines,
		};
	}

	const marker = `\n\n[... middle output omitted by context-guard: ${Math.max(0, totalLines - options.maxLines)} lines, ${formatBytes(Math.max(0, totalBytes - options.maxBytes))} ...]\n\n`;
	const markerBytes = countBytes(marker);
	const availableBytes = Math.max(0, options.maxBytes - markerBytes);
	const headBytes = Math.floor(availableBytes * 0.6);
	const tailBytes = availableBytes - headBytes;
	const headLines = Math.max(1, Math.floor(options.maxLines * 0.6));
	const tailLines = Math.max(1, options.maxLines - headLines);

	const head = takeFirstBytes(text.split("\n").slice(0, headLines).join("\n"), headBytes);
	const tail = takeLastBytes(text.split("\n").slice(-tailLines).join("\n"), tailBytes);
	const preview = `${head}${marker}${tail}`;

	return {
		text: preview,
		strategy: "head-tail-middle-strip",
		truncated: true,
		totalBytes,
		totalLines,
		previewBytes: countBytes(preview),
		previewLines: countLines(preview),
	};
}

export function takeFirstBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	let result = "";
	for (const char of text) {
		const charBytes = countBytes(char);
		if (bytes + charBytes > maxBytes) break;
		result += char;
		bytes += charBytes;
	}
	return result;
}

export function takeLastBytes(text: string, maxBytes: number): string {
	let bytes = 0;
	const chars = Array.from(text);
	const result: string[] = [];
	for (let i = chars.length - 1; i >= 0; i--) {
		const char = chars[i] ?? "";
		const charBytes = countBytes(char);
		if (bytes + charBytes > maxBytes) break;
		result.push(char);
		bytes += charBytes;
	}
	return result.reverse().join("");
}
