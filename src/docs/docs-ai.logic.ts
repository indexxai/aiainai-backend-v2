import { z } from 'zod';

/** Quick actions on selected text (Ask AI). A free-form instruction is the other option. */
export const EDIT_ACTIONS = ['shorter', 'formal', 'simpler', 'grammar', 'translate'] as const;
export type EditAction = (typeof EDIT_ACTIONS)[number];

const ACTION_TEXT: Record<EditAction, string> = {
  shorter: 'Make it shorter. Keep the meaning and the key facts.',
  formal: 'Make it more formal and professional.',
  simpler: 'Use simpler, everyday words and shorter sentences.',
  grammar: 'Fix spelling, grammar and punctuation only. Change nothing else.',
  translate: 'Translate it into {language}.',
};

/** The longest selection Ask AI rewrites, and how much of the document the assistant reads. */
export const MAX_SELECTION = 8000;
export const MAX_DOC_CHARS = 60_000;

export const editSchema = z.object({ text: z.string() });

export const assistantSchema = z.object({
  reply: z.string(),
  /** A section to add (or a rewrite of one), when asked for; null otherwise. */
  insert: z
    .object({
      heading: z.string(),
      markdown: z.string(),
      /** Insert after the section with this heading; null = at the end. */
      after: z.string().nullable(),
      /** Rewrite of the existing section with this heading (instead of adding a new one). */
      replaces: z.string().nullable(),
    })
    .nullable(),
});

export function editMessages(input: {
  text: string;
  action?: EditAction;
  instruction?: string;
  language?: string;
  title: string;
  context?: string;
}) {
  const task = input.action
    ? ACTION_TEXT[input.action].replace('{language}', input.language?.trim() || 'English')
    : input.instruction!.trim();
  return {
    system: [
      'You edit part of a document. Rewrite only the text between <<< and >>> as asked.',
      'Return only the rewritten text in `text`: no quotes, no comments, no headings that were not there.',
      'Keep Markdown formatting (bold, lists) where the original has it.',
      'Do not invent facts; keep placeholders in square brackets as they are.',
    ].join(' '),
    prompt: [
      `Document: ${input.title}`,
      input.context ? `Surrounding text (for context only):\n${input.context.slice(0, 1500)}` : '',
      `Action: ${input.action ?? 'custom'}`,
      `Instruction: ${task}`,
      `Text:\n<<<\n${input.text}\n>>>`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
}

interface Part {
  heading: string;
  text: string;
}

/** Split Markdown into sections at "# " / "## " headings (text before the first one has heading ""). */
export function splitSections(markdown: string): Part[] {
  const parts: Part[] = [];
  const re = /^#{1,2}\s+(.+)$/gm;
  let last = 0;
  let heading = '';
  for (const m of markdown.matchAll(re)) {
    if (m.index! > last || heading) parts.push({ heading, text: markdown.slice(last, m.index).trimEnd() });
    heading = m[1]!.trim();
    last = m.index!;
  }
  parts.push({ heading, text: markdown.slice(last).trimEnd() });
  return parts.filter((p) => p.text.trim());
}

/**
 * What the assistant reads. A long document is cut to MAX_DOC_CHARS: the sections named in the
 * request come first, then the rest in order until the limit; `truncated` tells the panel to say so.
 */
export function documentForAssistant(markdown: string, message: string) {
  if (markdown.length <= MAX_DOC_CHARS) return { text: markdown, truncated: false };
  const parts = splitSections(markdown);
  const asked = message.toLowerCase();
  const named = parts.filter((p) => p.heading && asked.includes(p.heading.toLowerCase()));
  const order = [...named, ...parts.filter((p) => !named.includes(p))];
  const keep = new Map<Part, string>();
  let size = 0;
  for (const p of order) {
    const room = MAX_DOC_CHARS - size;
    if (room < 500) break;
    // A section bigger than the room left is cut (so one huge section is still partly read).
    const text =
      p.text.length <= room ? p.text : `${p.text.slice(0, room)}\n\n[…the rest of this section is not shown]`;
    keep.set(p, text);
    size += text.length;
  }
  const text = parts
    .map((p) => keep.get(p) ?? (p.heading ? `## ${p.heading}\n\n[…not shown]` : ''))
    .filter(Boolean)
    .join('\n\n');
  return { text, truncated: true };
}

export function assistantMessages(input: {
  title: string;
  markdown: string;
  message: string;
  history: { role: 'user' | 'assistant'; content: string }[];
}) {
  const doc = documentForAssistant(input.markdown, input.message);
  const headings = splitSections(input.markdown)
    .map((p) => p.heading)
    .filter(Boolean);
  return {
    truncated: doc.truncated,
    system: [
      'You are a writing assistant inside a document editor. Answer questions about the document',
      'and suggest improvements in `reply` (short, plain Markdown).',
      'When the user asks you to write or add a section, put it in `insert`: a short heading,',
      'its Markdown body starting with "## " and the heading, `after` = the existing heading it',
      'should follow (or null for the end), and `replaces` = null.',
      'When the user asks you to rewrite, shorten or improve one existing section, put the new',
      'version in `insert` with `replaces` = that section’s heading exactly as written (`after` = null).',
      'Otherwise `insert` is null. In `reply`, say briefly what you drafted; the user reviews it in the document.',
      'Do not invent facts; use placeholders in square brackets for what you don’t know.',
      doc.truncated
        ? 'The document is long: sections marked "[…not shown]" were left out. If the user needs one, ask them to name it.'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    messages: [
      ...input.history.slice(-8).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      {
        role: 'user' as const,
        content: [
          `Document title: ${input.title}`,
          headings.length ? `Sections: ${headings.join(' · ')}` : '',
          `Document:\n${doc.text || '(empty)'}`,
          `Request: ${input.message}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
  };
}

/** A model sometimes wraps its rewrite in quotes or the markers; strip them. */
export function cleanRewrite(text: string): string {
  let t = text.trim();
  t = t.replace(/^<<<\s*/, '').replace(/\s*>>>$/, '');
  if (/^["“].*["”]$/s.test(t) && !/["“”]/.test(t.slice(1, -1))) t = t.slice(1, -1);
  return t.trim();
}
