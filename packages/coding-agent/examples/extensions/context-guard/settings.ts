import { readFile } from "node:fs/promises";
import path from "node:path";

export type PreviewStrategy = "head" | "head-tail-middle-strip";

export interface ToolThreshold {
	maxBytes: number;
	maxLines: number;
	previewStrategy: PreviewStrategy;
}

export interface ContextGuardSettings {
	storeDir: string;
	previewMaxBytes: number;
	previewMaxLines: number;
	replacementsLoadMaxBytes: number;
	aggregateWindowSize: number;
	aggregateMaxBytes: number;
	memoryInjectionPercent: number;
	requestMicrocompactPercent: number;
	microcompactTargetRatio: number;
	microcompactRecentMessages: number;
	defaultContextWindow: number;
	requestMemoryMaxBytes: number;
	requestMemoryMaxLines: number;
	compactionSummaryMaxBytes: number;
	compactionSummaryMaxLines: number;
	memoryEventLimit: number;
	activeFileFreshnessMs: number;
	contextOpenDefaultMaxLines: number;
	contextOpenMaxLines: number;
	contextSearchDefaultLimit: number;
	contextSearchMaxLimit: number;
	contextListDefaultLimit: number;
	contextListMaxLimit: number;
	sketchHeadBytes: number;
	sketchTailBytes: number;
	sketchMaxTokens: number;
	thresholds: {
		bash: ToolThreshold;
		read: ToolThreshold;
		grep: ToolThreshold;
		find: ToolThreshold;
		web: ToolThreshold;
		fallback: ToolThreshold;
	};
	writeFailureCircuitBreaker: {
		failures: number;
		windowMs: number;
	};
	retention: {
		maxObjectAgeMs: number;
		maxTotalStoreBytes: number;
	};
}

export type ContextGuardSettingsOverride = Partial<
	Omit<ContextGuardSettings, "thresholds" | "writeFailureCircuitBreaker" | "retention">
> & {
	thresholds?: Partial<Record<keyof ContextGuardSettings["thresholds"], Partial<ToolThreshold>>>;
	writeFailureCircuitBreaker?: Partial<ContextGuardSettings["writeFailureCircuitBreaker"]>;
	retention?: Partial<ContextGuardSettings["retention"]>;
};

const KB = 1024;
const MB = 1024 * KB;

export const DEFAULT_CONTEXT_GUARD_SETTINGS: ContextGuardSettings = {
	storeDir: ".pi/context-guard",
	previewMaxBytes: 12 * KB,
	previewMaxLines: 400,
	replacementsLoadMaxBytes: 50 * MB,
	aggregateWindowSize: 20,
	aggregateMaxBytes: 1 * MB,
	memoryInjectionPercent: 70,
	requestMicrocompactPercent: 80,
	microcompactTargetRatio: 0.2,
	microcompactRecentMessages: 8,
	defaultContextWindow: 200_000,
	requestMemoryMaxBytes: 2 * KB,
	requestMemoryMaxLines: 50,
	compactionSummaryMaxBytes: 25 * KB,
	compactionSummaryMaxLines: 200,
	memoryEventLimit: 500,
	activeFileFreshnessMs: 30 * 60 * 1000,
	contextOpenDefaultMaxLines: 200,
	contextOpenMaxLines: 1000,
	contextSearchDefaultLimit: 5,
	contextSearchMaxLimit: 20,
	contextListDefaultLimit: 20,
	contextListMaxLimit: 100,
	sketchHeadBytes: 1 * MB,
	sketchTailBytes: 1 * MB,
	sketchMaxTokens: 500,
	thresholds: {
		bash: { maxBytes: 50 * KB, maxLines: 2000, previewStrategy: "head-tail-middle-strip" },
		read: { maxBytes: 200 * KB, maxLines: 2000, previewStrategy: "head" },
		grep: { maxBytes: 100 * KB, maxLines: 2000, previewStrategy: "head" },
		find: { maxBytes: 100 * KB, maxLines: 2000, previewStrategy: "head" },
		web: { maxBytes: 50 * KB, maxLines: 2000, previewStrategy: "head" },
		fallback: { maxBytes: 50 * KB, maxLines: 2000, previewStrategy: "head-tail-middle-strip" },
	},
	writeFailureCircuitBreaker: {
		failures: 3,
		windowMs: 60_000,
	},
	retention: {
		maxObjectAgeMs: 30 * 24 * 60 * 60 * 1000,
		maxTotalStoreBytes: 512 * MB,
	},
};

export function getThresholdForTool(toolName: string, settings: ContextGuardSettings): ToolThreshold {
	const normalized = toolName.toLowerCase();
	if (
		normalized === "bash" ||
		normalized.includes("bash") ||
		normalized.includes("exec") ||
		normalized.includes("shell")
	) {
		return settings.thresholds.bash;
	}
	if (normalized === "read") {
		return settings.thresholds.read;
	}
	if (normalized.includes("webfetch") || normalized.includes("websearch") || normalized.includes("fetch")) {
		return settings.thresholds.web;
	}
	if (normalized === "grep" || normalized.includes("grep") || normalized.includes("search")) {
		return settings.thresholds.grep;
	}
	if (normalized === "find" || normalized === "ls" || normalized.includes("find") || normalized.includes("glob")) {
		return settings.thresholds.find;
	}
	return settings.thresholds.fallback;
}

export function isCommandLikeTool(toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	return (
		normalized === "bash" ||
		normalized.includes("bash") ||
		normalized.includes("exec") ||
		normalized.includes("shell")
	);
}

export function isSearchLikeTool(toolName: string): boolean {
	const normalized = toolName.toLowerCase();
	return (
		normalized === "grep" ||
		normalized === "find" ||
		normalized === "ls" ||
		normalized.includes("grep") ||
		normalized.includes("find") ||
		normalized.includes("glob") ||
		normalized.includes("search")
	);
}

export function mergeSettings(
	base: ContextGuardSettings,
	override: ContextGuardSettingsOverride | undefined,
): ContextGuardSettings {
	if (!override) return base;
	return normalizePercentThresholds({
		...base,
		...override,
		thresholds: {
			...base.thresholds,
			...override.thresholds,
			bash: { ...base.thresholds.bash, ...override.thresholds?.bash },
			read: { ...base.thresholds.read, ...override.thresholds?.read },
			grep: { ...base.thresholds.grep, ...override.thresholds?.grep },
			find: { ...base.thresholds.find, ...override.thresholds?.find },
			web: { ...base.thresholds.web, ...override.thresholds?.web },
			fallback: { ...base.thresholds.fallback, ...override.thresholds?.fallback },
		},
		writeFailureCircuitBreaker: {
			...base.writeFailureCircuitBreaker,
			...override.writeFailureCircuitBreaker,
		},
		retention: {
			...base.retention,
			...override.retention,
		},
	});
}

export async function loadContextGuardSettings(cwd: string): Promise<ContextGuardSettings> {
	const configPath = path.join(cwd, DEFAULT_CONTEXT_GUARD_SETTINGS.storeDir, "config.json");
	const raw = await readFile(configPath, "utf-8").catch(() => undefined);
	if (!raw) return DEFAULT_CONTEXT_GUARD_SETTINGS;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return DEFAULT_CONTEXT_GUARD_SETTINGS;
	}
	if (!isRecord(parsed)) return DEFAULT_CONTEXT_GUARD_SETTINGS;
	return mergeSettings(DEFAULT_CONTEXT_GUARD_SETTINGS, sanitizeSettingsOverride(parsed));
}

function sanitizeSettingsOverride(value: Record<string, unknown>): ContextGuardSettingsOverride {
	const override: ContextGuardSettingsOverride = {};
	for (const key of positiveNumberKeys) {
		const fieldValue = value[key];
		if (isPositiveNumber(fieldValue)) {
			(override as Record<string, unknown>)[key] = fieldValue;
		}
	}
	for (const key of percentNumberKeys) {
		const fieldValue = value[key];
		if (isPercentNumber(fieldValue)) {
			(override as Record<string, unknown>)[key] = fieldValue;
		}
	}
	const ratioValue = value.microcompactTargetRatio;
	if (isPositiveNumber(ratioValue) && ratioValue <= 1) {
		override.microcompactTargetRatio = ratioValue;
	}
	const storeDir = value.storeDir;
	if (isSafeRelativeStoreDir(storeDir)) {
		override.storeDir = storeDir;
	}
	if (isRecord(value.thresholds)) {
		override.thresholds = {};
		for (const key of ["bash", "read", "grep", "find", "web", "fallback"] as const) {
			const threshold = value.thresholds[key];
			if (!isRecord(threshold)) continue;
			override.thresholds[key] = sanitizeThresholdOverride(threshold);
		}
	}
	if (isRecord(value.writeFailureCircuitBreaker)) {
		override.writeFailureCircuitBreaker = sanitizeCircuitBreakerOverride(value.writeFailureCircuitBreaker);
	}
	if (isRecord(value.retention)) {
		override.retention = sanitizeRetentionOverride(value.retention);
	}
	return override;
}

const positiveNumberKeys = [
	"previewMaxBytes",
	"previewMaxLines",
	"replacementsLoadMaxBytes",
	"aggregateWindowSize",
	"aggregateMaxBytes",
	"microcompactRecentMessages",
	"defaultContextWindow",
	"requestMemoryMaxBytes",
	"requestMemoryMaxLines",
	"compactionSummaryMaxBytes",
	"compactionSummaryMaxLines",
	"memoryEventLimit",
	"activeFileFreshnessMs",
	"contextOpenDefaultMaxLines",
	"contextOpenMaxLines",
	"contextSearchDefaultLimit",
	"contextSearchMaxLimit",
	"contextListDefaultLimit",
	"contextListMaxLimit",
	"sketchHeadBytes",
	"sketchTailBytes",
	"sketchMaxTokens",
] as const;

const percentNumberKeys = ["memoryInjectionPercent", "requestMicrocompactPercent"] as const;

function sanitizeThresholdOverride(value: Record<string, unknown>): Partial<ToolThreshold> {
	const threshold: Partial<ToolThreshold> = {};
	if (isPositiveNumber(value.maxBytes)) threshold.maxBytes = value.maxBytes;
	if (isPositiveNumber(value.maxLines)) threshold.maxLines = value.maxLines;
	if (value.previewStrategy === "head" || value.previewStrategy === "head-tail-middle-strip") {
		threshold.previewStrategy = value.previewStrategy;
	}
	return threshold;
}

function sanitizeCircuitBreakerOverride(
	value: Record<string, unknown>,
): Partial<ContextGuardSettings["writeFailureCircuitBreaker"]> {
	const result: Partial<ContextGuardSettings["writeFailureCircuitBreaker"]> = {};
	if (isPositiveNumber(value.failures)) result.failures = value.failures;
	if (isPositiveNumber(value.windowMs)) result.windowMs = value.windowMs;
	return result;
}

function sanitizeRetentionOverride(value: Record<string, unknown>): Partial<ContextGuardSettings["retention"]> {
	const result: Partial<ContextGuardSettings["retention"]> = {};
	if (isNonNegativeNumber(value.maxObjectAgeMs)) result.maxObjectAgeMs = value.maxObjectAgeMs;
	if (isNonNegativeNumber(value.maxTotalStoreBytes)) result.maxTotalStoreBytes = value.maxTotalStoreBytes;
	return result;
}

function normalizePercentThresholds(settings: ContextGuardSettings): ContextGuardSettings {
	if (settings.memoryInjectionPercent < settings.requestMicrocompactPercent) return settings;
	const requestMicrocompactPercent = Math.min(
		100,
		Math.max(settings.requestMicrocompactPercent, settings.memoryInjectionPercent + 5),
	);
	return {
		...settings,
		memoryInjectionPercent: Math.max(0, requestMicrocompactPercent - 5),
		requestMicrocompactPercent,
	};
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPercentNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isSafeRelativeStoreDir(value: unknown): value is string {
	if (typeof value !== "string" || value.trim().length === 0) return false;
	if (path.isAbsolute(value)) return false;
	const normalized = path.normalize(value);
	if (normalized === ".") return false;
	return !normalized.split(/[\\/]/).includes("..");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
