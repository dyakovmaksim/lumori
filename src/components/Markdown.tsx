import { normalizeMath } from "./normalize-math";
import { memo, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { artifactLink } from './artifact-link';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { Check, Copy, Download } from 'lucide-react';
function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const language =
    (children as { props?: { className?: string } })?.props?.className?.match(
      /language-([\w+-]+)/,
    )?.[1] || 'code';
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language}</span>
        <div>
          <button
            title="Скачать код"
            aria-label="Скачать код"
            onClick={() =>
              download(
                ref.current?.textContent || '',
                `snippet.${({ javascript: 'js', typescript: 'ts', python: 'py', bash: 'sh' } as Record<string, string>)[language] || 'txt'}`,
              )
            }
          >
            <Download size={14} />
          </button>
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(ref.current?.textContent || '');
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
              } catch {
                setError(true);
              }
            }}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}{' '}
            {error ? 'Выделите код' : copied ? 'Готово' : 'Копировать'}
          </button>
        </div>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}
export function download(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default memo(function Markdown({ text, chatId }: { text: string; chatId?: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        urlTransform={(url, key) =>
          (key === 'href' ? artifactLink(url, chatId) : undefined) ?? defaultUrlTransform(url)
        }
        // Math is parsed separately from regular markdown so formulas remain
        // legible on both desktop and narrow phone screens (\(...\), $...$,
        // and $$...$$ are supported).
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          // A malformed expression should stay readable as text instead of
          // breaking the whole assistant message.
          [rehypeKatex, { throwOnError: false, errorColor: 'var(--secondary)' }],
          // Highlight only after KaTeX has claimed math nodes, otherwise the
          // code highlighter can turn a formula into an empty <pre> block.
          rehypeHighlight,
        ]}
        components={{
          pre: CodeBlock,
          a: ({ children, ...props }) => {
            const href = props.href;
            return (
              <a {...props} href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
          img: ({ alt }) => (
            <span className="muted">[Изображение: {alt || 'внешнее изображение'}]</span>
          ),
        }}
      >
        {normalizeMath(text)}
      </ReactMarkdown>
    </div>
  );
});
