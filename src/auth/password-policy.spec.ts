import { passwordProblems } from './password-policy.js';

describe('password rules', () => {
  it('accepts passwords that meet all three rules', () => {
    expect(passwordProblems('correct-horse')).toEqual([]);
    expect(passwordProblems('Sommer2026')).toEqual([]);
    expect(passwordProblems('пароль123')).toEqual([]); // letters in any language
  });
  it('lists what is missing', () => {
    expect(passwordProblems('short1')).toEqual(['At least 8 characters']);
    expect(passwordProblems('12345678')).toEqual(['A letter']);
    expect(passwordProblems('abcdefgh')).toEqual(['A number or symbol']);
  });
});
