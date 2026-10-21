import { AppError } from '../common/api-error.js';
import type { SpaceKind } from '../database/schemas/workspace.schema.js';

/** The Personal assistant's name until the person picks their own. */
export const DEFAULT_ASSISTANT_NAME = 'Jack';
/** How the Personal assistant is titled while he keeps the default name. */
export const DEFAULT_ASSISTANT_TITLE = 'Jack of all trades';
/** The Business assistant (not renamable yet). */
export const BUSINESS_ASSISTANT_NAME = 'Captain Jack';
export const MAX_ASSISTANT_NAME = 20;

export interface AssistantName {
  /** What he's called in sentences ("Tell Max what you need"). */
  name: string;
  /** His title where he's named on his own (sidebar, answer label). */
  title: string;
  /** True when the person picked the name. */
  custom: boolean;
}

/** The assistant of a space: the person's own name for him in Personal, Captain Jack in Business. */
export function assistantOf(
  ws: { kind?: SpaceKind; assistantName?: string | null } | null | undefined,
): AssistantName {
  if (ws?.kind === 'business')
    return { name: BUSINESS_ASSISTANT_NAME, title: BUSINESS_ASSISTANT_NAME, custom: false };
  const own = ws?.assistantName?.trim();
  return own
    ? { name: own, title: own, custom: true }
    : { name: DEFAULT_ASSISTANT_NAME, title: DEFAULT_ASSISTANT_TITLE, custom: false };
}

/** Names of other AI assistants and our own Business assistant, which would only confuse. */
const RESERVED = new Set(
  [
    'chatgpt',
    'gpt',
    'openai',
    'claude',
    'anthropic',
    'gemini',
    'google',
    'bard',
    'deepseek',
    'kimi',
    'qwen',
    'grok',
    'copilot',
    'mistral',
    'llama',
    'meta ai',
    'siri',
    'alexa',
    'cortana',
    'perplexity',
    'captain jack',
    'jacks ai',
    "jack's ai",
  ].map(squash),
);

function squash(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** One word or a few: letters (any language) and digits, joined by single spaces, hyphens or apostrophes. */
const SHAPE = /^[\p{L}\p{M}\p{N}]+(?:[ '’-][\p{L}\p{M}\p{N}]+)*$/u;

/**
 * Check and tidy a name the person typed. Returns null for "go back to Jack" (empty, "Jack" or
 * "Jack of all trades"); throws a plain-language 422 otherwise.
 */
export function cleanAssistantName(raw: string): string | null {
  const name = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) return null;
  const sq = squash(name);
  if (sq === squash(DEFAULT_ASSISTANT_NAME) || sq === squash(DEFAULT_ASSISTANT_TITLE)) return null;
  const fail = (message: string) => new AppError('validation_failed', message, 422);
  if ([...name].length > MAX_ASSISTANT_NAME)
    throw fail(`Keep the name to ${MAX_ASSISTANT_NAME} characters or fewer.`);
  if (!SHAPE.test(name))
    throw fail('Use letters and numbers only. Spaces, hyphens and apostrophes are fine between words.');
  if (RESERVED.has(sq)) throw fail('That name belongs to another assistant. Please pick a different one.');
  return name;
}
