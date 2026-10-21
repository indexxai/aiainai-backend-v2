import type { TranscriptionModelV4, TranscriptionModelV4CallOptions } from '@ai-sdk/provider';

/**
 * Stand-in speech-to-text for local work and tests: returns a fixed sentence, as if the person
 * said it, so voice typing can be built and tested without keys. "Silence" (under 1 KB) gives
 * no words, like a real model hearing nothing.
 */
export class DemoTranscriptionModel implements TranscriptionModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'demo';
  readonly modelId = 'demo-transcribe';

  async doGenerate(options: TranscriptionModelV4CallOptions) {
    const bytes = typeof options.audio === 'string' ? (options.audio.length * 3) / 4 : options.audio.length;
    const text =
      bytes < 1024 ? '' : 'Find me three good hotels in Dubai for next weekend under 200 dollars a night.';
    return {
      text,
      segments: [],
      language: 'en',
      durationInSeconds: undefined,
      warnings: [],
      response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
    };
  }
}
