import { validateEnv } from './env.js';

describe('validateEnv', () => {
  it('applies defaults', () => {
    const env = validateEnv({ MONGODB_URI: 'mongodb://localhost:27017' });
    expect(env.PORT).toBe(4000);
    expect(env.MONGODB_DB).toBe('aiainai');
    expect(env.API_DOCS).toBeUndefined();
  });

  it('drops a trailing slash from APP_URL so CORS matches the browser origin', () => {
    const env = validateEnv({ MONGODB_URI: 'mongodb://x', APP_URL: 'https://test.example.com/' });
    expect(env.APP_URL).toBe('https://test.example.com');
  });

  it('uses the default sender when EMAIL_FROM is left empty', () => {
    const env = validateEnv({ MONGODB_URI: 'mongodb://x', EMAIL_FROM: '' });
    expect(env.EMAIL_FROM).toBe('aiainai <hello@aiainai.ai>');
  });

  it('fails clearly when the database URI is missing', () => {
    expect(() => validateEnv({})).toThrow(/MONGODB_URI/);
  });
});
