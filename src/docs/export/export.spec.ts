import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileStem } from '../docs-export.service.js';
import { fromEditor, fromMarkdown, type Block } from './blocks.js';
import { toDocx, toMarkdown, toPdf } from './render.js';

const MD = `## Summary

Roofing **matters** to *Acme* — see [our site](https://example.com).

## Scope

- Design the new site
- Build it
  - with a CMS
- [x] Kick-off done

1. Week one
2. Week two

> A quote from the client.

| Phase | Weeks |
| --- | --- |
| Design | 2 |
| Build | 3 |

\`\`\`
npm run build
\`\`\`

---

Price: [amount] &amp; terms.
`;

const EDITOR = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Summary' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bold ', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        { type: 'hardBreak' },
        { type: 'text', text: 'next line', marks: [{ type: 'aiOld' }] },
      ],
    },
    {
      type: 'taskList',
      content: [
        {
          type: 'taskItem',
          attrs: { checked: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done thing' }] }],
        },
      ],
    },
    {
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A' }] }] },
            { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'B' }] }] },
          ],
        },
        {
          type: 'tableRow',
          content: [
            { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '1' }] }] },
            { type: 'tableCell', content: [{ type: 'paragraph' }] },
          ],
        },
      ],
    },
  ],
};

const input = (blocks: Block[]) => ({
  title: 'Proposal for Acme Roofing',
  byline: 'Proposal · 7 October 2026',
  blocks,
});
const tmp = mkdtempSync(path.join(tmpdir(), 'export-'));

describe('document export', () => {
  it('reads the AI draft (Markdown) into blocks', () => {
    const b = fromMarkdown(MD);
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'h', 'list', 'list', 'quote', 'table', 'code', 'hr', 'p']);
    const list = b[3] as Extract<Block, { t: 'list' }>;
    expect(list.items.map((i) => i.checked)).toEqual([null, null, true]);
    expect(list.items[1]!.blocks.some((x) => x.t === 'list')).toBe(true); // nested
    expect((b[1] as Extract<Block, { t: 'p' }>).inl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'matters', bold: true }),
        expect.objectContaining({ text: 'our site', link: 'https://example.com' }),
      ]),
    );
    expect(JSON.stringify(b.at(-1))).toContain('[amount] & terms.');
  });

  it('reads edited documents (editor JSON), keeping marks, task items and tables', () => {
    const b = fromEditor(EDITOR);
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'list', 'table']);
    expect((b[2] as Extract<Block, { t: 'list' }>).items[0]!.checked).toBe(true);
    expect((b[3] as Extract<Block, { t: 'table' }>).header).toBe(true);
  });

  it('skips malformed nodes saved from the browser instead of failing', () => {
    const b = fromEditor({
      type: 'doc',
      content: [
        null,
        5,
        'x',
        { type: 'heading', attrs: { level: 99 }, content: [null, { type: 'text', text: 'Hi' }] },
        {},
      ],
    });
    expect(b).toHaveLength(1);
    expect(b[0]!.t).toBe('h');
  });

  it('writes Markdown with the title as the only top heading', () => {
    const md = toMarkdown(input(fromMarkdown(MD)));
    expect(md.startsWith('# Proposal for Acme Roofing\n')).toBe(true);
    expect(md).toContain('## Summary');
    expect(md).toContain('**matters**');
    expect(md).toContain('- [x] Kick-off done');
    expect(md).toContain('| Design | 2 |');
    expect(md.match(/^# /gm)).toHaveLength(1);
  });

  it('writes a Word file Word can open, with the text in it', async () => {
    const buf = await toDocx(input(fromMarkdown(MD)));
    expect(buf.subarray(0, 2).toString()).toBe('PK'); // a zip
    const f = path.join(tmp, 'a.docx');
    writeFileSync(f, buf);
    const xml = execFileSync('unzip', ['-p', f, 'word/document.xml']).toString();
    for (const t of [
      'Proposal for Acme Roofing',
      'Summary',
      'matters',
      'Kick-off done',
      'Design',
      'npm run build',
    ])
      expect(xml).toContain(t);
    const edited = await toDocx(input(fromEditor(EDITOR)));
    expect(edited.length).toBeGreaterThan(1000);
  });

  it('writes a PDF with the text and a page count', async () => {
    const { buffer, pages } = await toPdf(input(fromMarkdown(MD)));
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(pages).toBe(1);
    const f = path.join(tmp, 'a.pdf');
    writeFileSync(f, buffer);
    const text = execFileSync('pdftotext', [f, '-']).toString();
    for (const t of ['Proposal for Acme Roofing', 'Summary', 'matters', 'Week two', 'Design'])
      expect(text).toContain(t);
    expect(text).toMatch(/1\s*\/\s*1/); // page footer

    const long = fromMarkdown(
      Array.from({ length: 40 }, (_, i) => `## Part ${i}\n\n${'Words go here. '.repeat(40)}`).join('\n\n'),
    );
    expect((await toPdf(input(long))).pages).toBeGreaterThan(3);
  });

  it('makes safe file names', () => {
    expect(fileStem('Plan: Q4 / 2026?')).toBe('Plan Q4 2026');
    expect(fileStem('  ')).toBe('Document');
    expect(fileStem('Résumé — Ünïcode')).toBe('Résumé — Ünïcode');
  });
});
