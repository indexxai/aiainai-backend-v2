import type { ModelMessage } from 'ai';

export const MAX_MESSAGE_CHARS = 32_000;
/**
 * Longest answer (about 3,000 words). Without a cap the provider reserves the model's maximum,
 * and OpenRouter refuses when the balance can't cover that worst case, even for a short reply.
 */
export const MAX_ANSWER_TOKENS = 4000;
/** How much earlier conversation is sent with each message (characters, newest first). */
export const HISTORY_BUDGET_CHARS = 60_000;
export const HISTORY_MAX_MESSAGES = 40;

export interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  status: string;
}

/**
 * The conversation sent to the model: newest messages first until the budget is used,
 * skipping empty or failed answers. Always starts with a user message.
 */
export function buildHistory(messages: StoredMessage[], budget = HISTORY_BUDGET_CHARS): ModelMessage[] {
  const usable = messages.filter(
    (m) => m.role !== 'system' && m.content.trim() && (m.role === 'user' || m.status !== 'failed'),
  );
  const picked: StoredMessage[] = [];
  let used = 0;
  for (let i = usable.length - 1; i >= 0 && picked.length < HISTORY_MAX_MESSAGES; i--) {
    const m = usable[i]!;
    if (picked.length && used + m.content.length > budget) break;
    picked.unshift(m);
    used += m.content.length;
  }
  while (picked.length && picked[0]!.role !== 'user') picked.shift();
  // Merge back-to-back messages from the same side (e.g. a user message whose answer failed).
  const out: ModelMessage[] = [];
  for (const m of picked) {
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role as 'user' | 'assistant', content: m.content });
    }
  }
  return out;
}

/** Chat title from the first message: first line, trimmed to about 60 characters on a word. */
export function titleFrom(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line || 'New chat';
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** One-line preview of a message for the chat list (markdown symbols removed). */
export function previewFrom(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`~[\]|-]+/g, ' ')
    .replace(/\(https?:[^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
}

export const CONTINUE_PROMPT =
  'Continue your previous answer exactly where it stopped. Do not repeat what you already wrote.';
