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
	contextOpenDefaultMaxLines: number;
	contextOpenMaxLines: number;
	contextSearchDefaultLimit: number;
	contextSearchMaxLimit: number;
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
}

export type ContextGuardSettingsOverride = Partial<
	Omit<ContextGuardSettings, "thresholds" | "writeFailureCircuitBreaker">
> & {
	thresholds?: Partial<Record<keyof ContextGuardSettings["thresholds"], Partial<ToolThreshold>>>;
	writeFailureCircuitBreaker?: Partial<ContextGuardSettings["writeFailureCircuitBreaker"]>;
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
	contextOpenDefaultMaxLines: 200,
	contextOpenMaxLines: 1000,
	contextSearchDefaultLimit: 5,
	contextSearchMaxLimit: 20,
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
	return {
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
	};
}
