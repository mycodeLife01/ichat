import { Icons } from "../ui/icons";

export function ReplyQuote({
  excerpt,
  variant,
  onRemove,
  onReveal,
  searchMessageId,
}: {
  excerpt: string;
  searchMessageId?: string;
  variant: "composer" | "message";
  onRemove?: () => void;
  onReveal?: () => void;
}) {
  if (variant === "composer") {
    return (
      <div
        className="mx-[3px] flex min-h-11 min-w-0 items-start gap-1.5 px-1.5 py-1 text-[14px] leading-5 font-normal text-reply-quote-composer"
        aria-label="回复引用"
      >
        {onReveal ? (
          <button
            type="button"
            aria-label="有关回复内容的详情"
            className="flex min-w-0 flex-1 items-start gap-1.5 border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            onClick={onReveal}
          >
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center">
              <Icons.ReplyArrow size={20} />
            </span>
            <blockquote className="min-h-9 min-w-0 flex-1 overflow-hidden py-2 whitespace-pre-wrap [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
              {excerpt}
            </blockquote>
          </button>
        ) : (
          <>
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center">
              <Icons.ReplyArrow size={20} />
            </span>
            <blockquote className="min-h-9 min-w-0 flex-1 overflow-hidden py-2 whitespace-pre-wrap [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
              {excerpt}
            </blockquote>
          </>
        )}
        {onRemove && (
          <button
            type="button"
            aria-label="取消引用"
            className="relative inline-flex h-9 w-9 shrink-0 items-center justify-center text-reply-quote-composer transition-colors duration-[120ms] motion-reduce:transition-none hover:text-reply-quote-message-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring before:absolute before:top-1/2 before:left-1/2 before:h-11 before:w-11 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']"
            onClick={onRemove}
          >
            <Icons.ReplyQuoteClose size={20} />
          </button>
        )}
      </div>
    );
  }

  const content = (
    <>
      <Icons.ReplyArrow className="shrink-0" size={20} />
      <blockquote data-search-message-id={searchMessageId} data-search-field={searchMessageId ? "reply_quote" : undefined} className="min-w-0 max-w-full overflow-hidden [overflow-wrap:break-word] text-center whitespace-normal [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]">
        {excerpt}
      </blockquote>
    </>
  );
  const baseClassName =
    "mx-2 mt-1 mb-1 flex w-[calc(100%_-_16px)] min-w-0 items-start justify-end gap-1.5 border-0 bg-transparent p-0 text-[14px] leading-5 font-normal text-reply-quote-message";

  return onReveal ? (
    <button
      type="button"
      className={`${baseClassName} cursor-pointer transition-colors duration-[120ms] motion-reduce:transition-none hover:text-reply-quote-message-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
      onClick={onReveal}
    >
      {content}
    </button>
  ) : (
    <div className={baseClassName} aria-label="回复引用">
      {content}
    </div>
  );
}
