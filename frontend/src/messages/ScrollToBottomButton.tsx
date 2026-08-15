import { Icons } from "../ui/icons";

type ScrollToBottomButtonProps = {
  visible: boolean;
  onClick: () => void;
};

export function ScrollToBottomButton({
  visible,
  onClick,
}: ScrollToBottomButtonProps) {
  return (
    <button
      className="scroll-to-bottom-button"
      type="button"
      aria-label="滚动到底部"
      aria-hidden={visible ? undefined : true}
      data-visible={visible ? "true" : "false"}
      tabIndex={visible ? 0 : -1}
      onClick={onClick}
    >
      <Icons.ArrowDown size={20} />
    </button>
  );
}
