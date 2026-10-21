import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposioConnector, driveQuery, findUrl, previewText } from './composio-connector.js';

describe('Composio helpers', () => {
  it('builds a safe Drive search', () => {
    expect(driveQuery('Q3 sales')).toBe(
      "trashed = false and mimeType != 'application/vnd.google-apps.folder' and fullText contains 'Q3 sales'",
    );
    expect(driveQuery("it's a\\ test")).toContain("fullText contains 'it s a test'");
    expect(driveQuery('  ')).toBe("trashed = false and mimeType != 'application/vnd.google-apps.folder'");
  });

  it('finds the download link wherever the tool puts it', () => {
    expect(
      findUrl({ downloaded_file_content: { s3url: 'https://s3.example/f?sig=1', mimetype: 'text/plain' } }),
    ).toBe('https://s3.example/f?sig=1');
    expect(findUrl({ data: { file: { url: 'https://x.example/a' } } })).toBe('https://x.example/a');
    expect(findUrl({ url: 'http://insecure.example' })).toBeNull();
    expect(findUrl({ nothing: 1 })).toBeNull();
  });
});

describe('previewText', () => {
  it('reads Gmail previews given as text or as { body, subject }', () => {
    expect(previewText('Hi there')).toBe('Hi there');
    expect(previewText({ body: 'Your order shipped', subject: 'Order' })).toBe('Your order shipped');
    expect(previewText(undefined)).toBe('');
    expect(previewText({ subject: 'only a subject' })).toBe('');
  });
});

describe('Composio tool calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the user id with the connected account (Composio refuses the call without it)', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            successful: true,
            error: null,
            data: {
              messages: [
                {
                  sender: 'Sara <sara@example.com>',
                  subject: 'Lunch',
                  preview: { body: 'Free on Friday?', subject: 'Lunch' },
                  messageTimestamp: '2026-10-19T09:00:00Z',
                },
              ],
            },
          }),
          { status: 200 },
        );
      }),
    );
    const c = new ComposioConnector('ak_test', { gmail: 'ac_test' });
    const emails = await c.emails({ ref: 'ca_123', userRef: 'ws_abc' }, { max: 5, days: 7 });
    expect(bodies[0]).toMatchObject({ connected_account_id: 'ca_123', user_id: 'ws_abc' });
    expect(emails).toEqual([
      {
        from: 'Sara <sara@example.com>',
        subject: 'Lunch',
        preview: 'Free on Friday?',
        at: '2026-10-19T09:00:00Z',
      },
    ]);
  });
});
