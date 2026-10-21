import type { IMAGE_STYLES } from '../database/schemas/image.schema.js';

export type ImageStyle = (typeof IMAGE_STYLES)[number];

const STYLE_TEXT: Record<ImageStyle, string> = {
  photo: 'a realistic photograph, natural light, sharp focus',
  illustration: 'a clean editorial illustration',
  '3d': 'a soft 3D render',
  flat: 'a flat vector illustration with simple shapes and a limited palette',
  none: '',
};

/** The prompt sent to the image model: what they wrote, the style, and what to leave out. */
export function imagePrompt(prompt: string, style: ImageStyle, negative: string): string {
  const parts = [prompt.trim().replace(/[.\s]+$/, '')];
  if (STYLE_TEXT[style]) parts.push(`Style: ${STYLE_TEXT[style]}`);
  if (negative.trim()) parts.push(`Do not include: ${negative.trim()}`);
  return `${parts.join('. ')}.`;
}

/** Gallery title: the first few words of the prompt, capitalised. */
export function imageTitle(prompt: string): string {
  const words = prompt.trim().replace(/\s+/g, ' ').split(' ');
  const t = words
    .slice(0, 7)
    .join(' ')
    .replace(/[,.;:]+$/, '');
  const title = words.length > 7 ? `${t}…` : t;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** How many images "Variations" makes. */
export const VARIATION_COUNT = 4;
/** Fixed prices for the image tools (the design's numbers), and the plan they need. */
export const UPSCALE_CREDITS = 2;
export const CUTOUT_CREDITS = 1;
export const TOOL_PLAN = 'pro' as const;

const REFERENCE_TEXT = {
  style:
    'Use the attached image only for its style: colours, light, texture and mood. The content comes from the description.',
  layout:
    'Keep the composition and layout of the attached image: where things are and the camera angle. Change what the description asks for.',
  subject:
    'Keep the main subject of the attached image recognisable (same object, product or character). Place it as the description says.',
} as const;

export function referencePrompt(
  prompt: string,
  use: keyof typeof REFERENCE_TEXT,
  style: ImageStyle,
  negative: string,
): string {
  return `${REFERENCE_TEXT[use]} ${imagePrompt(prompt, style, negative)}`;
}

export function variationPrompt(original: string): string {
  return `Make a new variation of the attached image. Keep the subject, setting and style close to it, but vary the details, pose and framing. It shows: ${original.trim()}`;
}

export function editPrompt(instruction: string): string {
  return `Change only the marked area of the attached image: ${instruction.trim()}. Keep everything else exactly the same, and match the light and style.`;
}

export function improveMessages(prompt: string, style: ImageStyle) {
  return {
    system: [
      'You rewrite short image prompts into one clear, vivid description for an image model.',
      'Keep the person’s idea and every detail they gave; add subject, setting, light, colours and framing.',
      'One or two sentences, under 60 words, no lists, no quotes, no camera brand names.',
      'Do not add text, logos or real people unless asked.',
    ].join(' '),
    prompt: `Prompt: ${prompt.trim()}${STYLE_TEXT[style] ? `\nStyle: ${STYLE_TEXT[style]}` : ''}`,
  };
}
