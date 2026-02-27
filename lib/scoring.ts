export function pointsForLength(length: number): number {
  if (length <= 3) return 1;
  if (length === 4) return 2;
  if (length === 5) return 4;
  return 7;
}
