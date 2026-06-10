import { useState, type ReactNode } from "react";

type MessageActionProps = {
  // Accessible name of the action and the text shown in the hover dropdown.
  label: string;
  // The icon node. Passed pre-rendered (rather than a component) so callers can
  // stack/cross-fade icons without remounting a DOM node under the cursor — a
  // remount would fire a spurious mouseenter and re-open the dropdown after a
  // click.
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  // Shown in the dropdown instead of the label while disabled (e.g. an active-run
  // reason). Falls back to the label when omitted.
  disabledReason?: string | null;
};

// An icon-only message action. The label is hidden by default and appears in a
// small dropdown below the icon on hover. Clicking runs the action and hides the
// dropdown — it only re-appears on a fresh hover, so it doesn't linger over a
// just-clicked button.
export function MessageAction({
  label,
  icon,
  onClick,
  disabled = false,
  disabledReason = null,
}: MessageActionProps) {
  const [showTip, setShowTip] = useState(false);
  const tip = disabled ? (disabledReason ?? label) : label;

  return (
    <div
      className="msg-action-wrap"
      onMouseEnter={() => setShowTip(true)}
      onMouseLeave={() => setShowTip(false)}
    >
      <button
        className="msg-action icon-only"
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          onClick();
          setShowTip(false);
        }}
      >
        {icon}
      </button>
      {showTip && <span className="msg-action-tip">{tip}</span>}
    </div>
  );
}
