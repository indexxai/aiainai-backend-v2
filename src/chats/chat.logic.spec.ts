import { describe, expect, it } from 'vitest';
import { buildHistory, previewFrom, titleFrom } from './chat.logic.js';

const u = (content: string) => ({ role: 'user' as const, content, status: 'complete' });
const a = (content: string, status = 'complete') => ({ role: 'assistant' as const, content, status });

describe('buildHistory', () => {
  it('keeps the conversation in order and drops failed or empty answers', () => {
    const h = buildHistory([u('Hi'), a('Hello!'), u('Write a tagline'), a('', 'failed'), u('Try again')]);
    expect(h).toEqual([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
      { role: 'user', content: 'Write a tagline\n\nTry again' },
    ]);
  });

  it('keeps stopped answers (their text was shown)', () => {
    expect(buildHistory([u('Q'), a('Partial', 'stopped'), u('More')])).toHaveLength(3);
  });

  it('trims old messages to the budget and starts with a user message', () => {
    const msgs = [u('x'.repeat(50)), a('y'.repeat(50)), u('z'.repeat(50)), a('w'.repeat(50)), u('last')];
    const h = buildHistory(msgs, 120);
    expect(h[0]!.role).toBe('user');
    expect(h.at(-1)).toEqual({ role: 'user', content: 'last' });
    expect(h.length).toBeLessThan(5);
  });

  it('always includes the newest message even if it is long', () => {
    expect(buildHistory([u('a'.repeat(500))], 100)).toHaveLength(1);
  });
});

describe('titles and previews', () => {
  it('makes a short title from the first line', () => {
    expect(titleFrom('  Write a tagline for a bakery\nmore')).toBe('Write a tagline for a bakery');
    const long = titleFrom(
      'What should we put on our pricing page for the Pro plan so that people understand credits?',
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith('…')).toBe(true);
    expect(titleFrom('   ')).toBe('New chat');
  });

  it('strips markdown from previews', () => {
    expect(previewFrom('## Options\n- **One**\n- Two [link](https://x.y)')).toBe('Options One Two link');
  });
});
