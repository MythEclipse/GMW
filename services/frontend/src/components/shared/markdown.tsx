import { cn } from "cn";

/**
 * Minimal Markdown renderer for model-authored text (verdict analyses, culture
 * summaries, chatbot replies).
 *
 * Deliberately NOT a full markdown parser. The content is LLM output about
 * Discord messages — it uses **bold**, `code`, and paragraphs, and nothing more.
 * A dependency like react-markdown would add a large parse surface for output
 * that never contains links or HTML, and would introduce an XSS review burden.
 *
 * Everything is rendered as React text nodes, never `dangerouslySetInnerHTML`,
 * so the output is escaped by construction.
 */
type Block =
  | { type: "heading"; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "code"; text: string };

function parseBlocks(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let list: string[] = [];

  const flushList = () => {
    if (list.length > 0) {
      blocks.push({ type: "list", items: list });
      list = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      flushList();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushList();
      blocks.push({ type: "heading", text: heading[2] });
      continue;
    }

    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }

    flushList();
    blocks.push({ type: "paragraph", text: trimmed });
  }

  flushList();
  return blocks;
}

/** Inline `**bold**` and `` `code` ``, returned as React nodes. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match = pattern.exec(text);
  let index = 0;

  while (match !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**")) {
      nodes.push(
        <strong key={`${keyPrefix}-b${index}`} className="font-medium text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <code
          key={`${keyPrefix}-c${index}`}
          className="rounded-sm bg-surface-2 px-1 py-0.5 font-mono text-xs"
        >
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = match.index + token.length;
    match = pattern.exec(text);
    index += 1;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

export function Markdown({
  children,
  className,
  compact = false,
}: {
  children: string | null | undefined;
  className?: string;
  compact?: boolean;
}) {
  if (!children || children.trim().length === 0) {
    return (
      <p className={cn("text-xs text-ink-faint italic", className)}>
        No analysis yet.
      </p>
    );
  }

  const blocks = parseBlocks(children);

  return (
    <div
      className={cn(
        "space-y-2 text-sm leading-relaxed text-ink-soft",
        compact && "text-xs",
        className,
      )}
    >
      {blocks.map((block, i) => {
        const key = `b${i}`;
        switch (block.type) {
          case "heading":
            return (
              <p
                key={key}
                className="mt-1 text-xs font-semibold tracking-wide text-ink uppercase"
              >
                {renderInline(block.text, key)}
              </p>
            );
          case "list":
            return (
              <ul key={key} className="ml-4 list-disc space-y-1">
                {block.items.map((item, j) => (
                  <li key={`${key}-${j}`}>
                    {renderInline(item, `${key}-${j}`)}
                  </li>
                ))}
              </ul>
            );
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}
