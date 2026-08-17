type WordmarkProps = { size?: number };

// Brand wordmark, styled after the ChatGPT logotype: semibold weight, tight
// tracking, and a slight vertical squash (scaleY < 1, scaleX > 1) that gives
// the squat, confident look a regular text weight doesn't have.
export function Wordmark({ size = 18 }: WordmarkProps) {
  // Brand size variants are the only allowed inline font metric.
  return (
    <span
      className="wordmark"
      style={{ fontSize: size }}
    >
      iChat
    </span>
  );
}
