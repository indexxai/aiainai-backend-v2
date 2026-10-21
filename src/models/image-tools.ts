import sharp from 'sharp';

/** Image tools that aren't prompt-to-image models: making an image larger, cutting out the subject. */
export type ImageToolId = 'upscale' | 'cutout';

export interface ImageToolsConfig {
  stabilityKey?: string;
  /** API paths, overridable from env in case the provider moves them. */
  stabilityUpscalePath?: string;
  stabilityCutoutPath?: string;
  demo: boolean;
}

export interface ToolResult {
  bytes: Buffer;
  mediaType: string;
}

const STABILITY = 'https://api.stability.ai';
/** Stability's fast upscaler takes inputs up to about one megapixel. */
const UPSCALE_MAX_PIXELS = 1_048_576;

/**
 * Upscale and Remove background. With STABILITY_API_KEY these call Stability AI; in the local
 * stand-in mode they run on the server with sharp (a plain 2× resize, and cutting out the
 * background colour of the sample images). Without either, the tools are reported unavailable.
 */
export class ImageTools {
  readonly provider: 'stability' | 'demo' | null;

  constructor(private readonly cfg: ImageToolsConfig) {
    this.provider = cfg.stabilityKey ? 'stability' : cfg.demo ? 'demo' : null;
  }

  get available(): Record<ImageToolId, boolean> {
    return { upscale: !!this.provider, cutout: !!this.provider };
  }

  async run(tool: ImageToolId, input: Buffer, signal?: AbortSignal): Promise<ToolResult> {
    if (this.provider === 'stability') return this.stability(tool, input, signal);
    if (this.provider === 'demo') return tool === 'upscale' ? demoUpscale(input) : demoCutout(input);
    throw new Error('Image tools are not set up (STABILITY_API_KEY)');
  }

  private async stability(tool: ImageToolId, input: Buffer, signal?: AbortSignal): Promise<ToolResult> {
    let image = input;
    if (tool === 'upscale') {
      const m = await sharp(input).metadata();
      const px = (m.width ?? 0) * (m.height ?? 0);
      if (px > UPSCALE_MAX_PIXELS) {
        const f = Math.sqrt(UPSCALE_MAX_PIXELS / px);
        image = await sharp(input)
          .resize(Math.floor((m.width ?? 0) * f), Math.floor((m.height ?? 0) * f))
          .png()
          .toBuffer();
      }
    }
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(image)], { type: 'image/png' }), 'image.png');
    form.append('output_format', 'png');
    const path =
      tool === 'upscale'
        ? (this.cfg.stabilityUpscalePath ?? '/v2beta/stable-image/upscale/fast')
        : (this.cfg.stabilityCutoutPath ?? '/v2beta/stable-image/edit/remove-background');
    const res = await fetch(`${STABILITY}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.cfg.stabilityKey}`, accept: 'image/*' },
      body: form,
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`Stability ${tool} failed (${res.status}): ${text.slice(0, 300)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return { bytes: Buffer.from(await res.arrayBuffer()), mediaType: 'image/png' };
  }
}

async function demoUpscale(input: Buffer): Promise<ToolResult> {
  const m = await sharp(input).metadata();
  const bytes = await sharp(input)
    .resize((m.width ?? 1024) * 2, (m.height ?? 1024) * 2, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  return { bytes, mediaType: 'image/png' };
}

/** Stand-in cut-out: pixels close to the top-left corner's colour (the sample's wall) become transparent. */
async function demoCutout(input: Buffer): Promise<ToolResult> {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [r0, g0, b0] = [data[0]!, data[1]!, data[2]!];
  for (let i = 0; i < data.length; i += 4) {
    const d = Math.abs(data[i]! - r0) + Math.abs(data[i + 1]! - g0) + Math.abs(data[i + 2]! - b0);
    if (d < 40) data[i + 3] = 0;
  }
  const bytes = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
  return { bytes, mediaType: 'image/png' };
}
