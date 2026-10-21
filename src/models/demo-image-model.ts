import type { ImageModelV4, ImageModelV4CallOptions, ImageModelV4File } from '@ai-sdk/provider';
import sharp from 'sharp';

/**
 * Stand-in image model: draws a simple illustration (window, sun, desk) in colours picked from
 * the prompt, with "Sample image" on it, so AI Image can be built and tested without keys.
 */
export class DemoImageModel implements ImageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'demo';
  readonly maxImagesPerCall = 1;

  constructor(
    readonly modelId: string,
    private readonly delayMs = 400,
  ) {}

  async doGenerate(options: ImageModelV4CallOptions) {
    const prompt = options.prompt ?? '';
    if (/\bFAIL_DEMO\b/.test(prompt) && Math.random() < 0.5) throw new Error('demo: random failure');
    if (/\bBLOCK_DEMO\b/.test(prompt)) throw new Error('Your request was rejected by the safety system.');
    if (this.delayMs) await sleep(this.delayMs, options.abortSignal);
    const [w, h] = dims(options.aspectRatio ?? '1:1');
    const seed = (options.seed ?? 0) + hash(prompt);
    const source = options.files?.[0];
    if (source) {
      // Edits keep the image's size; variations and references are made at the requested shape.
      const base = options.mask
        ? fileBytes(source)
        : await sharp(fileBytes(source)).resize(w, h, { fit: 'cover' }).png().toBuffer();
      const png = await fromImage(base, options.mask ? fileBytes(options.mask) : null, seed, prompt);
      return {
        images: [new Uint8Array(png)],
        warnings: [],
        response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
      };
    }
    const png = await sharp(Buffer.from(scene(w, h, seed, prompt)))
      .png()
      .toBuffer();
    return {
      images: [new Uint8Array(png)],
      warnings: [],
      response: { timestamp: new Date(), modelId: this.modelId, headers: undefined },
    };
  }
}

function fileBytes(f: ImageModelV4File): Buffer {
  if (f.type !== 'file') throw new Error('demo: only inline image files are supported');
  return typeof f.data === 'string' ? Buffer.from(f.data, 'base64') : Buffer.from(f.data);
}

/**
 * Stand-in for working from an image. With a mask (an edit): the masked area is repainted in a
 * new colour with "Edited" on it. Without (a variation or a reference): the colours are shifted.
 */
async function fromImage(base: Buffer, mask: Buffer | null, seed: number, prompt: string): Promise<Buffer> {
  const img = sharp(base).ensureAlpha();
  const { width = 1024, height = 1024 } = await img.metadata();
  if (!mask) {
    const shifted = await sharp(base)
      .modulate({ hue: 30 + (seed % 270), saturation: 1.1 })
      .png()
      .toBuffer();
    const label = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height * 0.08}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(height * 0.035)}" font-weight="700" fill="#ffffff" opacity="0.9">${esc(/reference/i.test(prompt) ? 'From your reference' : 'Variation')}</text></svg>`,
    );
    return sharp(shifted)
      .composite([{ input: label }])
      .png()
      .toBuffer();
  }
  // OpenAI's convention: transparent mask pixels mark the area to change.
  const alpha = await sharp(mask)
    .resize(width, height, { fit: 'fill' })
    .ensureAlpha()
    .extractChannel(3)
    .negate()
    .raw()
    .toBuffer();
  const [r, g, b] = [60 + (seed % 150), 120 + ((seed >> 4) % 100), 90 + ((seed >> 8) % 140)];
  const paint = await sharp({ create: { width, height, channels: 3, background: { r, g, b } } })
    .joinChannel(alpha, { raw: { width, height, channels: 1 } })
    .png()
    .toBuffer();
  const label = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><text x="${width / 2}" y="${height * 0.08}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(height * 0.035)}" font-weight="700" fill="#ffffff" opacity="0.9">Edited</text></svg>`,
  );
  return sharp(base)
    .composite([{ input: paint }, { input: label }])
    .png()
    .toBuffer();
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    });
  });
}

function dims(ratio: string): [number, number] {
  const [a, b] = ratio.split(':').map(Number) as [number, number];
  const long = 1024;
  return a >= b ? [long, Math.round((long * b) / a)] : [Math.round((long * a) / b), long];
}

function hash(s: string) {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) x = Math.imul(x ^ s.charCodeAt(i), 16777619);
  return x >>> 0;
}

const PALETTES = [
  ['#d9c7b0', '#f0c08a', '#f6dfc0', '#5a3d2e', '#7a5a44'],
  ['#b9c4cc', '#9db7d1', '#dfe8ef', '#4a4440', '#6b625b'],
  ['#d4b8a6', '#e8a17a', '#f5cdb0', '#4b3529', '#6e4e3c'],
  ['#e1d6b8', '#f2d27b', '#faeec5', '#5b4a32', '#7d6747'],
  ['#c9d2c0', '#a8c7a0', '#e4ecd9', '#3f4a3a', '#5b6a53'],
];

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function scene(w: number, h: number, seed: number, prompt: string) {
  const [wall, glass, light, desk, frame] = PALETTES[seed % PALETTES.length]!;
  const winW = w * 0.34;
  const winH = h * 0.62;
  const winX = w * (0.12 + ((seed >> 3) % 40) / 100);
  const winY = h * 0.08;
  const deskY = h * 0.72;
  const sunR = Math.min(w, h) * 0.06;
  const caption = esc(prompt.length > 70 ? `${prompt.slice(0, 67)}…` : prompt);
  const lapX = winX + winW + w * 0.05 > w * 0.75 ? w * 0.1 : winX + winW + w * 0.05;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${wall}"/>
  <rect x="${winX - 10}" y="${winY - 10}" width="${winW + 20}" height="${winH + 20}" fill="${frame}"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH}" fill="${light}"/>
  <rect x="${winX}" y="${winY}" width="${winW}" height="${winH * 0.48}" fill="${glass}"/>
  <rect x="${winX + winW / 2 - 5}" y="${winY}" width="10" height="${winH}" fill="${frame}"/>
  <rect x="${winX}" y="${winY + winH * 0.48 - 5}" width="${winW}" height="10" fill="${frame}"/>
  <circle cx="${winX + winW * 0.7}" cy="${winY + winH * 0.6}" r="${sunR}" fill="#fff6e6"/>
  <rect x="0" y="${deskY}" width="${w}" height="${h * 0.04}" fill="${frame}"/>
  <rect x="0" y="${deskY + h * 0.04}" width="${w}" height="${h}" fill="${desk}"/>
  <rect x="${lapX}" y="${deskY - h * 0.17}" width="${w * 0.17}" height="${h * 0.16}" rx="6" fill="#2b2f36"/>
  <rect x="${lapX + 8}" y="${deskY - h * 0.17 + 8}" width="${w * 0.17 - 16}" height="${h * 0.16 - 16}" fill="#3d4553"/>
  <rect x="${lapX - w * 0.02}" y="${deskY - 6}" width="${w * 0.21}" height="8" rx="3" fill="#1f2228"/>
  <text x="${w / 2}" y="${h * 0.86}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(h * 0.045)}" font-weight="700" fill="#ffffff" opacity="0.92">Sample image</text>
  <text x="${w / 2}" y="${h * 0.92}" text-anchor="middle" font-family="sans-serif" font-size="${Math.round(h * 0.03)}" fill="#ffffff" opacity="0.8">${caption}</text>
</svg>`;
}
