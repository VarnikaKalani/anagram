import fs from "node:fs";
import path from "node:path";

const VOWELS = new Set(["a", "e", "i", "o", "u"]);
const VERY_RARE_LETTERS = new Set(["q", "x", "z", "j"]);
const SEMI_RARE_LETTERS = new Set(["k", "v"]);
const COMMON_BIGRAMS = new Set([
  "th",
  "he",
  "in",
  "er",
  "an",
  "re",
  "on",
  "at",
  "en",
  "nd",
  "ti",
  "es",
  "or",
  "te",
  "of",
  "ed",
  "is",
  "it",
  "al",
  "ar",
  "st",
  "to",
  "nt",
  "ng",
  "se",
  "ha",
  "as",
  "ou",
  "io",
  "le",
  "ve",
  "co",
  "me",
  "de",
  "hi",
  "ri",
  "ro",
  "ic",
  "ne",
  "ea",
  "ra",
  "ce",
  "li",
  "ch",
  "ll",
  "be",
  "ma",
  "si",
  "om",
  "ur",
  "ca",
  "el"
]);
const UNCOMMON_BIGRAMS = new Set([
  "qx",
  "xq",
  "qj",
  "jq",
  "zx",
  "xz",
  "vj",
  "jv",
  "wq",
  "qv",
  "vf",
  "fj"
]);

export interface WordLists {
  allWords: Set<string>;
  commonWords: Set<string>;
}

export function loadDictionary(): Set<string> {
  const dictionaryPath = path.join(process.cwd(), "data", "words.txt");
  return loadWordSet(dictionaryPath);
}

export function loadWordLists(): WordLists {
  const allWords = loadDictionary();
  const commonPath = path.join(process.cwd(), "data", "common-words.txt");

  let commonWords: Set<string>;
  if (fs.existsSync(commonPath)) {
    const fromFile = loadWordSet(commonPath);
    commonWords = new Set([...fromFile].filter((word) => allWords.has(word)));
  } else {
    commonWords = deriveCommonWords(allWords);
  }

  return { allWords, commonWords };
}

function loadWordSet(filePath: string): Set<string> {
  const raw = fs.readFileSync(filePath, "utf-8");
  const words = raw
    .split(/\r?\n/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => /^[a-z]+$/.test(word))
    .filter((word) => word.length >= 3 && word.length <= 6);
  return new Set(words);
}

function deriveCommonWords(allWords: Set<string>): Set<string> {
  const common = new Set<string>();
  for (const word of allWords) {
    if (estimateCommonness(word) >= 4) {
      common.add(word);
    }
  }
  return common;
}

function estimateCommonness(word: string): number {
  let score = 0;
  const letters = word.split("");
  const vowelCount = letters.filter((char) => VOWELS.has(char)).length;

  if (vowelCount >= 1) {
    score += 1.5;
  }
  if (word.length <= 4) {
    score += 1.5;
  } else if (word.length === 5) {
    score += 1;
  }

  for (let index = 0; index < word.length - 1; index += 1) {
    const pair = `${word[index]}${word[index + 1]}`;
    if (COMMON_BIGRAMS.has(pair)) {
      score += 0.8;
    }
    if (UNCOMMON_BIGRAMS.has(pair)) {
      score -= 1.6;
    }
  }

  for (const letter of letters) {
    if (VERY_RARE_LETTERS.has(letter)) {
      score -= 2;
    } else if (SEMI_RARE_LETTERS.has(letter)) {
      score -= 0.8;
    }
  }

  if (/(.)\1\1/.test(word)) {
    score -= 2;
  }
  if (/[^aeiou]{4,}/.test(word)) {
    score -= 1.8;
  }
  if (/^[a-z]{3}$/.test(word)) {
    score += 0.5;
  }

  return score;
}
