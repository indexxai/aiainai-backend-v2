import { codeEmail } from './templates.js';

describe('code emails', () => {
  it('puts the spaced code in the subject, text and html', () => {
    const m = codeEmail('email-verification', '482913', 'a@b.co');
    expect(m.subject).toBe('Your aiainai code: 482 913');
    expect(m.text).toContain('482 913');
    expect(m.html).toContain('482 913');
  });

  it('keeps reset codes out of the subject line', () => {
    expect(codeEmail('forget-password', '750286', 'a@b.co').subject).not.toContain('750');
  });

  it('escapes the address in html', () => {
    expect(codeEmail('forget-password', '1', '<x>@y.z').html).not.toContain('<x>');
  });
});
