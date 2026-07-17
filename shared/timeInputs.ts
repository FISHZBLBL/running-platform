export function normalizeTailDurationInput(value: string): string {
  const compact = value.trim().replace(/\s/g, "");
  if (!compact || compact.includes(":") || !/^\d+$/.test(compact)) {
    return value.trim();
  }

  const totalSeconds = Number(compact);
  if (!Number.isSafeInteger(totalSeconds) || totalSeconds < 0) {
    return value.trim();
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
