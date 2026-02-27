import fs from "node:fs";
import path from "node:path";

export function loadDictionary(): Set<string> {
  const dictionaryPath = path.join(process.cwd(), "data", "words.txt");
  const raw = fs.readFileSync(dictionaryPath, "utf-8");
  const words = raw
    .split(/\r?\n/)
    .map((word) => word.trim().toLowerCase())
    .filter((word) => /^[a-z]+$/.test(word))
    .filter((word) => word.length >= 3 && word.length <= 6);
  return new Set(words);
}
