import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { PLAN_LIMITS } from '../plans/plans.config.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { DocsExportService, EXPORT_FORMATS, type ExportFile } from './docs-export.service.js';
import { DocsVersionsService } from './docs-versions.service.js';
import { DocDto, NameVersionDto, VersionDetailDto, VersionDto, VersionListDto } from './docs.dto.js';
import { DocsService, type Actor } from './docs.service.js';

const nameInput = z.object({ name: z.string().trim().max(120).optional() }).strict();
export const exportQuery = z.object({ format: z.enum(EXPORT_FORMATS) });

/** Versions (history, preview, restore, name) and Export (Word, PDF, Markdown). */
@ApiTags('docs')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('docs')
export class DocsVersionsController {
  constructor(
    private readonly versions: DocsVersionsService,
    private readonly exporter: DocsExportService,
    private readonly docs: DocsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<Actor> {
    const { workspace: ws, billing, space } = await this.workspaces.forRequest(user);
    return {
      userId: user.id,
      workspaceId: ws._id,
      plan: billing.plan,
      space,
      email: user.email,
    };
  }

  @Get(':id/versions')
  @ApiOperation({ summary: 'Saved versions, newest first (owners only)' })
  @ApiOkResponse({ type: VersionListDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async list(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<VersionListDto> {
    const actor = await this.actor(user);
    return {
      versions: await this.versions.list(actor, id),
      historyDays: PLAN_LIMITS[actor.plan].historyDays,
    };
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({ summary: 'One version with its content (to preview)' })
  @ApiOkResponse({ type: VersionDetailDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async get(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<VersionDetailDto> {
    return this.versions.get(await this.actor(user), id, versionId);
  }

  @Post(':id/versions')
  @ApiOperation({ summary: 'Name the current version' })
  @ApiBody({ type: NameVersionDto, required: false })
  @ApiOkResponse({ type: VersionDto })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Still being written' })
  async name(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<VersionDto> {
    return this.versions.name(await this.actor(user), id, parseInput(nameInput, body ?? {}).name);
  }

  @Post(':id/versions/:versionId/restore')
  @ApiOperation({
    summary: 'Restore a version',
    description: 'The current text is saved as a version first, so a restore can be undone.',
  })
  @ApiOkResponse({ type: DocDto })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Still being written' })
  async restore(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<DocDto> {
    const actor = await this.actor(user);
    await this.versions.restore(actor, id, versionId);
    return this.docs.get(actor, id);
  }

  @Get(':id/export')
  @ApiOperation({
    summary: 'Download as Word, PDF or Markdown',
    description:
      'Owners and people it was shared with. Free (no credits). PDFs say their page count in `X-Export-Pages`.',
  })
  @ApiQuery({ name: 'format', enum: EXPORT_FORMATS })
  @ApiProduces(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/pdf',
    'text/markdown',
  )
  @ApiOkResponse({ description: 'The file' })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Not written yet' })
  async export(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() res: Response,
  ): Promise<void> {
    const { format } = parseInput(exportQuery, query);
    sendFile(res, await this.exporter.forActor(await this.actor(user), id, format));
  }
}

/** Sends an export as a download. */
export function sendFile(res: Response, f: ExportFile): void {
  const ascii = f.filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  res.setHeader('Content-Type', f.mime);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
  );
  res.setHeader('Content-Length', String(f.buffer.length));
  res.setHeader('Cache-Control', 'private, no-store');
  if (f.pages !== null) res.setHeader('X-Export-Pages', String(f.pages));
  res.end(f.buffer);
}
