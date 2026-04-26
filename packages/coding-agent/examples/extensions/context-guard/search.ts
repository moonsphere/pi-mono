export type TokenSketch = Record<string, number>;

export interface SearchableRecord {
	id: string;
	toolName: string;
	title: string;
	createdTime: number;
	sketch: TokenSketch;
}

export interface RankedRecord<T extends SearchableRecord> {
	record: T;
	score: number;
}

export function createTokenSketch(text: string, options: { maxTokens: number }): TokenSketch {
	const sketch = Object.create(null) as TokenSketch;
	for (const token of tokenize(text)) {
		sketch[token] = getSketchCount(sketch, token) + 1;
		if (Object.keys(sketch).length >= options.maxTokens) break;
	}
	return sketch;
}

export function rankRecords<T extends SearchableRecord>(
	records: T[],
	query: string,
	options: { toolName?: string; limit: number },
): RankedRecord<T>[] {
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];
	const wantedTool = options.toolName?.toLowerCase();

	return records
		.filter((record) => !wantedTool || record.toolName.toLowerCase() === wantedTool)
		.map((record) => ({ record, score: scoreSketch(record.sketch, queryTokens) }))
		.filter((ranked) => ranked.score > 0)
		.sort(
			(a, b) =>
				b.score - a.score || b.record.createdTime - a.record.createdTime || a.record.id.localeCompare(b.record.id),
		)
		.slice(0, options.limit);
}

export function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9_./:-]+/g) ?? [];
}

function scoreSketch(sketch: TokenSketch, queryTokens: string[]): number {
	let score = 0;
	for (const token of queryTokens) {
		score += getSketchCount(sketch, token);
	}
	return score;
}

function getSketchCount(sketch: TokenSketch, token: string): number {
	if (!Object.hasOwn(sketch, token)) return 0;
	const value = sketch[token];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
