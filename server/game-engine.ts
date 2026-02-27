import type { DifficultyMode } from "../shared/types";

const LETTER_WEIGHTS: Array<{ letter: string; weight: number }> = [
  { letter: "e", weight: 12.02 },
  { letter: "t", weight: 9.1 },
  { letter: "a", weight: 8.12 },
  { letter: "o", weight: 7.68 },
  { letter: "i", weight: 7.31 },
  { letter: "n", weight: 6.95 },
  { letter: "s", weight: 6.28 },
  { letter: "r", weight: 6.02 },
  { letter: "h", weight: 5.92 },
  { letter: "d", weight: 4.32 },
  { letter: "l", weight: 3.98 },
  { letter: "u", weight: 2.88 },
  { letter: "c", weight: 2.71 },
  { letter: "m", weight: 2.61 },
  { letter: "f", weight: 2.3 },
  { letter: "y", weight: 2.11 },
  { letter: "w", weight: 2.09 },
  { letter: "g", weight: 2.03 },
  { letter: "p", weight: 1.82 },
  { letter: "b", weight: 1.49 },
  { letter: "v", weight: 1.11 },
  { letter: "k", weight: 0.69 },
  { letter: "x", weight: 0.17 },
  { letter: "q", weight: 0.11 },
  { letter: "j", weight: 0.1 },
  { letter: "z", weight: 0.07 }
];

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const EASY_BLOCKED_RARE = new Set(["q", "x", "z", "j", "k", "v"]);
const EASY_SEMI_RARE = new Set(["f", "w", "y"]);
const MEDIUM_RARE = new Set(["q", "x", "z", "j", "k"]);

const FALLBACK_SETS: Record<DifficultyMode, string[]> = {
  easy: ["retain", "stared", "respin", "alters", "reason", "smiler"],
  medium: ["planet", "stream", "framed", "silent", "garden", "rescue"],
  hard: ["quartz", "jockey", "vortex", "blowzy", "wizard", "fuzzyi"]
};

const MODE_RULES: Record<
  DifficultyMode,
  {
    attempts: number;
    minScore: number;
    maxScore: number;
    targetScore: number;
    minTotalValid: number;
  }
> = {
  easy: {
    attempts: 1800,
    minScore: 1.5,
    maxScore: 3.7,
    targetScore: 2.6,
    minTotalValid: 15
  },
  medium: {
    attempts: 1400,
    minScore: 3.5,
    maxScore: 6.6,
    targetScore: 5.0,
    minTotalValid: 12
  },
  hard: {
    attempts: 1200,
    minScore: 5.8,
    maxScore: 10,
    targetScore: 7.8,
    minTotalValid: 8
  }
};

const totalWeight = LETTER_WEIGHTS.reduce((sum, item) => sum + item.weight, 0);

export interface RoundQualityMetrics {
  totalValidWords: number;
  commonWordCount: number;
  commonThreeFourCount: number;
  commonFourCount: number;
  commonFiveCount: number;
  commonSixCount: number;
  longestCommonWord: string;
  vowelCount: number;
  vowelRatio: number;
  rareLetterCount: number;
  semiRareLetterCount: number;
  anchorStrength: number;
  shortWordDensity: number;
  obscurityScore: number;
  largestWordFamily: number;
  maxLetterRepeat: number;
  difficultyScore: number;
}

interface CandidateRound {
  letters: string[];
  validWords: Set<string>;
  commonValidWords: Set<string>;
  metrics: RoundQualityMetrics;
}

export function scoreForWord(length: number): number {
  if (length <= 3) return 1;
  if (length === 4) return 2;
  if (length === 5) return 4;
  return 7;
}

export function canBuildFromLetters(word: string, letters: string[]): boolean {
  const bank = buildLetterBank(letters);
  for (const char of word) {
    const count = bank[char] ?? 0;
    if (count <= 0) {
      return false;
    }
    bank[char] = count - 1;
  }
  return true;
}

export function findValidWordsForLetters(words: Iterable<string>, letters: string[]): Set<string> {
  const valid = new Set<string>();
  const bank = buildLetterBank(letters);
  for (const word of words) {
    if (word.length >= 3 && word.length <= letters.length && canBuildWithBank(word, bank)) {
      valid.add(word);
    }
  }
  return valid;
}

export function generateRound(
  allWords: Set<string>,
  commonWords: Set<string>,
  mode: DifficultyMode = "medium"
): { letters: string[]; validWords: Set<string>; metrics: RoundQualityMetrics } {
  const allWordList = [...allWords];
  const rules = MODE_RULES[mode];
  let bestCandidate: CandidateRound | null = null;

  for (let attempt = 0; attempt < rules.attempts; attempt += 1) {
    const letters = Array.from({ length: 6 }, () => pickWeightedLetter());
    if (!passesLetterConstraints(letters, mode)) {
      continue;
    }

    const validWords = findValidWordsForLetters(allWordList, letters);
    if (validWords.size < rules.minTotalValid) {
      continue;
    }

    const commonValidWords = new Set<string>();
    for (const word of validWords) {
      if (commonWords.has(word)) {
        commonValidWords.add(word);
      }
    }

    const metrics = buildMetrics(letters, validWords, commonValidWords);
    if (!passesWordConstraints(metrics, mode)) {
      continue;
    }

    if (metrics.difficultyScore < rules.minScore || metrics.difficultyScore > rules.maxScore) {
      continue;
    }

    const candidate: CandidateRound = {
      letters,
      validWords,
      commonValidWords,
      metrics
    };

    if (!bestCandidate || compareCandidateQuality(candidate, bestCandidate, mode) < 0) {
      bestCandidate = candidate;
      if (Math.abs(candidate.metrics.difficultyScore - rules.targetScore) <= 0.2) {
        return {
          letters: candidate.letters,
          validWords: candidate.validWords,
          metrics: candidate.metrics
        };
      }
    }
  }

  if (bestCandidate) {
    return {
      letters: bestCandidate.letters,
      validWords: bestCandidate.validWords,
      metrics: bestCandidate.metrics
    };
  }

  for (const fallback of FALLBACK_SETS[mode]) {
    const letters = fallback.slice(0, 6).split("");
    const validWords = findValidWordsForLetters(allWordList, letters);
    const commonValidWords = new Set<string>();
    for (const word of validWords) {
      if (commonWords.has(word)) {
        commonValidWords.add(word);
      }
    }
    const metrics = buildMetrics(letters, validWords, commonValidWords);
    if (passesWordConstraints(metrics, mode) && passesLetterConstraints(letters, mode)) {
      return { letters, validWords, metrics };
    }
  }

  const letters = "planet".split("");
  const validWords = findValidWordsForLetters(allWordList, letters);
  const commonValidWords = new Set<string>();
  for (const word of validWords) {
    if (commonWords.has(word)) {
      commonValidWords.add(word);
    }
  }
  return {
    letters,
    validWords,
    metrics: buildMetrics(letters, validWords, commonValidWords)
  };
}

function buildMetrics(letters: string[], validWords: Set<string>, commonValidWords: Set<string>): RoundQualityMetrics {
  let commonThreeFourCount = 0;
  let commonFourCount = 0;
  let commonFiveCount = 0;
  let commonSixCount = 0;
  let longestCommonWord = "";

  for (const word of commonValidWords) {
    if (word.length <= 4) {
      commonThreeFourCount += 1;
    }
    if (word.length === 4) {
      commonFourCount += 1;
    }
    if (word.length === 5) {
      commonFiveCount += 1;
    }
    if (word.length === 6) {
      commonSixCount += 1;
    }
    if (word.length > longestCommonWord.length) {
      longestCommonWord = word;
    }
  }

  const vowelCount = letters.filter((char) => VOWELS.has(char)).length;
  const rareLetterCount = letters.filter((char) => EASY_BLOCKED_RARE.has(char)).length;
  const semiRareLetterCount = letters.filter((char) => EASY_SEMI_RARE.has(char)).length;
  const maxLetterRepeat = getMaxLetterRepeat(letters);
  const anchorStrength =
    commonSixCount > 0 ? 2 : commonFiveCount > 0 ? 1 : commonFourCount >= 2 ? 0.6 : 0;
  const shortWordDensity = commonValidWords.size === 0 ? 0 : commonThreeFourCount / commonValidWords.size;
  const obscurityScore = validWords.size === 0 ? 1 : 1 - commonValidWords.size / validWords.size;
  const largestWordFamily = findLargestWordFamily(commonValidWords);
  const difficultyScore = computeDifficultyScore({
    rareLetterCount,
    semiRareLetterCount,
    vowelCount,
    commonWordCount: commonValidWords.size,
    shortWordCount: commonThreeFourCount,
    anchorStrength,
    obscurityScore
  });

  return {
    totalValidWords: validWords.size,
    commonWordCount: commonValidWords.size,
    commonThreeFourCount,
    commonFourCount,
    commonFiveCount,
    commonSixCount,
    longestCommonWord,
    vowelCount,
    vowelRatio: vowelCount / letters.length,
    rareLetterCount,
    semiRareLetterCount,
    anchorStrength,
    shortWordDensity,
    obscurityScore,
    largestWordFamily,
    maxLetterRepeat,
    difficultyScore
  };
}

function passesLetterConstraints(letters: string[], mode: DifficultyMode): boolean {
  const vowelCount = letters.filter((char) => VOWELS.has(char)).length;
  const maxLetterRepeat = getMaxLetterRepeat(letters);

  if (mode === "easy") {
    if (letters.some((char) => EASY_BLOCKED_RARE.has(char))) return false;
    if (letters.filter((char) => EASY_SEMI_RARE.has(char)).length > 1) return false;
    if (vowelCount < 2) return false;
    if (!letters.includes("a") && !letters.includes("e")) return false;
    if (maxLetterRepeat > 2) return false;
    if (hasAwkwardCluster(letters)) return false;
    return true;
  }

  if (mode === "medium") {
    if (letters.filter((char) => MEDIUM_RARE.has(char)).length > 1) return false;
    if (vowelCount < 2) return false;
    if (maxLetterRepeat > 2) return false;
    return true;
  }

  // Hard: still require at least one vowel so rounds are not degenerate.
  return vowelCount >= 1;
}

function passesWordConstraints(metrics: RoundQualityMetrics, mode: DifficultyMode): boolean {
  if (mode === "easy") {
    if (metrics.commonWordCount < 15) return false;
    if (metrics.commonThreeFourCount < 8) return false;
    if (metrics.commonFiveCount < 1) return false;
    if (metrics.largestWordFamily < 3) return false;
    return true;
  }

  if (mode === "medium") {
    if (metrics.totalValidWords < 12) return false;
    if (metrics.commonThreeFourCount < 5) return false;
    if (!(metrics.commonFiveCount >= 1 || metrics.commonFourCount >= 2)) return false;
    return true;
  }

  return metrics.totalValidWords >= 8;
}

function compareCandidateQuality(a: CandidateRound, b: CandidateRound, mode: DifficultyMode): number {
  const target = MODE_RULES[mode].targetScore;
  const aFitness =
    Math.abs(a.metrics.difficultyScore - target) - a.metrics.commonWordCount * 0.03 - a.metrics.commonThreeFourCount * 0.02;
  const bFitness =
    Math.abs(b.metrics.difficultyScore - target) - b.metrics.commonWordCount * 0.03 - b.metrics.commonThreeFourCount * 0.02;
  return aFitness - bFitness;
}

function computeDifficultyScore({
  rareLetterCount,
  semiRareLetterCount,
  vowelCount,
  commonWordCount,
  shortWordCount,
  anchorStrength,
  obscurityScore
}: {
  rareLetterCount: number;
  semiRareLetterCount: number;
  vowelCount: number;
  commonWordCount: number;
  shortWordCount: number;
  anchorStrength: number;
  obscurityScore: number;
}): number {
  const rareLetterWeight = rareLetterCount * 1.4 + semiRareLetterCount * 0.6;
  const lowVowelPenalty = vowelCount >= 3 ? 0 : vowelCount === 2 ? 0.8 : 2.2;
  const commonCoveragePenalty = 7 / Math.max(1, commonWordCount);
  const shortWordPenalty = 5 / Math.max(1, shortWordCount);
  const noAnchorPenalty = anchorStrength > 0 ? 0 : 1.8;
  return rareLetterWeight + lowVowelPenalty + commonCoveragePenalty + shortWordPenalty + noAnchorPenalty + obscurityScore * 2.2;
}

function getMaxLetterRepeat(letters: string[]): number {
  const counts: Record<string, number> = {};
  for (const letter of letters) {
    counts[letter] = (counts[letter] ?? 0) + 1;
  }
  return Object.values(counts).reduce((max, count) => Math.max(max, count), 0);
}

function hasAwkwardCluster(letters: string[]): boolean {
  const consonants = letters.filter((char) => !VOWELS.has(char)).length;
  if (consonants >= 5) {
    return true;
  }

  const clusterLetters = new Set(["s", "t", "r", "h"]);
  const clusterCount = letters.filter((char) => clusterLetters.has(char)).length;
  return clusterCount >= 4 && consonants >= 4;
}

function findLargestWordFamily(words: Set<string>): number {
  if (words.size === 0) return 0;

  const prefixCounts = new Map<string, number>();
  const suffixCounts = new Map<string, number>();

  for (const word of words) {
    if (word.length < 3) continue;
    const prefix = word.slice(0, 2);
    const suffix = word.slice(-2);
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
  }

  const prefixMax = [...prefixCounts.values()].reduce((max, value) => Math.max(max, value), 0);
  const suffixMax = [...suffixCounts.values()].reduce((max, value) => Math.max(max, value), 0);
  return Math.max(prefixMax, suffixMax);
}

function buildLetterBank(letters: string[]): Record<string, number> {
  const bank: Record<string, number> = {};
  for (const letter of letters) {
    bank[letter] = (bank[letter] ?? 0) + 1;
  }
  return bank;
}

function canBuildWithBank(word: string, bank: Record<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const char of word) {
    const current = (used[char] ?? 0) + 1;
    used[char] = current;
    if (current > (bank[char] ?? 0)) {
      return false;
    }
  }
  return true;
}

function pickWeightedLetter(): string {
  const target = Math.random() * totalWeight;
  let running = 0;
  for (const item of LETTER_WEIGHTS) {
    running += item.weight;
    if (target <= running) {
      return item.letter;
    }
  }
  return "e";
}
