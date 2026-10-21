import { Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { AppError, ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { MAX_UPLOAD_BYTES } from './extract.js';
import { FileDto, FileListDto } from './files.dto.js';
import { FilesService, type FilesActor } from './files.service.js';

const uploadQuery = z.object({
  name: z.string().trim().min(1).max(300),
  projectId: z.string().max(40).optional(),
});
const listQuery = z
  .object({ q: z.string().max(100).optional(), cursor: z.string().max(40).optional() })
  .strip();
const downloadQuery = z.object({ download: z.coerce.boolean().optional() }).strip();

/** Files given to Jack, for the current space (header x-aiainai-space). */
@ApiTags('files')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<FilesActor> {
    const { workspace } = await this.workspaces.forRequest(user);
    return { userId: user.id, workspaceId: workspace._id };
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Upload a file for Jack to read (raw body, up to 20 MB)',
    description:
      'Send the file bytes as the body with the file’s content type, and its name in ?name=. PDF, Word (.docx), Excel (.xlsx), CSV, text, Markdown, JSON and images. Attach it to a message with its id.',
  })
  @ApiQuery({ name: 'name', required: true })
  @ApiQuery({ name: 'projectId', required: false, description: 'Add it straight to this project' })
  @ApiOkResponse({ type: FileDto })
  async upload(
    @CurrentUser() user: SessionUser,
    @Query() raw: unknown,
    @Req() req: Request,
  ): Promise<FileDto> {
    const { name, projectId } = parseInput(uploadQuery, raw);
    const bytes = await readBody(req, MAX_UPLOAD_BYTES);
    return this.files.upload(await this.actor(user), {
      name,
      contentType: String(req.headers['content-type'] ?? ''),
      bytes,
      projectId,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Files in this space, newest first' })
  @ApiQuery({ name: 'q', required: false, description: 'Search by name' })
  @ApiQuery({ name: 'cursor', required: false, description: 'nextCursor from the previous page' })
  @ApiOkResponse({ type: FileListDto })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<FileListDto> {
    return this.files.list(await this.actor(user), parseInput(listQuery, raw));
  }

  @Get(':id')
  @ApiOperation({ summary: 'One file’s details' })
  @ApiOkResponse({ type: FileDto })
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<FileDto> {
    return this.files.get(await this.actor(user), id);
  }

  @Get(':id/content')
  @ApiOperation({ summary: 'The file itself (open, or ?download=1 to save it)' })
  async content(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query() raw: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const q = parseInput(downloadQuery, raw);
    const f = await this.files.download(await this.actor(user), id);
    // Images and PDFs open in the browser; everything else (and ?download) is saved.
    const inline = !q.download && /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(f.contentType);
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Length', String(f.bytes.length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    );
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename="${asciiName(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    );
    res.end(f.bytes);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a file for good' })
  @ApiNoContentResponse()
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.files.remove(await this.actor(user), id);
  }
}

const asciiName = (n: string) => n.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

/**
 * Read a raw request body up to `limit` bytes. A body that is too big is read to the end and
 * dropped, so the client gets the 413 answer instead of a reset connection.
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  const tooBig = () =>
    new AppError(
      'payload_too_large',
      'That file is too large. Use files under 20 MB.',
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    req.resume();
    return Promise.reject(tooBig());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => (size > limit ? reject(tooBig()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
