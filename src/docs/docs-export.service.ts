import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import { TYPE_LABELS } from './docs.logic.js';
import { DocsService, type Actor, type DocLean } from './docs.service.js';
import { fromEditor, fromMarkdown } from './export/blocks.js';
import { toDocx, toMarkdown, toPdf } from './export/render.js';

export const EXPORT_FORMATS = ['docx', 'pdf', 'md'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

const MIME: Record<ExportFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
};

export interface ExportFile {
  buffer: Buffer;
  filename: string;
  mime: string;
  /** PDF only. */
  pages: number | null;
}

/** Word, PDF and Markdown downloads of a document. Exports don't use credits. */
@Injectable()
export class DocsExportService {
  constructor(
    private readonly docs: DocsService,
    @InjectModel(DocumentRecord.name) private readonly records: Model<DocumentRecord>,
  ) {}

  /** For the owner and people it was shared with. */
  async forActor(actor: Actor, id: string, format: ExportFormat): Promise<ExportFile> {
    const { doc } = await this.docs.readable(actor, id);
    return this.render(doc, format);
  }

  /** For anyone with the share link (while the link is on). */
  async forToken(token: string, format: ExportFormat): Promise<ExportFile> {
    const doc = /^[\w-]{16,64}$/.test(token)
      ? await this.records.findOne({ shareToken: token, linkAccess: 'view', deletedAt: null }).lean<DocLean>()
      : null;
    // Same rule as the public page: a document still being written isn't shown through the link.
    if (!doc || doc.status === 'draft' || doc.status === 'writing')
      throw new AppError('not_found', 'This link isn’t available any more.', HttpStatus.NOT_FOUND);
    return this.render(doc, format);
  }

  async render(doc: DocLean, format: ExportFormat): Promise<ExportFile> {
    if (doc.status === 'draft' || doc.status === 'writing')
      throw new AppError(
        'conflict',
        'Wait until the document has been written, then export it.',
        HttpStatus.CONFLICT,
      );
    const input = {
      title: doc.title || 'Untitled document',
      byline: `${TYPE_LABELS[doc.type] ?? 'Document'} · ${new Date(doc.updatedAt).toLocaleDateString(
        'en-GB',
        {
          day: 'numeric',
          month: 'long',
          year: 'numeric',
        },
      )}`,
      blocks: doc.content ? fromEditor(doc.content) : fromMarkdown(doc.markdown ?? ''),
    };
    const filename = `${fileStem(input.title)}.${format}`;
    if (format === 'md')
      return { buffer: Buffer.from(toMarkdown(input), 'utf8'), filename, mime: MIME.md, pages: null };
    if (format === 'docx') return { buffer: await toDocx(input), filename, mime: MIME.docx, pages: null };
    const { buffer, pages } = await toPdf(input);
    return { buffer, filename, mime: MIME.pdf, pages };
  }
}

/** A safe file name from the title: "Proposal for Acme Roofing". */
export function fileStem(title: string): string {
  const s = title
    .normalize('NFKC')
    // oxlint-disable-next-line no-control-regex -- file names can't hold control characters
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  return s || 'Document';
}
