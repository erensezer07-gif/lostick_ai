import ReactMarkdown from "react-markdown";
import dynamic from "next/dynamic";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { isValidElement, ReactElement } from "react";

const MermaidBlock = dynamic(
  () => import("@/components/markdown/MermaidBlock"),
  { ssr: false },
);

interface CodeElementProps {
  className?: string;
  children?: React.ReactNode;
}

function extractMermaidCode(node: React.ReactNode): string | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<CodeElementProps>;
  const className = el.props.className ?? "";
  const match = /language-(\w+)/.exec(className);
  if (match?.[1] !== "mermaid") return null;
  return String(el.props.children ?? "").trim();
}

export type Role = "user" | "assistant" | "system";

export type SystemTone = "info" | "success" | "error";

export interface ChatSource {
  documentName: string;
  pageNumber?: number;
  preview: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  tone?: SystemTone;
  sources?: ChatSource[];
}

interface MessageBubbleProps {
  message: ChatMessage;
}

const markdownComponents = {
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-surface-variant bg-surface-container-lowest">
      <table className="w-full border-collapse text-left text-xs text-on-surface">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => (
    <thead className="bg-surface-container-high font-mono text-[10px] uppercase tracking-wider text-primary-container border-b border-surface-variant">
      {children}
    </thead>
  ),
  tbody: ({ children }: { children?: React.ReactNode }) => (
    <tbody className="divide-y divide-surface-variant/40">
      {children}
    </tbody>
  ),
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="hover:bg-surface-container-high/40 transition-colors">
      {children}
    </tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="px-3 py-2.5 font-semibold">
      {children}
    </th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="px-3 py-2.5 font-body text-body-md text-on-surface-variant leading-relaxed">
      {children}
    </td>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="font-body text-body-md text-on-surface leading-relaxed mb-2 last:mb-0 [overflow-wrap:anywhere]">
      {children}
    </p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-primary-container">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-on-surface-variant">{children}</em>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="list-disc list-outside pl-5 space-y-1 mb-2 text-on-surface marker:text-primary-container">
      {children}
    </ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="list-decimal list-outside pl-5 space-y-1 mb-2 text-on-surface marker:text-primary-container">
      {children}
    </ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="font-body text-body-md leading-relaxed">{children}</li>
  ),
  code: ({ children }: { children?: React.ReactNode }) => (
    <code className="font-mono text-[13px] bg-surface-container-high text-primary-container px-1.5 py-0.5 rounded">
      {children}
    </code>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => {
    const mermaidCode = extractMermaidCode(children);
    if (mermaidCode) {
      return <MermaidBlock code={mermaidCode} />;
    }
    return (
      <pre className="font-mono text-[13px] bg-surface-container-lowest border border-surface-variant rounded-lg p-3 my-2 overflow-x-auto text-on-surface">
        {children}
      </pre>
    );
  },
  a: ({
    children,
    href,
  }: {
    children?: React.ReactNode;
    href?: string;
  }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary-container underline hover:text-primary transition-colors"
    >
      {children}
    </a>
  ),
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="font-headline text-headline-md text-on-surface mb-2 mt-1">
      {children}
    </h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="font-headline text-lg font-semibold text-on-surface mb-2 mt-1">
      {children}
    </h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="font-headline text-base font-semibold text-on-surface mb-1.5 mt-1">
      {children}
    </h3>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="border-l-2 border-primary-container/60 pl-3 my-2 text-on-surface-variant italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-surface-variant my-3" />,
};

export default function MessageBubble({ message }: MessageBubbleProps) {
  const time = new Date(message.createdAt).toLocaleTimeString("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
  });

  if (message.role === "system") {
    const tone = message.tone ?? "info";
    const toneStyles = {
      info: {
        bg: "bg-surface-container-low",
        border: "border-outline-variant/40",
        icon: "info",
        iconColor: "text-on-surface-variant",
      },
      success: {
        bg: "bg-primary-container/10",
        border: "border-primary-container/40",
        icon: "check_circle",
        iconColor: "text-primary-container",
      },
      error: {
        bg: "bg-error-container/20",
        border: "border-error/40",
        icon: "error",
        iconColor: "text-error",
      },
    }[tone];

    return (
      <div className="flex justify-center">
        <div
          className={`inline-flex items-center gap-2 ${toneStyles.bg} border ${toneStyles.border} rounded-lg px-3 py-2 max-w-[90%]`}
        >
          <span
            className={`material-symbols-outlined ${toneStyles.iconColor} flex-shrink-0`}
            style={{ fontSize: 16 }}
          >
            {toneStyles.icon}
          </span>
          <p className="font-mono text-label-sm text-on-surface-variant [overflow-wrap:anywhere]">
            {typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content, null, 2)}
          </p>
        </div>
      </div>
    );
  }

  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] md:max-w-[70%]">
          <div className="bg-primary-container/10 border border-primary-container/25 rounded-lg px-4 py-3">
            <p className="font-body text-body-md text-on-surface whitespace-pre-wrap [overflow-wrap:anywhere]">
              {typeof message.content === "string"
                ? message.content
                : JSON.stringify(message.content, null, 2)}
            </p>
          </div>
          <p className="font-mono text-label-sm text-on-surface-variant/60 mt-1 text-right">
            {time}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 items-start">
      <div className="w-9 h-9 rounded-lg bg-surface-container-highest border border-outline-variant/40 flex items-center justify-center flex-shrink-0">
        <span
          className="material-symbols-outlined text-primary-container"
          style={{ fontSize: 18 }}
        >
          smart_toy
        </span>
      </div>
      <div className="max-w-[85%] md:max-w-[75%]">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-label-sm text-primary-container">
            Lostick AI
          </span>
          <span className="font-mono text-label-sm text-on-surface-variant/60">
            {time}
          </span>
        </div>
        <div className="bg-surface-container-low border border-surface-variant rounded-lg px-4 py-3">
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkMath]}
            rehypePlugins={[rehypeKatex]}
            components={markdownComponents}
          >
            {typeof message.content === "string"
              ? message.content
              : typeof message.content === "object" && message.content !== null
              ? (message.content as any).cevap || (message.content as any).message || JSON.stringify(message.content, null, 2)
              : String(message.content ?? "")}
          </ReactMarkdown>

          {message.sources && message.sources.length > 0 && (
            <div className="mt-4 pt-3 border-t border-outline-variant/30">
              <p className="font-mono text-[10px] font-semibold text-primary-container/80 flex items-center gap-1.5 mb-2 select-none">
                <span className="material-symbols-outlined text-[13px]">menu_book</span>
                BELGE HAFIZASI & KAYNAKLAR
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {message.sources.map((src, sIdx) => (
                  <div 
                    key={sIdx}
                    className="p-2.5 rounded bg-surface-container-highest/40 hover:bg-surface-container-highest/80 border border-outline-variant/20 hover:border-primary-container/30 transition-all group relative cursor-help"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-headline font-semibold text-[12px] text-on-surface group-hover:text-primary-container transition-colors truncate">
                          {src.documentName}
                        </p>
                        <p className="font-mono text-[10px] text-on-surface-variant/60 mt-0.5">
                          {src.pageNumber ? `Sayfa ${src.pageNumber}` : "Döküman Metni"}
                        </p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant/40 group-hover:text-primary-container transition-colors text-[14px] flex-shrink-0 mt-0.5">
                        visibility
                      </span>
                    </div>
                    {/* Floating Hover Preview Box */}
                    <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-50 w-72 bg-surface-container border border-surface-variant rounded p-3 text-[11px] text-on-surface font-body shadow-xl leading-relaxed animate-fade-in [overflow-wrap:anywhere]">
                      <p className="font-mono text-[9px] text-primary-container/70 mb-1 font-bold">KAYNAK KESİTİ:</p>
                      {src.preview}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
