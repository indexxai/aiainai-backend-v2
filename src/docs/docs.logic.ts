import type { DOC_LENGTHS, DOC_TONES, DOC_TYPES } from '../database/schemas/document.schema.js';

export type DocType = (typeof DOC_TYPES)[number];
export type DocLength = (typeof DOC_LENGTHS)[number];
export type DocTone = (typeof DOC_TONES)[number];

/**
 * Document pricing: the model's per-message credits × the length factor
 * (e.g. Claude Sonnet, medium: 2 × 3 = 6 credits). Words are a target, not a promise.
 */
export const LENGTHS: Record<DocLength, { factor: number; words: number; label: string }> = {
  short: { factor: 2, words: 450, label: 'Short' },
  medium: { factor: 3, words: 1100, label: 'Medium' },
  long: { factor: 5, words: 2200, label: 'Long' },
};

/** The outline step costs a flat credit, whatever model writes it. */
export const OUTLINE_CREDITS = 1;

export const TYPE_LABELS: Record<DocType, string> = {
  proposal: 'Proposal',
  report: 'Report',
  plan: 'Plan',
  'meeting-notes': 'Meeting notes',
  letter: 'Letter or email',
  article: 'Article',
  other: 'Document',
};

export interface Section {
  heading: string;
  note: string;
}

export const docCredits = (modelCredits: number, length: DocLength) => modelCredits * LENGTHS[length].factor;

export function outlineMessages(brief: string, type: DocType) {
  return {
    system: [
      'You plan documents for small businesses and creators.',
      'Return a title and 3 to 8 section headings for the document described.',
      'Headings are short (2–5 words). For each, add a very short note on where its content comes from,',
      'e.g. "From your brief" or "Suggested — common in proposals". Use placeholders like [Client name]',
      'for facts you don’t know. Do not invent names, prices or dates.',
    ].join(' '),
    prompt: `Type: ${type}\nBrief: ${brief}`,
  };
}

export function writeMessages(d: {
  title: string;
  type: DocType;
  brief: string;
  tone: DocTone;
  length: DocLength;
  sections: Section[];
  /** Sections already written (Continue): write only the rest. */
  from?: number;
}) {
  const from = d.from ?? 0;
  const perSection = Math.round(LENGTHS[d.length].words / Math.max(1, d.sections.length));
  const list = d.sections
    .map((s, i) => (i >= from ? `${i + 1}. ${s.heading}${s.note ? ` — ${s.note}` : ''}` : null))
    .filter(Boolean)
    .join('\n');
  return {
    system: [
      'You write clear, well-structured business documents in Markdown.',
      `Tone: ${d.tone}. Write about ${perSection} words per section.`,
      'Start every section with "## " followed by its heading exactly as given, in the order given.',
      'Do not add a document title, extra sections, or closing remarks about the document.',
      'Use short paragraphs; use lists or a table only where they make the content clearer.',
      'Where you need facts you don’t have (names, prices, dates), write a placeholder in square brackets.',
    ].join(' '),
    prompt: [
      from > 0
        ? 'Write the document (continue: the earlier sections are already written).'
        : 'Write the document.',
      `Title: ${d.title}`,
      `Type: ${TYPE_LABELS[d.type]}`,
      `Brief: ${d.brief || '(none)'}`,
      'Sections:',
      list,
    ].join('\n'),
  };
}

/** Headings ("## ...") that have started in the Markdown written so far. */
export function sectionsStarted(markdown: string): number {
  return (markdown.match(/^##\s+\S/gm) ?? []).length;
}

/** Sections finished: all started ones except the one still being written. */
export function sectionsDone(markdown: string, total: number, finished: boolean): number {
  const started = Math.min(total, sectionsStarted(markdown));
  return finished ? started : Math.max(0, started - 1);
}

/** Cut the Markdown back to the end of the last complete section (before Continue). */
export function keepCompleteSections(markdown: string, done: number): string {
  if (done <= 0) return '';
  const starts = [...markdown.matchAll(/^##\s+\S/gm)].map((m) => m.index!);
  const end = starts[done] ?? markdown.length;
  return markdown.slice(0, end).trimEnd();
}

/** Plain text and word count from Markdown (for search and the "N words" label). */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\-*+|\s]+/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
