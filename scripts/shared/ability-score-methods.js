export const STANDARD_ARRAY_SCORE_COUNT = 6;
export const DEFAULT_STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);

export function parseStandardArrayScores(scores) {
    if (!Array.isArray(scores) || scores.length !== STANDARD_ARRAY_SCORE_COUNT) return null;

    const parsed = scores.map(score => Number(score));
    if (parsed.some(score => !Number.isInteger(score) || score < 1 || score > 30)) return null;
    return parsed;
}

export function normalizeStandardArrayScores(scores) {
    return parseStandardArrayScores(scores) || [...DEFAULT_STANDARD_ARRAY];
}
