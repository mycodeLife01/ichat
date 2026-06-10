import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

type MarkdownProps = { content: string };

export function Markdown({ content }: MarkdownProps) {
  return (
    <div className="body md text-[16px] leading-[1.75] text-fg max-[760px]:text-[17px]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
