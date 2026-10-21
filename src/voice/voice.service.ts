import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { NoTranscriptGeneratedError, transcribe } from 'ai';
import { Types } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { CreditsService } from '../credits/credits.service.js';
import { ModelsService } from '../models/models.service.js';

/** Longest recording taken in one go (the mic stops itself here). */
export const MAX_VOICE_SECONDS = 180;
/** Voice typing costs 1 credit per started minute of speech. */
export const creditsForSeconds = (seconds: number) =>
  Math.max(1, Math.ceil(Math.min(Math.max(seconds, 1), MAX_VOICE_SECONDS) / 60));

export interface VoiceActor {
  userId: string;
  workspaceId: Types.ObjectId;
}

/**
 * Voice typing: the browser records what the person says, this turns it into text for the
 * prompt box. Nothing is stored: the audio is sent to the speech model and then dropped.
 */
@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly models: ModelsService,
    private readonly credits: CreditsService,
  ) {}

  async transcribe(
    actor: VoiceActor,
    audio: Buffer,
    mediaType: string,
    seconds: number,
  ): Promise<{ text: string; credits: number }> {
    const model = this.models.providers.transcriptionModel();
    if (!model)
      throw new AppError(
        'service_unavailable',
        'Voice typing isn’t available right now. Type your message instead.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    if (audio.length < 200)
      throw new AppError('validation_failed', 'We didn’t catch any sound. Try again.', 422);

    // Reserve what the recording should cost from its length, then charge what it actually was.
    const id = randomUUID();
    const { holdId } = await this.credits.hold({
      workspaceId: actor.workspaceId,
      amount: creditsForSeconds(seconds),
      key: `voice:${id}`,
      reason: 'Voice typing',
      ref: { kind: 'voice', id },
    });
    let text = '';
    let duration = seconds;
    try {
      const result = await transcribe({ model, audio: new Uint8Array(audio), maxRetries: 1 });
      text = result.text.trim();
      if (result.durationInSeconds) duration = result.durationInSeconds;
    } catch (e) {
      if (NoTranscriptGeneratedError.isInstance(e)) {
        // The model heard no words: same as an empty transcript below.
        await this.credits.settle({
          workspaceId: actor.workspaceId,
          holdId,
          actual: 0,
          reason: 'Voice typing',
        });
        throw new AppError('validation_failed', 'We didn’t catch any words. Try again.', 422);
      }
      await this.credits.settle({
        workspaceId: actor.workspaceId,
        holdId,
        actual: 0,
        reason: 'Voice typing',
      });
      this.logger.warn({ err: e instanceof Error ? e.message : e, mediaType }, 'transcription failed');
      throw new AppError(
        'service_unavailable',
        'We couldn’t turn that into text. Try again, or type your message.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    // Nothing heard: no charge.
    const charge = text ? creditsForSeconds(duration) : 0;
    await this.credits.settle({
      workspaceId: actor.workspaceId,
      holdId,
      actual: charge,
      reason: 'Voice typing',
    });
    if (!text) throw new AppError('validation_failed', 'We didn’t catch any words. Try again.', 422);
    return { text, credits: charge };
  }
}
