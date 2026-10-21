import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { DocsExportService, EXPORT_FORMATS } from './docs-export.service.js';
import { exportQuery, sendFile } from './docs-versions.controller.js';
import { DocsSharingService } from './docs-sharing.service.js';
import { PublicDocDto } from './docs.dto.js';

/** Share links: anyone with the link can read the document, without signing in. */
@ApiTags('docs')
@Public()
@Controller('public/docs')
export class PublicDocsController {
  constructor(
    private readonly sharing: DocsSharingService,
    private readonly exporter: DocsExportService,
  ) {}

  @Get(':token')
  @ApiOperation({ summary: 'A document shared by link (read-only, no sign-in)' })
  @ApiOkResponse({ type: PublicDocDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse, description: 'Link turned off, reset or never existed' })
  async get(@Param('token') token: string): Promise<PublicDocDto> {
    return this.sharing.publicDoc(token);
  }

  @Get(':token/export')
  @ApiOperation({ summary: 'Download a document shared by link (Word, PDF or Markdown)' })
  @ApiQuery({ name: 'format', enum: EXPORT_FORMATS })
  @ApiOkResponse({ description: 'The file' })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async export(@Param('token') token: string, @Query() query: unknown, @Res() res: Response): Promise<void> {
    const { format } = parseInput(exportQuery, query);
    sendFile(res, await this.exporter.forToken(token, format));
  }
}
