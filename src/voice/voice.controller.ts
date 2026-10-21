import { Controller, HttpCode, HttpStatus, Post, Query, Req } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiQuery, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { AppError, ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { TranscriptDto } from './voice.dto.js';
import { MAX_VOICE_SECONDS, VoiceService } from './voice.service.js';

/** Audio formats browsers record in (Chrome/Firefox: webm or ogg; Safari: mp4). */
const AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/x-m4a',
]);
const MAX_BYTES = 10 * 1024 * 1024;
const query = z.object({
  seconds: z.coerce
    .number()
    .min(0)
    .max(MAX_VOICE_SECONDS + 10)
    .default(30),
});

@ApiTags('voice')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('voice')
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Post('transcribe')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Voice typing: turn a short recording into text for the prompt box',
    description: `Send the raw audio as the body with its audio/* content type (webm, ogg, mp4, mpeg, wav), up to ${MAX_VOICE_SECONDS} seconds and 10 MB. 1 credit per started minute; nothing is stored.`,
  })
  @ApiQuery({ name: 'seconds', required: false, description: 'How long the recording is, in seconds' })
  @ApiOkResponse({ type: TranscriptDto })
  async transcribe(
    @CurrentUser() user: SessionUser,
    @Query() raw: unknown,
    @Req() req: Request,
  ): Promise<TranscriptDto> {
    const { seconds } = parseInput(query, raw);
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!AUDIO_TYPES.has(type))
      throw new AppError('validation_failed', 'Send a voice recording (webm, ogg, mp4, mp3 or wav).', 422);
    const audio = await readBody(req, MAX_BYTES);
    const { workspace } = await this.workspaces.forRequest(user);
    return this.voice.transcribe({ userId: user.id, workspaceId: workspace._id }, audio, type, seconds);
  }
}

/**
 * Read a raw request body up to `limit` bytes. A body that is too big is read to the end and
 * dropped, so the client gets the 413 answer instead of a reset connection.
 */
function readBody(req: Request, limit: number): Promise<Buffer> {
  const tooLong = () =>
    new AppError(
      'payload_too_large',
      `That recording is too long. Keep it under ${MAX_VOICE_SECONDS / 60} minutes.`,
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  if (Number(req.headers['content-length'] ?? 0) > limit) {
    req.resume();
    return Promise.reject(tooLong());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on('end', () => (size > limit ? reject(tooLong()) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}
