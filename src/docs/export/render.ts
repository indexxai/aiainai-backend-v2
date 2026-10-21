import { createRequire } from 'node:module';
import path from 'node:path';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import type { Block, Inline } from './blocks.js';
import { plain } from './blocks.js';

export interface ExportInput {
  title: string;
  /** "Proposal · Prepared by Sara Malik · 7 Oct 2026" */
  byline: string;
  blocks: Block[];
}

/* ── Markdown ────────────────────────────────────────────────────────────────── */

export function toMarkdown({ title, blocks }: ExportInput): string {
  const lines = [`# ${title}`, '', ...mdBlocks(blocks, '')];
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

function mdBlocks(blocks: Block[], indent: string): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        // The title is the only H1; headings inside start at ##.
        out.push(`${'#'.repeat(Math.min(6, b.level + 1))} ${mdInl(b.inl)}`, '');
        break;
      case 'p':
        out.push(indent + mdInl(b.inl).replace(/\n/g, `  \n${indent}`), '');
        break;
      case 'list':
        b.items.forEach((it, i) => {
          const mark = b.ordered ? `${i + 1}.` : '-';
          const box = it.checked === null ? '' : it.checked ? '[x] ' : '[ ] ';
          const inner = mdBlocks(it.blocks, indent + '   ').filter((l) => l !== '');
          const [first = '', ...rest] = inner;
          out.push(`${indent}${mark} ${box}${first.trimStart()}`, ...rest);
        });
        out.push('');
        break;
      case 'quote':
        out.push(...mdBlocks(b.blocks, '').map((l) => (l ? `> ${l}` : '>')), '');
        break;
      case 'code':
        out.push('```', b.text, '```', '');
        break;
      case 'hr':
        out.push('---', '');
        break;
      case 'table': {
        const rows = b.rows.map((r) => r.map((c) => mdInl(c).replace(/\|/g, '\\|').replace(/\n/g, '<br>')));
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
        const [head = [], ...body] = b.header ? rows : [Array(width).fill(''), ...rows];
        out.push(`| ${pad(head).join(' | ')} |`, `|${' --- |'.repeat(width)}`);
        for (const r of body) out.push(`| ${pad(r).join(' | ')} |`);
        out.push('');
        break;
      }
    }
  }
  return out;
}

function mdInl(xs: Inline[]): string {
  return xs
    .map((x) => {
      if (x.br) return '\n';
      let t = x.code ? `\`${x.text}\`` : x.text.replace(/([*_`])/g, '\\$1');
      if (x.bold) t = `**${t}**`;
      if (x.italic) t = `*${t}*`;
      if (x.strike) t = `~~${t}~~`;
      if (x.link) t = `[${t}](${x.link})`;
      return t;
    })
    .join('');
}

/* ── Word (.docx) ────────────────────────────────────────────────────────────── */

const FONT = 'Calibri';
const LIGHT = { style: BorderStyle.SINGLE, size: 4, color: 'E5E7EB' };

export async function toDocx({ title, byline, blocks }: ExportInput): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: title, font: FONT })] }),
    new Paragraph({
      spacing: { after: 240 },
      children: [new TextRun({ text: byline, color: '6B7280', size: 20, font: FONT })],
    }),
    ...docxBlocks(blocks, 0),
  ];
  const doc = new Document({
    title,
    creator: 'AI Station',
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function docxBlocks(
  blocks: Block[],
  depth: number,
  listRef?: { ordered: boolean; level: number },
): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        out.push(
          new Paragraph({
            heading: b.level <= 2 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2,
            spacing: { before: 280, after: 100 },
            children: runs(b.inl),
          }),
        );
        break;
      case 'p':
        out.push(
          new Paragraph({
            children: runs(b.inl),
            spacing: { after: 120 },
            ...(listRef && listItemProps(listRef)),
          }),
        );
        break;
      case 'list':
        for (const it of b.items) {
          const [first, ...rest] = it.blocks;
          const box =
            it.checked === null ? [] : [new TextRun({ text: it.checked ? '☑ ' : '☐ ', font: FONT })];
          const firstInl = first && (first.t === 'p' || first.t === 'h') ? first.inl : [];
          out.push(
            new Paragraph({
              children: [...box, ...runs(firstInl)],
              spacing: { after: 60 },
              // Checklist items show their box instead of a bullet.
              ...(it.checked === null
                ? listItemProps({ ordered: b.ordered, level: depth })
                : { indent: { left: 360 * (depth + 1) } }),
            }),
          );
          const more = first && first.t !== 'p' && first.t !== 'h' ? it.blocks : rest;
          out.push(...docxBlocks(more, depth + 1));
        }
        break;
      case 'quote':
        // Quote paragraphs: italic, indented, with a grey bar on the left.
        for (const q of b.blocks)
          if (q.t === 'p')
            out.push(
              new Paragraph({
                children: runs(q.inl.map((i) => ({ ...i, italic: true }))),
                indent: { left: 400 },
                border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D5DB', space: 12 } },
              }),
            );
          else out.push(...docxBlocks([q], depth));
        break;
      case 'code':
        for (const line of b.text.split('\n'))
          out.push(
            new Paragraph({
              shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
              children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 20 })],
            }),
          );
        break;
      case 'hr':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } },
          }),
        );
        break;
      case 'table': {
        const width = Math.max(...b.rows.map((r) => r.length));
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: LIGHT,
              bottom: LIGHT,
              left: LIGHT,
              right: LIGHT,
              insideHorizontal: LIGHT,
              insideVertical: LIGHT,
            },
            rows: b.rows.map(
              (r, ri) =>
                new TableRow({
                  tableHeader: b.header && ri === 0,
                  children: Array.from({ length: width }, (_, ci) => {
                    const cell = r[ci] ?? [];
                    return new TableCell({
                      margins: { top: 60, bottom: 60, left: 100, right: 100 },
                      ...(b.header &&
                        ri === 0 && { shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } }),
                      children: [
                        new Paragraph({
                          children: runs(
                            b.header && ri === 0 ? cell.map((i) => ({ ...i, bold: true })) : cell,
                          ),
                        }),
                      ],
                    });
                  }),
                }),
            ),
          }),
          new Paragraph({ children: [] }),
        );
        break;
      }
    }
  }
  return out;
}

function listItemProps({ ordered, level }: { ordered: boolean; level: number }) {
  return ordered
    ? { numbering: { reference: 'ordered', level: Math.min(level, 3) } }
    : { bullet: { level: Math.min(level, 3) } };
}

function runs(xs: Inline[]): ParagraphChild[] {
  return xs.map((x) => {
    if (x.br) return new TextRun({ text: '', break: 1 });
    const run = new TextRun({
      text: x.text,
      bold: x.bold,
      italics: x.italic,
      strike: x.strike,
      underline: x.underline || x.link ? {} : undefined,
      color: x.link ? '2563EB' : undefined,
      font: x.code ? 'Consolas' : FONT,
    });
    return x.link && /^(https?:|mailto:)/i.test(x.link)
      ? new ExternalHyperlink({ link: x.link, children: [run] })
      : run;
  });
}

/* ── PDF ─────────────────────────────────────────────────────────────────────── */

const require = createRequire(import.meta.url);
// pdfmake's Node build; fonts are the Roboto files it ships with.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfmake = require('pdfmake') as {
  addFonts: (f: Record<string, Record<string, string>>) => void;
  setUrlAccessPolicy: (cb: (url: string) => boolean) => void;
  setLocalAccessPolicy: (cb: (p: string) => boolean) => void;
  createPdf: (def: unknown) => { getBuffer: () => Promise<Buffer> };
};
const fontDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
pdfmake.addFonts({
  Roboto: {
    normal: path.join(fontDir, 'Roboto-Regular.ttf'),
    bold: path.join(fontDir, 'Roboto-Medium.ttf'),
    italics: path.join(fontDir, 'Roboto-Italic.ttf'),
    bolditalics: path.join(fontDir, 'Roboto-MediumItalic.ttf'),
  },
});
pdfmake.setUrlAccessPolicy(() => false); // never fetch anything from a document
pdfmake.setLocalAccessPolicy((p) => p.startsWith(fontDir));

type Pdf = Record<string, unknown> | string;

export async function toPdf({
  title,
  byline,
  blocks,
}: ExportInput): Promise<{ buffer: Buffer; pages: number }> {
  const def = {
    info: { title, creator: 'Jack’s AI' },
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 64],
    defaultStyle: { font: 'Roboto', fontSize: 11, lineHeight: 1.35, color: '#111827' },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 4] },
      byline: { fontSize: 9.5, color: '#6B7280', margin: [0, 0, 0, 18] },
      h1: { fontSize: 15, bold: true, margin: [0, 16, 0, 6] },
      h2: { fontSize: 13, bold: true, margin: [0, 12, 0, 4] },
      p: { margin: [0, 0, 0, 8] },
    },
    footer: (page: number, count: number) => ({
      text: `${page} / ${count}`,
      alignment: 'right',
      fontSize: 8.5,
      color: '#9CA3AF',
      margin: [0, 24, 56, 0],
    }),
    content: [{ text: title, style: 'title' }, { text: byline, style: 'byline' }, ...pdfBlocks(blocks)],
  };
  const buffer = await pdfmake.createPdf(def).getBuffer();
  const pages = (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  return { buffer, pages };
}

function pdfBlocks(blocks: Block[]): Pdf[] {
  const out: Pdf[] = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'h':
        out.push({ text: pdfInl(b.inl), style: b.level <= 2 ? 'h1' : 'h2', headlineLevel: 1 });
        break;
      case 'p':
        out.push({ text: pdfInl(b.inl), style: 'p' });
        break;
      case 'list':
        // Each item is a marker column (bullet, number or a drawn checkbox) and its content.
        out.push({
          stack: b.items.map((it, i) => ({
            columns: [
              { width: 16, ...marker(b.ordered, i, it.checked) },
              {
                width: '*',
                stack: pdfBlocks(it.blocks).map((x) =>
                  typeof x === 'object' && x.style === 'p' ? { ...x, margin: [0, 0, 0, 2] } : x,
                ),
              },
            ],
            columnGap: 2,
          })),
          margin: [0, 0, 0, 8],
        });
        break;
      case 'quote':
        out.push({
          table: { widths: ['*'], body: [[{ stack: pdfBlocks(b.blocks), italics: true, color: '#374151' }]] },
          layout: {
            hLineWidth: () => 0,
            vLineWidth: (i: number) => (i === 0 ? 2 : 0),
            vLineColor: () => '#D1D5DB',
            paddingLeft: () => 12,
          },
          margin: [0, 0, 0, 8],
        });
        break;
      case 'code':
        out.push({
          table: {
            widths: ['*'],
            body: [[{ text: b.text, fontSize: 9.5, preserveLeadingSpaces: true, fillColor: '#F3F4F6' }]],
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 8],
        });
        break;
      case 'hr':
        out.push({
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: 483, y2: 0, lineWidth: 0.75, lineColor: '#D1D5DB' }],
          margin: [0, 6, 0, 12],
        });
        break;
      case 'table': {
        const width = Math.max(...b.rows.map((r) => r.length));
        out.push({
          table: {
            headerRows: b.header ? 1 : 0,
            widths: Array(width).fill('*'),
            body: b.rows.map((r, ri) =>
              Array.from({ length: width }, (_, ci) => ({
                text: pdfInl(r[ci] ?? []),
                bold: b.header && ri === 0,
                fillColor: b.header && ri === 0 ? '#F3F4F6' : undefined,
                fontSize: 10,
              })),
            ),
          },
          layout: {
            hLineColor: () => '#E5E7EB',
            vLineColor: () => '#E5E7EB',
            paddingTop: () => 4,
            paddingBottom: () => 4,
          },
          margin: [0, 2, 0, 10],
        });
        break;
      }
    }
  }
  return out;
}

function marker(ordered: boolean, i: number, checked: boolean | null): Record<string, unknown> {
  if (checked === null) return { text: ordered ? `${i + 1}.` : '•', color: '#374151' };
  // Roboto has no ballot-box glyphs: draw the box (and tick) instead.
  return {
    canvas: [
      { type: 'rect', x: 0, y: 3.5, w: 9, h: 9, r: 1.5, lineWidth: 0.8, lineColor: '#6B7280' },
      ...(checked
        ? [
            {
              type: 'polyline',
              lineWidth: 1.2,
              lineColor: '#111827',
              points: [
                { x: 2, y: 8 },
                { x: 4, y: 10.5 },
                { x: 7.5, y: 5 },
              ],
            },
          ]
        : []),
    ],
  };
}

function pdfInl(xs: Inline[]): Pdf[] {
  if (!xs.length) return [' '];
  return xs.map((x) =>
    x.br
      ? '\n'
      : {
          text: x.text,
          bold: x.bold,
          italics: x.italic,
          decoration: x.strike ? 'lineThrough' : x.underline || x.link ? 'underline' : undefined,
          color: x.link ? '#2563EB' : undefined,
          link: x.link && /^(https?:|mailto:)/i.test(x.link) ? x.link : undefined,
          background: x.code ? '#F3F4F6' : undefined,
        },
  );
}

export { plain };
