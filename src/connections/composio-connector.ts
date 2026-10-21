import { Logger } from '@nestjs/common';
import type { ConnectionApp } from '../database/schemas/connection.schema.js';
import type { CalendarEvent, DriveFile, EmailSummary, SlackMessage } from './connections.logic.js';
import { SlackChannelNotFound, type Account, type Connector, type StartResult } from './connector.js';

const BASE = 'https://backend.composio.dev/api/v3';

/**
 * Composio (composio.dev) handles the Google sign-in, tokens and API calls. Each app needs an
 * "auth config" made once in the Composio dashboard; its id goes in the server settings.
 * Tool names and fields follow Composio's v3 REST API; check them on the first run with a live key.
 */
export class ComposioConnector implements Connector {
  readonly live = true;
  private readonly logger = new Logger(ComposioConnector.name);

  constructor(
    private readonly apiKey: string,
    private readonly authConfigs: Partial<Record<ConnectionApp, string>>,
  ) {}

  isAvailable(app: ConnectionApp): boolean {
    return !!this.authConfigs[app];
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as T & { error?: { message?: string } };
    if (!res.ok) {
      this.logger.warn({ status: res.status, path, error: json?.error }, 'Composio call failed');
      throw new Error(json?.error?.message ?? `Composio ${method} ${path} failed (${res.status})`);
    }
    return json;
  }

  async start(app: ConnectionApp, input: { userRef: string; callbackUrl: string }): Promise<StartResult> {
    const r = await this.call<{ redirect_url: string; connected_account_id: string }>(
      'POST',
      '/connected_accounts/link',
      {
        auth_config_id: this.authConfigs[app],
        user_id: input.userRef,
        callback_url: input.callbackUrl,
      },
    );
    return { ref: r.connected_account_id, redirectUrl: r.redirect_url, connected: false };
  }

  async status(ref: string) {
    const r = await this.call<{ status?: string; alias?: string | null }>(
      'GET',
      `/connected_accounts/${encodeURIComponent(ref)}`,
    );
    const s = (r.status ?? '').toUpperCase();
    const status =
      s === 'ACTIVE' ? 'connected' : s === 'INITIALIZING' || s === 'INITIATED' ? 'pending' : 'failed';
    return { status: status as 'pending' | 'connected' | 'failed', account: r.alias ?? undefined };
  }

  async disconnect(ref: string): Promise<void> {
    await this.call('DELETE', `/connected_accounts/${encodeURIComponent(ref)}`);
  }

  private async execute(tool: string, ref: Account, args: Record<string, unknown>): Promise<unknown> {
    const r = await this.call<{ data: unknown; successful: boolean; error: string | null }>(
      'POST',
      `/tools/execute/${tool}`,
      { connected_account_id: ref.ref, user_id: ref.userRef, arguments: args },
    );
    if (!r.successful) throw new Error(r.error ?? `${tool} failed`);
    return r.data;
  }

  async events(ref: Account, range: { from: Date; to: Date }): Promise<CalendarEvent[]> {
    const data = await this.execute('GOOGLECALENDAR_EVENTS_LIST', ref, {
      calendarId: 'primary',
      timeMin: range.from.toISOString(),
      timeMax: range.to.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 25,
    });
    return findArray(data, ['items', 'events']).map((e) => {
      const x = e as Record<string, unknown>;
      const start = (x.start as { dateTime?: string; date?: string } | undefined) ?? {};
      const end = (x.end as { dateTime?: string; date?: string } | undefined) ?? {};
      return {
        title: String(x.summary ?? '(no title)'),
        start: start.dateTime ?? start.date ?? '',
        end: end.dateTime ?? end.date,
        where: x.location ? String(x.location) : undefined,
      };
    });
  }

  async sendEmail(ref: Account, email: { to: string; subject: string; body: string }): Promise<void> {
    await this.execute(COMPOSIO_TOOLS.send, ref, {
      recipient_email: email.to,
      subject: email.subject,
      body: email.body,
    });
  }

  async createDraft(ref: Account, email: { to: string; subject: string; body: string }): Promise<void> {
    await this.execute(COMPOSIO_TOOLS.draft, ref, {
      recipient_email: email.to,
      subject: email.subject,
      body: email.body,
    });
  }

  async createEvent(ref: Account, event: { title: string; start: string; minutes: number }): Promise<void> {
    await this.execute(COMPOSIO_TOOLS.event, ref, {
      summary: event.title,
      start_datetime: event.start,
      event_duration_hour: Math.floor(event.minutes / 60),
      event_duration_minutes: event.minutes % 60,
    });
  }

  async driveSearch(ref: Account, query: string, max: number): Promise<DriveFile[]> {
    const data = await this.execute(COMPOSIO_TOOLS.driveFind, ref, {
      q: driveQuery(query),
      pageSize: max,
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)',
      ...(query.trim() ? {} : { orderBy: 'modifiedTime desc' }),
    });
    return findArray(data, ['files'])
      .map((f) => f as Record<string, unknown>)
      .filter((f) => typeof f.id === 'string')
      .slice(0, max)
      .map((f) => ({
        id: String(f.id),
        name: String(f.name ?? 'Untitled'),
        mimeType: String(f.mimeType ?? ''),
        modified: f.modifiedTime ? String(f.modifiedTime) : undefined,
        link: f.webViewLink ? String(f.webViewLink) : undefined,
      }));
  }

  async driveDownload(ref: Account, file: DriveFile) {
    const exportAs = EXPORT_AS[file.mimeType];
    const data = await this.execute(COMPOSIO_TOOLS.driveDownload, ref, {
      fileId: file.id,
      ...(exportAs && { mime_type: exportAs }),
    });
    const url = findUrl(data);
    if (!url) throw new Error('Drive download returned no file');
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Drive file download failed (${res.status})`);
    const size = Number(res.headers.get('content-length') ?? 0);
    if (size > MAX_DRIVE_BYTES) throw new Error('Drive file too large');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_DRIVE_BYTES) throw new Error('Drive file too large');
    const type = exportAs ?? res.headers.get('content-type')?.split(';')[0] ?? file.mimeType;
    const ext = exportAs === 'text/csv' ? '.csv' : exportAs ? '.txt' : '';
    return { bytes, type, name: file.name + ext };
  }

  /** The person's channels (id and name), members only. */
  private async channels(ref: Account): Promise<{ id: string; name: string }[]> {
    const data = await this.execute(COMPOSIO_TOOLS.slackChannels, ref, {
      limit: 200,
      exclude_archived: true,
      types: 'public_channel,private_channel',
    });
    return findArray(data, ['channels'])
      .map((c) => c as Record<string, unknown>)
      .filter((c) => typeof c.id === 'string' && c.is_member !== false)
      .map((c) => ({ id: String(c.id), name: String(c.name ?? c.id) }));
  }

  private async channelId(ref: Account, name: string): Promise<{ id: string; name: string }> {
    const want = name.replace(/^#/, '').trim().toLowerCase();
    const found = (await this.channels(ref)).find((c) => c.name.toLowerCase() === want || c.id === name);
    if (!found) throw new SlackChannelNotFound(want);
    return found;
  }

  async slackMessages(ref: Account, opts: { channel?: string; max: number; days: number }) {
    const chans = opts.channel
      ? [await this.channelId(ref, opts.channel)]
      : (await this.channels(ref)).slice(0, 5);
    const oldest = String(Math.floor((Date.now() - opts.days * 86_400_000) / 1000));
    const all: SlackMessage[] = [];
    for (const c of chans) {
      const data = await this.execute(COMPOSIO_TOOLS.slackHistory, ref, {
        channel: c.id,
        limit: opts.max,
        oldest,
      });
      for (const m of findArray(data, ['messages'])) {
        const x = m as Record<string, unknown>;
        if (!x.text || x.subtype === 'channel_join') continue;
        const profile = (x.user_profile ?? {}) as Record<string, unknown>;
        all.push({
          channel: c.name,
          from: String(profile.real_name ?? profile.display_name ?? x.username ?? x.user ?? 'Someone'),
          text: String(x.text).replace(/\s+/g, ' '),
          at: x.ts ? new Date(Number(x.ts) * 1000).toISOString() : undefined,
        });
      }
    }
    return all.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? '')).slice(0, opts.max * 2);
  }

  async slackSend(ref: Account, message: { channel: string; text: string }): Promise<void> {
    const c = await this.channelId(ref, message.channel);
    await this.execute(COMPOSIO_TOOLS.slackSend, ref, { channel: c.id, text: message.text });
  }

  async emails(ref: Account, opts: { max: number; days: number }): Promise<EmailSummary[]> {
    const data = await this.execute('GMAIL_FETCH_EMAILS', ref, {
      max_results: opts.max,
      query: `in:inbox newer_than:${opts.days}d`,
      include_payload: false,
    });
    return findArray(data, ['messages', 'emails']).map((e) => {
      const x = e as Record<string, unknown>;
      return {
        from: String(x.sender ?? x.from ?? 'Unknown sender'),
        subject: String(x.subject ?? '(no subject)'),
        preview: previewText(x.preview ?? x.snippet ?? x.messageText)
          .replace(/\s+/g, ' ')
          .slice(0, 300),
        at: x.messageTimestamp ? String(x.messageTimestamp) : undefined,
      };
    });
  }
}

/** Tool names and arguments follow Composio's toolkits (check on first live run). */
export const COMPOSIO_TOOLS = {
  send: 'GMAIL_SEND_EMAIL',
  draft: 'GMAIL_CREATE_EMAIL_DRAFT',
  event: 'GOOGLECALENDAR_CREATE_EVENT',
  driveFind: 'GOOGLEDRIVE_FIND_FILE',
  driveDownload: 'GOOGLEDRIVE_DOWNLOAD_FILE',
  slackChannels: 'SLACK_LIST_ALL_CHANNELS',
  slackHistory: 'SLACK_FETCH_CONVERSATION_HISTORY',
  slackSend: 'SLACK_SEND_MESSAGE',
} as const;

/** Google's own formats can't be downloaded as they are; export them as something readable. */
export const EXPORT_AS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Largest Drive file Jack reads (bigger files are listed, not read). */
export const MAX_DRIVE_BYTES = 10 * 1024 * 1024;

/** Words for Drive's full-text search, with quotes and backslashes made safe. */
export function driveQuery(words: string): string {
  const safe = words.replace(/[\\']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const base = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
  return safe ? `${base} and fullText contains '${safe}'` : base;
}

/** The first web link in a tool result (Composio hands downloads over as a short-lived link). */
export function findUrl(data: unknown, depth = 0): string | null {
  if (typeof data === 'string') return data.startsWith('https://') ? data : null;
  if (!data || typeof data !== 'object' || depth > 4) return null;
  const o = data as Record<string, unknown>;
  for (const k of ['s3url', 's3_url', 'url', 'download_url', 'downloaded_file_content'])
    if (k in o) {
      const u = findUrl(o[k], depth + 1);
      if (u) return u;
    }
  for (const v of Object.values(o)) {
    const u = findUrl(v, depth + 1);
    if (u) return u;
  }
  return null;
}

/** Gmail's preview comes as text or as { body, subject }; keep just the words. */
export function previewText(p: unknown): string {
  if (typeof p === 'string') return p;
  if (p && typeof p === 'object') {
    const o = p as Record<string, unknown>;
    return typeof o.body === 'string' ? o.body : '';
  }
  return '';
}

/** Composio wraps results differently per tool; find the list wherever it is. */
function findArray(data: unknown, keys: string[], depth = 0): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object' || depth > 3) return [];
  const o = data as Record<string, unknown>;
  for (const k of keys) if (Array.isArray(o[k])) return o[k] as unknown[];
  for (const v of Object.values(o)) {
    const found = findArray(v, keys, depth + 1);
    if (found.length) return found;
  }
  return [];
}
