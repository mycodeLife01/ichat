type WordmarkProps = { size?: number };

// Brand wordmark, styled after the ChatGPT logotype: semibold weight, tight
// tracking, and a slight vertical squash (scaleY < 1, scaleX > 1) that gives
// the squat, confident look a regular text weight doesn't have.
export function Wordmark({ size = 18 }: WordmarkProps) {
  return (
    <span
      className="wordmark inline-block origin-left font-sans font-semibold tracking-[-0.025em] text-fg [transform:scaleX(1.04)_scaleY(0.9)]"
      style={{ fontSize: size }}
    >
      iChat
    </span>
  );
}
