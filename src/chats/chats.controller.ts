import { assistantOf } from '../assistant/assistant-name.js';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
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
  getSchemaPath,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { runKey } from '../common/live-runs.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { MAX_MESSAGE_CHARS } from './chat.logic.js';
import {
  ChatDetailDto,
  StopResultDto,
  ChatListDto,
  ChatSummaryDto,
  CreateChatDto,
  FeedbackDto,
  RunOptionsDto,
  SendMessageDto,
  StreamDeltaEvent,
  StreamEndEvent,
  StreamModelEvent,
  StreamPlanEvent,
  StreamReadyEvent,
  UpdateChatDto,
} from './chats.dto.js';
import { ChatsService, type Actor, type Run } from './chats.service.js';
import { MAX_FILES_PER_MESSAGE } from '../files/files.service.js';
import { requestIdOf, sendSse } from './sse.js';

const modelKey = z.string().trim().min(1).max(64);
const listQuery = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
/** App ids from Connections (e.g. gmail, google-calendar) and 'browser'. */
const appsOff = z.array(z.string().trim().min(1).max(40)).max(30);
const createInput = z
  .object({
    model: modelKey.optional(),
    projectId: z.string().max(40).optional(),
    appsOff: appsOff.optional(),
  })
  .strict();
const updateInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    appsOff: appsOff.optional(),
  })
  .strict();
const sendInput = z
  .object({
    text: z.string().max(MAX_MESSAGE_CHARS).default(''),
    model: modelKey.optional(),
    fileIds: z.array(z.string().max(40)).max(MAX_FILES_PER_MESSAGE).optional(),
  })
  .strict();
const runInput = z.object({ model: modelKey.optional() }).strict();
const feedbackInput = z.object({ value: z.enum(['up', 'down']).nullable() }).strict();

const STREAM_DOC = [
  'Streams the answer as `text/event-stream`. Events, in order:',
  '`ready` (StreamReadyEvent) → `plan` (StreamPlanEvent, when Jack uses his tools: documents, images,',
  'the AI Crews) → `model` (StreamModelEvent) → `delta` (StreamDeltaEvent, repeated) →',
  '`done` or `error` (StreamEndEvent). Closing the connection does not stop the answer: it is written',
  'and saved anyway. To stop, call `POST /api/chats/{id}/stop`; it is charged only if text had arrived. Not enough credits, a Pro model on Free and',
  'provider failures arrive as an `error` event with the saved message.',
].join(' ');

@ApiTags('chat')
@ApiExtraModels(StreamReadyEvent, StreamModelEvent, StreamPlanEvent, StreamDeltaEvent, StreamEndEvent)
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('chats')
export class ChatsController {
  constructor(
    private readonly chats: ChatsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<Actor> {
    const { workspace: ws, billing, space } = await this.workspaces.forRequest(user);
    return {
      userId: user.id,
      workspaceId: ws._id,
      plan: billing.plan,
      space,
      assistant: assistantOf(ws),
    };
  }

  @Get()
  @ApiOperation({ summary: 'Chats, pinned first, then most recent; search by title with `q`' })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: ChatListDto })
  async list(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<ChatListDto> {
    return this.chats.list(await this.actor(user), parseInput(listQuery, raw));
  }

  @Post()
  @ApiOperation({ summary: 'Start a new, empty chat' })
  @ApiBody({ type: CreateChatDto, required: false })
  @ApiOkResponse({ type: ChatSummaryDto })
  @HttpCode(200)
  async create(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<ChatSummaryDto> {
    return this.chats.create(await this.actor(user), parseInput(createInput, body ?? {}));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A chat with its messages' })
  @ApiOkResponse({ type: ChatDetailDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<ChatDetailDto> {
    return this.chats.get(await this.actor(user), id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, pin or unpin' })
  @ApiBody({ type: UpdateChatDto })
  @ApiOkResponse({ type: ChatSummaryDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async update(@CurrentUser() user: SessionUser, @Param('id') id: string, @Body() body: unknown) {
    return this.chats.update(await this.actor(user), id, parseInput(updateInput, body ?? {}));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete a chat' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async remove(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<void> {
    await this.chats.remove(await this.actor(user), id);
  }

  @Post(':id/stop')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Stop the answer being written in this chat',
    description: 'The open stream (if any) ends with `done` and the answer saved as stopped.',
  })
  @ApiOkResponse({ type: StopResultDto })
  @ApiNotFoundResponse({ type: ApiErrorResponse })
  async stop(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<StopResultDto> {
    return this.chats.stop(await this.actor(user), id);
  }

  @Put(':id/messages/:messageId/feedback')
  @HttpCode(204)
  @ApiOperation({ summary: 'Thumbs up / down on an answer (null clears it)' })
  @ApiBody({ type: FeedbackDto })
  @ApiNoContentResponse()
  async feedback(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { value } = parseInput(feedbackInput, body);
    await this.chats.feedback(await this.actor(user), id, messageId, value);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Send a message and stream the answer', description: STREAM_DOC })
  @ApiBody({ type: SendMessageDto })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Event stream', schema: { $ref: getSchemaPath(StreamEndEvent) } })
  @ApiConflictResponse({ type: ApiErrorResponse, description: 'Another answer is still being written' })
  async send(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const run = await this.chats.prepareSend(await this.actor(user), id, parseInput(sendInput, body));
    await this.streamRun(run, req, res);
  }

  @Post(':id/messages/:messageId/regenerate')
  @ApiOperation({ summary: 'Write the latest answer again (Regenerate / Retry)', description: STREAM_DOC })
  @ApiBody({ type: RunOptionsDto, required: false })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Event stream' })
  @ApiConflictResponse({ type: ApiErrorResponse })
  async regenerate(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const opts = parseInput(runInput, body ?? {});
    const run = await this.chats.prepareRegenerate(await this.actor(user), id, messageId, opts);
    await this.streamRun(run, req, res);
  }

  @Post(':id/messages/:messageId/continue')
  @ApiOperation({ summary: 'Continue a stopped answer', description: STREAM_DOC })
  @ApiBody({ type: RunOptionsDto, required: false })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({ description: 'Event stream' })
  @ApiConflictResponse({ type: ApiErrorResponse })
  async continue(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('messageId') messageId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const opts = parseInput(runInput, body ?? {});
    const run = await this.chats.prepareContinue(await this.actor(user), id, messageId, opts);
    await this.streamRun(run, req, res);
  }

  private streamRun(run: Run, req: Request, res: Response) {
    const requestId = requestIdOf(req, res);
    return sendSse(req, res, runKey.chat(run.chat._id.toHexString()), (signal) =>
      this.chats.stream(run, signal, requestId),
    );
  }
}
