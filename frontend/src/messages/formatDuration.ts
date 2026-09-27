// Compact Chinese duration for the thinking header (「已思考 12 秒」). Seconds
// are rounded before splitting so 59.6s reads 「1 分钟」, never 「60 秒」.
export function formatDuration(ms: number): string {
  if (ms < 1000) return "不到 1 秒";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`;
}
