import type { ConnectionApp } from '../database/schemas/connection.schema.js';
import type { CalendarEvent, DriveFile, EmailSummary, SlackMessage } from './connections.logic.js';

export interface StartResult {
  /** The connector service's id for this account. */
  ref: string;
  /** Where to send the person to sign in (null when connected straight away). */
  redirectUrl: string | null;
  connected: boolean;
  account?: string;
}

/**
 * A connected account as the connector needs it: the provider's id for it, and the user id it was
 * connected under (Composio asks for both on every tool call).
 */
export interface Account {
  ref: string;
  userRef: string;
}

/** Signing in to apps and reading from them, through a connector service (or the stand-in). */
export interface Connector {
  /** False for the stand-in used without a key (local development and tests). */
  readonly live: boolean;
  isAvailable(app: ConnectionApp): boolean;
  start(
    app: ConnectionApp,
    input: { userRef: string; callbackUrl: string; email: string },
  ): Promise<StartResult>;
  status(ref: string): Promise<{ status: 'pending' | 'connected' | 'failed'; account?: string }>;
  disconnect(ref: string): Promise<void>;
  events(acct: Account, range: { from: Date; to: Date }): Promise<CalendarEvent[]>;
  emails(acct: Account, opts: { max: number; days: number }): Promise<EmailSummary[]>;
  sendEmail(acct: Account, email: { to: string; subject: string; body: string }): Promise<void>;
  createDraft(acct: Account, email: { to: string; subject: string; body: string }): Promise<void>;
  createEvent(acct: Account, event: { title: string; start: string; minutes: number }): Promise<void>;
  /** Google Drive: files matching the words (newest first). */
  driveSearch(acct: Account, query: string, max: number): Promise<DriveFile[]>;
  /** The file's bytes (Google Docs, Sheets and Slides exported as text, CSV or PDF). */
  driveDownload(acct: Account, file: DriveFile): Promise<{ bytes: Buffer; type: string; name: string }>;
  /** Slack: recent messages in one channel, or across the person's channels when none is named. */
  slackMessages(
    acct: Account,
    opts: { channel?: string; max: number; days: number },
  ): Promise<SlackMessage[]>;
  /** Post a message as the person. The channel is a name (no #). */
  slackSend(acct: Account, message: { channel: string; text: string }): Promise<void>;
}

export const CONNECTOR = Symbol('Connector');

/** A Slack channel the person isn't in (or that doesn't exist). */
export class SlackChannelNotFound extends Error {
  constructor(readonly channel: string) {
    super(`No Slack channel called #${channel}`);
  }
}
