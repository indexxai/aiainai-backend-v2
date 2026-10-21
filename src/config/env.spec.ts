import { validateEnv } from './env.js';

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv({ MONGODB_URI: 'mongodb://localhost:27017' });
    expect(env.PORT).toBe(4000);
    expect(env.MONGODB_DB).toBe('aiainai');
    expect(env.API_DOCS).toBeUndefined();
  });

  it('fails clearly when the database URI is missing', () => {
    expect(() => validateEnv({})).toThrow(/MONGODB_URI/);
  });
});
