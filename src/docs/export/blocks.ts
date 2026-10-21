import { marked, type Token, type Tokens } from 'marked';

/**
 * A small, format-neutral tree of a document, built from the editor's JSON (once someone has
 * edited it) or from the AI's Markdown draft. Every export format is rendered from this.
 */
export interface Inline {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  underline?: boolean;
  code?: boolean;
  link?: string;
  /** A line break inside a paragraph. */
  br?: boolean;
}

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; inl: Inline[] }
  | { t: 'p'; inl: Inline[] }
  | { t: 'list'; ordered: boolean; items: ListItem[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'code'; text: string }
  | { t: 'hr' }
  | { t: 'table'; header: boolean; rows: Inline[][][] };

export interface ListItem {
  /** null: a plain item · true/false: a checklist item, ticked or not. */
  checked: boolean | null;
  blocks: Block[];
}

/* ── From the editor (TipTap / ProseMirror JSON) ─────────────────────────────── */

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export function fromEditor(doc: Record<string, unknown>): Block[] {
  return blocksOf(cleanNodes(doc.content));
}

/**
 * Saved editor JSON comes from the browser, so it may hold nulls, numbers or nodes without a type.
 * Keep only well-formed nodes (recursively) so exporting never trips over them.
 */
function cleanNodes(list: unknown): PMNode[] {
  if (!Array.isArray(list)) return [];
  const out: PMNode[] = [];
  for (const n of list) {
    if (!n || typeof n !== 'object' || typeof (n as PMNode).type !== 'string') continue;
    const node = n as PMNode;
    out.push({
      ...node,
      attrs: node.attrs && typeof node.attrs === 'object' ? node.attrs : undefined,
      text: typeof node.text === 'string' ? node.text : undefined,
      marks: Array.isArray(node.marks)
        ? node.marks.filter((m) => m && typeof m === 'object' && typeof m.type === 'string')
        : undefined,
      content: node.content === undefined ? undefined : cleanNodes(node.content),
    });
  }
  return out;
}

function blocksOf(nodes: PMNode[]): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    switch (n.type) {
      case 'heading': {
        const lv = Number(n.attrs?.level ?? 2);
        out.push({ t: 'h', level: (lv <= 1 ? 1 : lv === 2 ? 2 : 3) as 1 | 2 | 3, inl: inlinesOf(n.content) });
        break;
      }
      case 'paragraph':
        out.push({ t: 'p', inl: inlinesOf(n.content) });
        break;
      case 'bulletList':
      case 'orderedList':
      case 'taskList':
        out.push({
          t: 'list',
          ordered: n.type === 'orderedList',
          items: (n.content ?? []).map((li) => ({
            checked: li.type === 'taskItem' ? Boolean(li.attrs?.checked) : null,
            blocks: blocksOf(li.content ?? []),
          })),
        });
        break;
      case 'blockquote':
        out.push({ t: 'quote', blocks: blocksOf(n.content ?? []) });
        break;
      case 'codeBlock':
        out.push({ t: 'code', text: (n.content ?? []).map((c) => c.text ?? '').join('') });
        break;
      case 'horizontalRule':
        out.push({ t: 'hr' });
        break;
      case 'table': {
        const rows = (n.content ?? []).map((r) => (r.content ?? []).map((cell) => cellInlines(cell)));
        const header = (n.content?.[0]?.content ?? []).some((c) => c.type === 'tableHeader');
        out.push({ t: 'table', header, rows });
        break;
      }
      default:
        // Unknown wrappers: keep their text.
        if (n.content) out.push(...blocksOf(n.content));
    }
  }
  return out;
}

function cellInlines(cell: PMNode): Inline[] {
  const parts: Inline[] = [];
  (cell.content ?? []).forEach((p, i) => {
    if (i > 0) parts.push({ text: '', br: true });
    parts.push(...inlinesOf(p.content));
  });
  return parts;
}

function inlinesOf(nodes: PMNode[] = []): Inline[] {
  const out: Inline[] = [];
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push({ text: '', br: true });
      continue;
    }
    if (n.type !== 'text' || !n.text) {
      if (n.content) out.push(...inlinesOf(n.content));
      continue;
    }
    const i: Inline = { text: n.text };
    for (const m of n.marks ?? []) {
      if (m.type === 'bold') i.bold = true;
      else if (m.type === 'italic') i.italic = true;
      else if (m.type === 'strike') i.strike = true;
      else if (m.type === 'underline') i.underline = true;
      else if (m.type === 'code') i.code = true;
      else if (m.type === 'link' && typeof m.attrs?.href === 'string') i.link = m.attrs.href;
    }
    out.push(i);
  }
  return out;
}

/* ── From Markdown (the AI's draft) ──────────────────────────────────────────── */

export function fromMarkdown(md: string): Block[] {
  return blocksOfTokens(marked.lexer(md ?? ''));
}

function blocksOfTokens(tokens: Token[]): Block[] {
  const out: Block[] = [];
  for (const tk of tokens) {
    switch (tk.type) {
      case 'heading': {
        const h = tk as Tokens.Heading;
        out.push({
          t: 'h',
          level: (h.depth <= 1 ? 1 : h.depth === 2 ? 2 : 3) as 1 | 2 | 3,
          inl: inl(h.tokens),
        });
        break;
      }
      case 'paragraph':
        out.push({ t: 'p', inl: inl((tk as Tokens.Paragraph).tokens) });
        break;
      case 'text': {
        const t = tk as Tokens.Text;
        out.push({ t: 'p', inl: t.tokens ? inl(t.tokens) : [{ text: t.text }] });
        break;
      }
      case 'list': {
        const l = tk as Tokens.List;
        out.push({
          t: 'list',
          ordered: l.ordered,
          items: l.items.map((it) => ({
            checked: it.task ? Boolean(it.checked) : null,
            blocks: blocksOfTokens(it.tokens.filter((x) => x.type !== 'checkbox')),
          })),
        });
        break;
      }
      case 'blockquote':
        out.push({ t: 'quote', blocks: blocksOfTokens((tk as Tokens.Blockquote).tokens) });
        break;
      case 'code':
        out.push({ t: 'code', text: (tk as Tokens.Code).text });
        break;
      case 'hr':
        out.push({ t: 'hr' });
        break;
      case 'table': {
        const t = tk as Tokens.Table;
        out.push({
          t: 'table',
          header: true,
          rows: [t.header.map((c) => inl(c.tokens)), ...t.rows.map((r) => r.map((c) => inl(c.tokens)))],
        });
        break;
      }
      default:
        break; // space, html, def
    }
  }
  return out;
}

function inl(tokens: Token[] = [], style: Omit<Inline, 'text'> = {}): Inline[] {
  const out: Inline[] = [];
  for (const tk of tokens) {
    switch (tk.type) {
      case 'strong':
        out.push(...inl((tk as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        out.push(...inl((tk as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        out.push(...inl((tk as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'link': {
        const l = tk as Tokens.Link;
        out.push(...inl(l.tokens, { ...style, link: l.href }));
        break;
      }
      case 'codespan':
        out.push({ ...style, text: decode((tk as Tokens.Codespan).text), code: true });
        break;
      case 'br':
        out.push({ text: '', br: true });
        break;
      case 'text': {
        const t = tk as Tokens.Text;
        if (t.tokens?.length) out.push(...inl(t.tokens, style));
        else out.push({ ...style, text: decode(t.text) });
        break;
      }
      case 'escape':
        out.push({ ...style, text: (tk as Tokens.Escape).text });
        break;
      default:
        if ('text' in tk && typeof tk.text === 'string') out.push({ ...style, text: decode(tk.text) });
    }
  }
  return out;
}

/** marked keeps HTML entities in text tokens. */
function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Plain text of some inlines (table widths, file checks). */
export const plain = (xs: Inline[]) => xs.map((x) => (x.br ? '\n' : x.text)).join('');
