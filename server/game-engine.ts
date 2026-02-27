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
const FALLBACK_SETS = [
  "eirsan",
  "planet",
  "stonea",
  "trails",
  "formed",
  "stream",
  "garden",
  "rescue",
  "silent",
  "origina"
];

const totalWeight = LETTER_WEIGHTS.reduce((sum, item) => sum + item.weight, 0);

export function scoreForWord(length: number): number {
  if (length <= 3) return 1;
  if (length === 4) return 2;
  if (length === 5) return 4;
  return 7;
}

export function canBuildFromLetters(word: string, letters: string[]): boolean {
  const bank = new Map<string, number>();
  for (const letter of letters) {
    bank.set(letter, (bank.get(letter) ?? 0) + 1);
  }

  for (const char of word) {
    const count = bank.get(char) ?? 0;
    if (count <= 0) {
      return false;
    }
    bank.set(char, count - 1);
  }
  return true;
}

export function findValidWordsForLetters(words: Iterable<string>, letters: string[]): Set<string> {
  const valid = new Set<string>();
  for (const word of words) {
    if (word.length >= 3 && word.length <= letters.length && canBuildFromLetters(word, letters)) {
      valid.add(word);
    }
  }
  return valid;
}

export function generateRound(
  dictionary: Set<string>,
  minValidWords = 15
): { letters: string[]; validWords: Set<string> } {
  for (let attempt = 0; attempt < 700; attempt += 1) {
    const letters = Array.from({ length: 6 }, () => pickWeightedLetter());
    if (!letters.some((char) => VOWELS.has(char))) {
      continue;
    }
    const validWords = findValidWordsForLetters(dictionary, letters);
    if (validWords.size >= minValidWords) {
      return { letters, validWords };
    }
  }

  for (const fallback of FALLBACK_SETS) {
    const letters = fallback.slice(0, 6).split("");
    const validWords = findValidWordsForLetters(dictionary, letters);
    if (validWords.size >= 8) {
      return { letters, validWords };
    }
  }

  const letters = "planet".split("");
  return {
    letters,
    validWords: findValidWordsForLetters(dictionary, letters)
  };
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
