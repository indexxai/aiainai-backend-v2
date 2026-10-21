import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiConflictResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { requestIdOf, sendSse } from '../chats/sse.js';
import { StopResultDto } from '../chats/chats.dto.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { runKey } from '../common/live-runs.js';
import { parseInput } from '../common/validation.js';
import { DOC_LENGTHS, DOC_TONES, DOC_TYPES, LINK_ACCESS } from '../database/schemas/document.schema.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { EDIT_ACTIONS, MAX_SELECTION } from './docs-ai.logic.js';
import { DocsSharingService } from './docs-sharing.service.js';
import {
  AssistantReplyDto,
  AssistantRequestDto,
  CreateDocDto,
  EditRequestDto,
  EditResultDto,
  InviteRequestDto,
  ShareDto,
  UpdateShareDto,
  DocDto,
  DocListDto,
  DocStreamDocEvent,
  EstimatesDto,
  OutlineDto,
  OutlineRequestDto,
  UpdateDocDto,
} from './docs.dto.js';
import { DocsService, type Actor } from './docs.service.js';

const modelKey = z.string().trim().min(1).max(64);
const section = z.object({
  heading: z.string().trim().min(1).max(120),
  note: z.string().trim().max(120).default(''),
});
const outlineInput = z
  .object({
    brief: z.string().trim().min(3).max(4000),
    type: z.enum(DOC_TYPES),
    model: modelKey.optional(),
    projectId: z.string().max(40).optional(),
  })
  .strict();
const createInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    type: z.enum(DOC_TYPES),
    brief: z.string().max(4000).optional(),
    sections: z.array(section).max(12),
    length: z.enum(DOC_LENGTHS).optional(),
    tone: z.enum(DOC_TONES).optional(),
    model: modelKey.optional(),
    projectId: z.string().max(40).optional(),
  })
  .strict();
const updateInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.record(z.string(), z.unknown()).optional(),
    text: z.string().max(500_000).optional(),
    aiChange: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .refine((v) => JSON.stringify(v.content ?? {}).length < 2_000_000, { message: 'Document is too large' });
const listQuery = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().max(40).optional(),
  scope: z.enum(['all', 'mine', 'shared']).optional(),
});
const shareInput = z
  .object({ linkAccess: z.enum(LINK_ACCESS).optional(), resetLink: z.boolean().optional() })
  .strict();
const inviteInput = z
  .object({
    emails: z.array(z.email().max(254)).min(1).max(10),
    message: z.string().trim().max(500).optional(),
  })
  .strict();
const editInput = z
  .object({
    text: z.string().trim().min(1).max(MAX_SELECTION),
    action: z.enum(EDIT_ACTIONS).optional(),
    instruction: z.string().trim().min(2).max(500).optional(),
    language: z.string().trim().min(2).max(40).optional(),
    // The client sends the selection plus ~700 chars of surrounding text on each side;
    // editMessages() only ever uses the first 1500 chars of it, so this just bounds the payload.
    context: z
      .string()
      .max(MAX_SELECTION + 1500)
      .optional(),
    model: modelKey.optional(),
  })
  .strict()
  .refine((v) => !!v.action !== !!v.instruction, { message: 'Give either an action or an instruction' });
const assistantInput = z
  .object({
    message: z.string().trim().min(1).max(2000),
    markdown: z.string().max(500_000),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(20_000) }))
      .max(20)
      .default([]),
    model: modelKey.optional(),
  })
  .strict();
const estimateQuery = z.object({ model: modelKey.optional() });

@ApiTags('docs')
@ApiExtraModels(DocStreamDocEvent)
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('docs')
export class DocsController {
  constructor(
    private readonly docs: DocsService,
    private readonly sharing: DocsSharingService,
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

  @Post('outline')
  @HttpCode(200)
  @ApiOperation({ summary: 'Step 1: a title and headings for the described document (costs 1 credit)' })
  @ApiBody({ type: OutlineRequestDto })
  @ApiOkResponse({ type: OutlineDto })
  async outline(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<OutlineDto> {
    return this.docs.outline(await this.actor(user), parseInput(outlineInput, body));
  }

  @Get('estimates')
  @ApiOperation({ summary: 'Credits and words for each length with the chosen model' })
  @ApiQuery({ name: 'model', required: false })
  @ApiOkResponse({ type: EstimatesDto })
  async estimates(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<EstimatesDto> {
    return this.docs.estimates(await this.actor(user), parseInput(estimateQuery, raw).model);
  }

  @Get()
  @ApiOperation({
    summary: 'Documents, most recently changed first; search titles with `q`',
    description: '`scope`: mine (default), shared (with you, read-only) or all.',
  })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'scope', required: false, enum: ['all', 'mine', 'shared'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: DocListDto })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<DocListDto> {
    return this.docs.list(await this.actor(user), parseInput(listQuery, raw));
  }

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Create a document from an approved outline (or a blank one)' })
  @ApiBody({ type: CreateDocDto })
  @ApiOkResponse({ type: DocDto })
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<DocDto> {
    return this.docs.create(await this.actor(user), parseInput(createInput, body));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A document' })
  @ApiOkResponse({ type: DocDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<DocDto> {
    return this.docs.get(await this.actor(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or save editor content (autosave)' })
  @ApiBody({ type: UpdateDocDto })
  @ApiOkResponse({ type: DocDto })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Still being written' })
  async update(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DocDto> {
    return this.docs.update(await this.actor(user), id, parseInput(updateInput, body ?? {}));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a document' })
  @ApiNoContentResponse()
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.docs.remove(await this.actor(user), id);
  }

  @Get(':id/share')
  @ApiOperation({ summary: 'Sharing settings: the public link and the people invited (owners only)' })
  @ApiOkResponse({ type: ShareDto })
  async share(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<ShareDto> {
    return this.sharing.get(await this.actor(user), id);
  }

  @Patch(':id/share')
  @ApiOperation({ summary: 'Turn the public link on or off, or make a new one' })
  @ApiBody({ type: UpdateShareDto })
  @ApiOkResponse({ type: ShareDto })
  async updateShare(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ShareDto> {
    return this.sharing.update(await this.actor(user), id, parseInput(shareInput, body ?? {}));
  }

  @Post(':id/share/invites')
  @HttpCode(200)
  @ApiOperation({ summary: 'Share with people by email (view only); each gets an email with the link' })
  @ApiBody({ type: InviteRequestDto })
  @ApiOkResponse({ type: ShareDto })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Too many people' })
  async invite(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<ShareDto> {
    const actor = { ...(await this.actor(user)), name: user.name || user.email };
    return this.sharing.invite(actor, id, parseInput(inviteInput, body));
  }

  @Delete(':id/share/invites/:email')
  @ApiOperation({ summary: 'Stop sharing with someone' })
  @ApiOkResponse({ type: ShareDto })
  async uninvite(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('email') email: string,
  ): Promise<ShareDto> {
    return this.sharing.uninvite(await this.actor(user), id, email);
  }

  @Post(':id/ai/edit')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ask AI: a suggested rewrite of the selected text (one message’s credits)',
    description: 'Nothing is changed in the document; the editor shows the suggestion to accept or reject.',
  })
  @ApiBody({ type: EditRequestDto })
  @ApiOkResponse({ type: EditResultDto })
  async aiEdit(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<EditResultDto> {
    return this.docs.aiEdit(await this.actor(user), id, parseInput(editInput, body), abortOnClose(req));
  }

  @Post(':id/ai/assistant')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Assistant panel: answers about the document, or drafts a section to add',
    description:
      'Send the editor’s current Markdown. Very long documents are read up to a limit (`truncated`).',
  })
  @ApiBody({ type: AssistantRequestDto })
  @ApiOkResponse({ type: AssistantReplyDto })
  async assistant(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<AssistantReplyDto> {
    return this.docs.assistant(
      await this.actor(user),
      id,
      parseInput(assistantInput, body),
      abortOnClose(req),
    );
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop writing the document (finished sections are kept)' })
  @ApiOkResponse({ type: StopResultDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async stop(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<StopResultDto> {
    return this.docs.stop(await this.actor(user), id);
  }

  @Post(':id/write')
  @ApiOperation({
    summary: 'Write the document from its outline, streamed (or continue after a stop)',
    description:
      'text/event-stream: `ready` {doc} → `model` → `delta` {text}… → `done` | `error` {doc}. ' +
      'Writing goes on if the page closes. To stop, call `POST /api/docs/{id}/stop`: finished sections ' +
      'are kept and only they are charged.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Event stream' })
  @ApiConflictResponse({ type: ApiErrorResponse })
  async write(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.docs.prepareWrite(await this.actor(user), id);
    const requestId = requestIdOf(req, res);
    await sendSse(req, res, runKey.doc(id), (signal) => this.docs.write(run, signal, requestId));
  }
}

/** Cancel the model call when the client gives up (closed tab, Cancel button). */
function abortOnClose(req: Request): AbortSignal {
  const ctrl = new AbortController();
  const res = req.res;
  res?.on('close', () => {
    if (!res.writableEnded) ctrl.abort();
  });
  return ctrl.signal;
}
