type WordmarkProps = { size?: number };

export function Wordmark({ size = 17 }: WordmarkProps) {
  return (
    <span
      className="wordmark font-sans font-semibold tracking-[-0.02em] text-fg"
      style={{ fontSize: size }}
    >
      iChat
    </span>
  );
}
