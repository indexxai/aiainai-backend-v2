import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText as pdfText } from 'unpdf';
import type { UploadKind } from '../database/schemas/upload.schema.js';

/** Largest file taken (all kinds). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Text kept per file for Jack to read (about 40,000 words). Longer files are cut. */
export const MAX_FILE_TEXT = 250_000;
const MAX_SHEET_ROWS = 2000;

const EXT: Record<string, { kind: UploadKind; type: string }> = {
  pdf: { kind: 'pdf', type: 'application/pdf' },
  docx: { kind: 'word', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { kind: 'sheet', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { kind: 'sheet', type: 'text/csv' },
  txt: { kind: 'text', type: 'text/plain' },
  md: { kind: 'text', type: 'text/markdown' },
  markdown: { kind: 'text', type: 'text/markdown' },
  json: { kind: 'text', type: 'application/json' },
  jpg: { kind: 'image', type: 'image/jpeg' },
  jpeg: { kind: 'image', type: 'image/jpeg' },
  png: { kind: 'image', type: 'image/png' },
  webp: { kind: 'image', type: 'image/webp' },
  gif: { kind: 'image', type: 'image/gif' },
};
const BY_TYPE = new Map(Object.values(EXT).map((v) => [v.type, v]));

export class UnsupportedFile extends Error {}

/**
 * What kind of file this is, from its content type or (when the browser sends a generic one)
 * its extension, checked against the first bytes so a renamed file isn't taken for another.
 */
export function detect(name: string, contentType: string, bytes: Buffer): { kind: UploadKind; type: string } {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  if (ext === 'doc' || ext === 'xls' || ext === 'ppt' || ext === 'pptx')
    throw new UnsupportedFile(
      ext === 'doc'
        ? 'Old Word files (.doc) can’t be read. Save it as .docx or PDF and try again.'
        : ext === 'xls'
          ? 'Old Excel files (.xls) can’t be read. Save it as .xlsx or CSV and try again.'
          : 'Slides can’t be read yet. Save them as PDF and try again.',
    );
  const found = BY_TYPE.get(type) ?? EXT[ext];
  if (!found)
    throw new UnsupportedFile(
      'Files that can be read: PDF, Word (.docx), Excel (.xlsx), CSV, text and images.',
    );
  const head = bytes.subarray(0, 8);
  const zip = head[0] === 0x50 && head[1] === 0x4b;
  const ok =
    found.kind === 'pdf'
      ? head.subarray(0, 4).toString('latin1') === '%PDF'
      : found.kind === 'word' || (found.kind === 'sheet' && found.type !== 'text/csv')
        ? zip
        : found.kind === 'image'
          ? isImage(head)
          : !bytes.subarray(0, 8192).includes(0); // text has no NUL bytes
  if (!ok) throw new UnsupportedFile(`${name} doesn’t look like a real ${labelOf(found.kind)} file.`);
  return found;
}

function isImage(h: Buffer): boolean {
  return (
    (h[0] === 0xff && h[1] === 0xd8) || // JPEG
    h.subarray(0, 4).toString('latin1') === '\x89PNG' ||
    h.subarray(0, 4).toString('latin1') === 'RIFF' || // WebP
    h.subarray(0, 3).toString('latin1') === 'GIF'
  );
}

export const labelOf = (k: UploadKind) =>
  ({ pdf: 'PDF', word: 'Word', sheet: 'spreadsheet', text: 'text', image: 'image' })[k];

export interface Extracted {
  text: string;
  truncated: boolean;
  pages?: number;
  /** Why there's no text to read, shown to the person. */
  note?: string;
}

/** The readable text of a document. Images are described separately (see FilesService). */
export async function extract(kind: UploadKind, type: string, bytes: Buffer): Promise<Extracted> {
  if (kind === 'image') return { text: '', truncated: false };
  let text = '';
  let pages: number | undefined;
  if (kind === 'pdf') {
    const r = await pdfText(new Uint8Array(bytes), { mergePages: false });
    pages = r.totalPages;
    const list = Array.isArray(r.text) ? r.text : [r.text];
    text = list
      .map((t, i) => (list.length > 1 ? `[Page ${i + 1}]\n${tidy(t)}` : tidy(t)))
      .filter((t) => t.replace(/^\[Page \d+\]/, '').trim())
      .join('\n\n');
    if (!text.trim())
      return {
        text: '',
        truncated: false,
        pages,
        note: 'This PDF has no readable text (it may be a scan). Try a PDF with selectable text.',
      };
  } else if (kind === 'word') {
    text = tidy((await mammoth.extractRawText({ buffer: bytes })).value);
  } else if (kind === 'sheet' && type !== 'text/csv') {
    text = await sheetText(bytes);
  } else {
    text = bytes.toString('utf8').replace(/^﻿/, '');
  }
  if (!text.trim()) return { text: '', truncated: false, pages, note: 'This file is empty.' };
  const truncated = text.length > MAX_FILE_TEXT;
  return { text: truncated ? text.slice(0, MAX_FILE_TEXT) : text, truncated, pages };
}

/** Each sheet as CSV-like lines, so Jack can read the table. */
async function sheetText(bytes: Buffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    const lines: string[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      if (n > MAX_SHEET_ROWS) return;
      const cells = (row.values as unknown[]).slice(1).map(cellText);
      lines.push(cells.map(csvCell).join(','));
    });
    if (ws.rowCount > MAX_SHEET_ROWS) lines.push(`… ${ws.rowCount - MAX_SHEET_ROWS} more rows not shown`);
    if (lines.length) out.push(`[Sheet: ${ws.name}]\n${lines.join('\n')}`);
  });
  return out.join('\n\n');
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[]; hyperlink?: string };
    if (o.result !== undefined) return cellText(o.result);
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (typeof o.text === 'string') return o.text;
    return '';
  }
  return String(v);
}

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const tidy = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
