import { z } from 'zod';
import { MEMORY_GROUPS, type MemoryGroup } from '../database/schemas/memory.schema.js';

export const MAX_MEMORIES = 200;
/** How many memories go with each answer (newest first). Short facts, so this stays small. */
export const PROMPT_MEMORIES = 60;
export const MAX_LEARNED_PER_MESSAGE = 2;

export const GROUP_LABEL: Record<MemoryGroup, string> = {
  about: 'About you',
  people: 'People',
  habits: 'Habits and routines',
  preferences: 'How you like things done',
};

/** Same fact, different punctuation or case: "Lives in Lahore." = "lives in lahore". */
export function memoryKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function cleanText(text: string): string {
  // Control characters (NUL, escapes…) never belong in a memory.
  const t = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Added to Jack's instructions for every answer in the space. */
export function memoryContext(memories: { text: string; group: MemoryGroup }[], space: string): string {
  if (!memories.length) return '';
  const lines = memories.map((m) => `- (${GROUP_LABEL[m.group]}) ${m.text}`);
  return [
    '',
    `What you know about the person${space === 'business' ? ' and their business' : ''} (they can see and edit`,
    'this list; use it when it helps, never recite it, and never mention it unless asked):',
    ...lines,
  ].join('\n');
}

/** Room for learnSchema at its longest (a couple of short notes), with headroom. */
export const LEARN_MAX_TOKENS = 1000;

/** Lasting facts worth remembering from one message. Every field required (strict output). */
export const learnSchema = z.object({
  memories: z
    .array(z.object({ text: z.string().max(200), group: z.enum(MEMORY_GROUPS) }))
    .max(MAX_LEARNED_PER_MESSAGE),
});

export const LEARN_SYSTEM = (known: string[]) =>
  [
    'Pick out lasting facts about the person from their latest message that would help an assistant',
    'next time: where they live, family and people they mention, routines, preferences, how they like',
    'things done, their business. Only facts they stated about themselves or their own life; nothing',
    'temporary (today’s plans), nothing about health, money amounts, politics, religion or other private',
    'categories, no guesses. Write each as a short third-person note ("Prefers morning flights").',
    'Return an empty list when there is nothing lasting. At most 2.',
    'group: about (who they are), people, habits (routines), preferences (how they like things done).',
    known.length ? `Already known (do not repeat):\n${known.map((k) => `- ${k}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
