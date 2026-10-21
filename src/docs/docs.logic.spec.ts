import { describe, expect, it } from 'vitest';
import {
  docCredits,
  keepCompleteSections,
  plainText,
  sectionsDone,
  wordCount,
  writeMessages,
} from './docs.logic.js';

describe('docs logic', () => {
  it('prices documents by model and length', () => {
    expect(docCredits(2, 'medium')).toBe(6);
    expect(docCredits(1, 'short')).toBe(2);
    expect(docCredits(5, 'long')).toBe(25);
  });

  it('counts finished sections while writing and after', () => {
    const md = '## Summary\nText\n\n## Scope\nMore\n\n## Timel';
    expect(sectionsDone(md, 5, false)).toBe(2);
    expect(sectionsDone(md, 5, true)).toBe(3);
    expect(sectionsDone('', 5, false)).toBe(0);
  });

  it('keeps only complete sections before continuing', () => {
    const md = '## Summary\nText\n\n## Scope\nMore\n\n## Timel';
    expect(keepCompleteSections(md, 2)).toBe('## Summary\nText\n\n## Scope\nMore');
    expect(keepCompleteSections(md, 0)).toBe('');
  });

  it('asks only for the remaining sections when continuing', () => {
    const m = writeMessages({
      title: 'T',
      type: 'proposal',
      brief: 'b',
      tone: 'friendly',
      length: 'medium',
      sections: [
        { heading: 'Summary', note: '' },
        { heading: 'Scope', note: 'From your notes' },
      ],
      from: 1,
    });
    expect(m.prompt).toContain('2. Scope — From your notes');
    expect(m.prompt).not.toContain('1. Summary');
    expect(m.system).toContain('Tone: friendly');
  });

  it('turns Markdown into plain text for search and word count', () => {
    const t = plainText('## Scope\n- **Design** for [8 pages](https://x.y)\n\n| a | b |');
    expect(t).toBe('Scope Design for 8 pages a b');
    expect(wordCount(t)).toBe(7);
  });
});
