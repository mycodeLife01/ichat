export async function copyText(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return false;

  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return false;
  }

  return true;
}
