import type { ConnectionApp } from '../database/schemas/connection.schema.js';
import type { CalendarEvent, DriveFile, EmailSummary, SlackMessage } from './connections.logic.js';
import { SlackChannelNotFound, type Account, type Connector, type StartResult } from './connector.js';

/**
 * Stand-in connector for local development and tests (no connector key): connecting works at
 * once and the apps return sample events and email. Never used in production.
 */
export class DemoConnector implements Connector {
  readonly live = false;
  private readonly accounts = new Map<string, string>();
  /** What was "sent", drafted or added, for tests. */
  readonly outbox: { kind: 'email' | 'draft' | 'event' | 'slack'; data: unknown }[] = [];

  isAvailable(): boolean {
    return true;
  }

  async start(app: ConnectionApp, input: { email: string }): Promise<StartResult> {
    const ref = `demo-${app}-${Math.random().toString(36).slice(2, 10)}`;
    this.accounts.set(ref, input.email);
    return { ref, redirectUrl: null, connected: true, account: input.email };
  }

  async status(ref: string) {
    return { status: 'connected' as const, account: this.accounts.get(ref) };
  }

  async disconnect(ref: string): Promise<void> {
    this.accounts.delete(ref);
  }

  async events(_acct: Account, range: { from: Date }): Promise<CalendarEvent[]> {
    const day = (n: number, h: number, m = 0) => {
      const d = new Date(range.from);
      d.setDate(d.getDate() + n);
      d.setHours(h, m, 0, 0);
      return d.toISOString();
    };
    return [
      { title: 'Team stand-up', start: day(1, 9, 30), end: day(1, 9, 45), where: 'Google Meet' },
      { title: 'Dentist', start: day(2, 17, 30), end: day(2, 18, 15), where: 'City Dental' },
      { title: 'Lunch with Ali', start: day(3, 13), end: day(3, 14) },
      { title: 'Quarterly review', start: day(5, 11), end: day(5, 12), where: 'Office' },
    ];
  }

  async emails(): Promise<EmailSummary[]> {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    return [
      {
        from: 'Skyline Air',
        subject: 'Your booking is confirmed',
        preview: 'Thank you for booking with us. Your e-ticket is attached.',
        at: ago(3),
      },
      {
        from: 'Sara (FreshCart)',
        subject: 'Order delayed to Saturday',
        preview: 'Sorry — your groceries will arrive on Saturday morning instead.',
        at: ago(20),
      },
      {
        from: 'New lead via website',
        subject: 'Quote for a roof inspection',
        preview: 'Hi, could you come by next week to look at our roof? We are in Model Town.',
        at: ago(30),
      },
    ];
  }

  async sendEmail(_acct: Account, email: { to: string; subject: string; body: string }): Promise<void> {
    this.outbox.push({ kind: 'email', data: email });
  }

  async createDraft(_acct: Account, email: { to: string; subject: string; body: string }): Promise<void> {
    this.outbox.push({ kind: 'draft', data: email });
  }

  async createEvent(_acct: Account, event: { title: string; start: string; minutes: number }): Promise<void> {
    this.outbox.push({ kind: 'event', data: event });
  }

  private readonly files: (DriveFile & { text: string })[] = [
    {
      id: 'demo-file-1',
      name: 'Q3 sales report',
      mimeType: 'application/vnd.google-apps.document',
      text: 'Q3 sales were 128,000 dollars, up 12% on Q2. Roof inspections were the top service.',
    },
    {
      id: 'demo-file-2',
      name: 'Dubai trip budget',
      mimeType: 'application/vnd.google-apps.spreadsheet',
      text: 'Item,Cost\nFlights,650\nHotel (4 nights),720\nFood,300',
    },
    {
      id: 'demo-file-3',
      name: 'Team holiday rota',
      mimeType: 'application/vnd.google-apps.document',
      text: 'Sara is off 3 to 7 March. Ali is off 10 to 14 March.',
    },
  ];

  async driveSearch(_acct: Account, query: string, max: number): Promise<DriveFile[]> {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const hit = (f: { name: string; text: string }) =>
      !words.length || words.some((w) => `${f.name} ${f.text}`.toLowerCase().includes(w));
    const day = new Date(Date.now() - 86_400_000).toISOString();
    return this.files
      .filter(hit)
      .slice(0, max)
      .map(({ text: _text, ...f }) => ({
        ...f,
        modified: day,
        link: `https://drive.google.com/file/d/${f.id}`,
      }));
  }

  async driveDownload(_acct: Account, file: DriveFile) {
    const f = this.files.find((x) => x.id === file.id);
    if (!f) throw new Error('No such demo file');
    const csv = f.mimeType.endsWith('spreadsheet');
    return {
      bytes: Buffer.from(f.text),
      type: csv ? 'text/csv' : 'text/plain',
      name: f.name + (csv ? '.csv' : '.txt'),
    };
  }

  private readonly channelNames = ['general', 'sales', 'random'];

  async slackMessages(_acct: Account, opts: { channel?: string; max: number }): Promise<SlackMessage[]> {
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const want = opts.channel?.replace(/^#/, '').toLowerCase();
    if (want && !this.channelNames.includes(want)) throw new SlackChannelNotFound(want);
    const all: SlackMessage[] = [
      {
        channel: 'sales',
        from: 'Sara',
        text: 'Two new roof inspection leads came in from the website today.',
        at: ago(2),
      },
      { channel: 'general', from: 'Ali', text: 'Reminder: team lunch on Friday at 1pm.', at: ago(5) },
      {
        channel: 'sales',
        from: 'Bilal',
        text: 'Can someone send the Model Town quote by tomorrow?',
        at: ago(26),
      },
    ];
    return all.filter((m) => !want || m.channel === want).slice(0, opts.max);
  }

  async slackSend(_acct: Account, message: { channel: string; text: string }): Promise<void> {
    const want = message.channel.replace(/^#/, '').toLowerCase();
    if (!this.channelNames.includes(want)) throw new SlackChannelNotFound(want);
    this.outbox.push({ kind: 'slack', data: { ...message, channel: want } });
  }
}
