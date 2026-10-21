/**
 * Password rules shown under the password field in the designs:
 * at least 8 characters, a letter, and a number or symbol.
 * The web app checks them as you type; the backend enforces them.
 */
export const PASSWORD_RULES = [
  { id: 'length', label: 'At least 8 characters', test: (pw: string) => pw.length >= 8 },
  { id: 'letter', label: 'A letter', test: (pw: string) => /\p{L}/u.test(pw) },
  { id: 'other', label: 'A number or symbol', test: (pw: string) => /[^\p{L}\s]/u.test(pw) },
] as const;

export function passwordProblems(pw: string): string[] {
  return PASSWORD_RULES.filter((r) => !r.test(pw)).map((r) => r.label);
}
