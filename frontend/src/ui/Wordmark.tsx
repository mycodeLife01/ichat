type WordmarkProps = { size?: number };

export function Wordmark({ size = 17 }: WordmarkProps) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      iChat
    </span>
  );
}
