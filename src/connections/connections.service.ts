import { HttpStatus, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model, Types } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { Connection, type AccessLevel, type ConnectionApp } from '../database/schemas/connection.schema.js';
import type { SpaceKind } from '../database/schemas/workspace.schema.js';
import { detect, extract, UnsupportedFile } from '../files/extract.js';
import {
  CATALOG,
  type CalendarEvent,
  type DriveFile,
  type EmailSummary,
  type SlackMessage,
} from './connections.logic.js';
import type { ConnectionDto, ConnectionsDto } from './connections.dto.js';
import { CONNECTOR, SlackChannelNotFound, type Account, type Connector } from './connector.js';

export interface ConnectionsActor {
  userId: string;
  workspaceId: Types.ObjectId;
  email: string;
  space: SpaceKind;
}

type Lean = Connection & { _id: Types.ObjectId };

const notConnected = (app: string) =>
  new AppError('conflict', `${app} isn’t connected in this space.`, HttpStatus.CONFLICT);

/** Apps connected per space, how much Jack may do in each, and reading from them for Jack. */
@Injectable()
export class ConnectionsService {
  private readonly logger = new Logger(ConnectionsService.name);

  constructor(
    @InjectModel(Connection.name) private readonly connections: Model<Connection>,
    @Inject(CONNECTOR) private readonly connector: Connector,
    @Optional() private readonly config?: ConfigService<Env, true>,
  ) {}

  /** Jack's browser: a hosted browser with a key, sample sites in development, off otherwise. */
  private browserMode(): 'live' | 'sample' | 'off' {
    const get = <K extends keyof Env>(k: K) => this.config?.get(k, { infer: true });
    if (get('BROWSERBASE_API_KEY') && get('BROWSERBASE_PROJECT_ID')) return 'live';
    return get('NODE_ENV') === 'production' ? 'off' : 'sample';
  }

  async list(actor: ConnectionsActor): Promise<ConnectionsDto> {
    const rows = await this.connections.find({ workspaceId: actor.workspaceId }).lean<Lean[]>();
    const byApp = new Map(rows.map((r) => [r.app as string, r]));
    return {
      demo: !this.connector.live,
      browser: this.browserMode(),
      apps: CATALOG.filter((c) => c.spaces.includes(actor.space)).map((c) => {
        const row = byApp.get(c.id);
        const available = c.available && this.connector.isAvailable(c.id as ConnectionApp);
        return {
          id: c.id,
          name: c.name,
          icon: c.icon,
          what: c.what,
          available,
          status: row ? row.status : available ? 'not_connected' : 'coming',
          level: row?.level ?? c.defaultLevel,
          levels: c.levels,
          account: row?.account || null,
          connectedAt: row?.connectedAt ? new Date(row.connectedAt).toISOString() : null,
        } satisfies ConnectionDto;
      }),
    };
  }

  /** Start connecting: returns the app's sign-in page, or connects at once (stand-in). */
  async connect(
    actor: ConnectionsActor,
    app: ConnectionApp,
    callbackUrl: string,
  ): Promise<{ redirectUrl: string | null; connections: ConnectionsDto }> {
    const item = CATALOG.find((c) => c.id === app);
    if (!item?.available || !this.connector.isAvailable(app))
      throw new AppError('service_unavailable', `${item?.name ?? app} can’t be connected yet.`, 503);
    const started = await this.connector.start(app, {
      userRef: actor.workspaceId.toHexString(),
      callbackUrl,
      email: actor.email,
    });
    await this.connections.updateOne(
      { workspaceId: actor.workspaceId, app },
      {
        $set: {
          status: started.connected ? 'connected' : 'pending',
          providerRef: started.ref,
          account: started.account ?? '',
          connectedAt: started.connected ? new Date() : null,
        },
        $setOnInsert: { createdBy: actor.userId, level: item.defaultLevel },
      },
      { upsert: true },
    );
    return { redirectUrl: started.redirectUrl, connections: await this.list(actor) };
  }

  /** After the sign-in page sends the person back: ask the connector whether it worked. */
  async refresh(actor: ConnectionsActor, app: ConnectionApp): Promise<ConnectionsDto> {
    const row = await this.connections.findOne({ workspaceId: actor.workspaceId, app }).lean<Lean>();
    if (row?.providerRef && row.status !== 'connected') {
      try {
        const s = await this.connector.status(row.providerRef);
        await this.connections.updateOne(
          { _id: row._id },
          {
            $set: {
              status: s.status,
              ...(s.account && { account: s.account }),
              ...(s.status === 'connected' && { connectedAt: new Date() }),
            },
          },
        );
      } catch (err) {
        this.logger.warn({ err, app }, 'Checking a connection failed');
      }
    }
    return this.list(actor);
  }

  async setLevel(actor: ConnectionsActor, app: ConnectionApp, level: AccessLevel): Promise<ConnectionsDto> {
    const item = CATALOG.find((c) => c.id === app);
    if (item && !item.levels.includes(level))
      throw new AppError('validation_failed', `${item.name} can’t be set to that level.`, 422);
    const res = await this.connections.updateOne(
      { workspaceId: actor.workspaceId, app },
      { $set: { level } },
    );
    if (!res.matchedCount) throw notConnected(app);
    return this.list(actor);
  }

  async disconnect(actor: ConnectionsActor, app: ConnectionApp): Promise<ConnectionsDto> {
    const row = await this.connections.findOne({ workspaceId: actor.workspaceId, app }).lean<Lean>();
    if (row?.providerRef) {
      try {
        await this.connector.disconnect(row.providerRef);
      } catch (err) {
        // Removed here regardless; the person can also remove access in their Google account.
        this.logger.warn({ err, app }, 'Disconnecting at the connector failed');
      }
    }
    await this.connections.deleteOne({ workspaceId: actor.workspaceId, app });
    return this.list(actor);
  }

  /** Connected apps in a space (for Jack's instructions and his tools). */
  async connected(workspaceId: Types.ObjectId): Promise<Lean[]> {
    return this.connections.find({ workspaceId, status: 'connected' }).lean<Lean[]>();
  }

  async events(workspaceId: Types.ObjectId, days = 7): Promise<CalendarEvent[]> {
    const row = await this.connections
      .findOne({ workspaceId, app: 'google-calendar', status: 'connected' })
      .lean<Lean>();
    if (!row) throw notConnected('Google Calendar');
    const from = new Date();
    return this.connector.events(accountOf(row), { from, to: new Date(from.getTime() + days * 86_400_000) });
  }

  async emails(workspaceId: Types.ObjectId, max = 5): Promise<EmailSummary[]> {
    const row = await this.connections
      .findOne({ workspaceId, app: 'gmail', status: 'connected' })
      .lean<Lean>();
    if (!row) throw notConnected('Gmail');
    return this.connector.emails(accountOf(row), { max, days: 7 });
  }

  /** The connected account for an app, or null. */
  async connection(workspaceId: Types.ObjectId, app: ConnectionApp): Promise<Lean | null> {
    return this.connections.findOne({ workspaceId, app, status: 'connected' }).lean<Lean>();
  }

  async sendEmail(workspaceId: Types.ObjectId, email: { to: string; subject: string; body: string }) {
    const row = await this.connection(workspaceId, 'gmail');
    if (!row) throw notConnected('Gmail');
    await this.connector.sendEmail(accountOf(row), email);
  }

  async createDraft(workspaceId: Types.ObjectId, email: { to: string; subject: string; body: string }) {
    const row = await this.connection(workspaceId, 'gmail');
    if (!row) throw notConnected('Gmail');
    await this.connector.createDraft(accountOf(row), email);
  }

  async createEvent(workspaceId: Types.ObjectId, event: { title: string; start: string; minutes: number }) {
    const row = await this.connection(workspaceId, 'google-calendar');
    if (!row) throw notConnected('Google Calendar');
    await this.connector.createEvent(accountOf(row), event);
  }

  private async need(workspaceId: Types.ObjectId, app: ConnectionApp, name: string) {
    const row = await this.connection(workspaceId, app);
    if (!row) throw notConnected(name);
    return row;
  }

  /**
   * Google Drive for Jack: the files that match, and the text of the best few that are documents
   * he can read (PDF, Word, Excel, Google Docs, Sheets and Slides, text). Never changes anything.
   */
  async driveRead(
    workspaceId: Types.ObjectId,
    query: string,
  ): Promise<{ files: DriveFile[]; read: { name: string; text: string }[]; skipped: string[] }> {
    const row = await this.need(workspaceId, 'google-drive', 'Google Drive');
    const files = await this.connector.driveSearch(accountOf(row), query, DRIVE_LIST);
    const read: { name: string; text: string }[] = [];
    const skipped: string[] = [];
    let budget = DRIVE_TEXT;
    for (const f of files.slice(0, DRIVE_READ)) {
      if (budget < 500) break;
      try {
        const got = await this.connector.driveDownload(accountOf(row), f);
        const { kind, type } = detect(got.name, got.type, got.bytes);
        const out = await extract(kind, type, got.bytes);
        if (!out.text.trim()) {
          skipped.push(f.name);
          continue;
        }
        const text = out.text.slice(0, budget);
        budget -= text.length;
        read.push({ name: f.name, text: text + (text.length < out.text.length ? '\n[…cut short]' : '') });
      } catch (err) {
        if (!(err instanceof UnsupportedFile)) this.logger.warn({ err }, 'Reading a Drive file failed');
        skipped.push(f.name);
      }
    }
    return { files, read, skipped };
  }

  async slackRead(workspaceId: Types.ObjectId, channel?: string): Promise<SlackMessage[]> {
    const row = await this.need(workspaceId, 'slack', 'Slack');
    try {
      return await this.connector.slackMessages(accountOf(row), { channel, max: 15, days: 7 });
    } catch (err) {
      throw slackError(err);
    }
  }

  async slackSend(workspaceId: Types.ObjectId, message: { channel: string; text: string }): Promise<void> {
    const row = await this.need(workspaceId, 'slack', 'Slack');
    try {
      await this.connector.slackSend(accountOf(row), message);
    } catch (err) {
      throw slackError(err);
    }
  }
}

/** Drive: files listed, files read, and the most text read in all. */
const DRIVE_LIST = 8;
const DRIVE_READ = 3;
const DRIVE_TEXT = 40_000;

const slackError = (err: unknown) =>
  err instanceof SlackChannelNotFound
    ? new AppError(
        'not_found',
        `There’s no Slack channel called #${err.channel} that you’re in.`,
        HttpStatus.NOT_FOUND,
      )
    : err;

/** The account as the connector needs it: connections are made under the workspace's id. */
function accountOf(row: { providerRef: string; workspaceId: Types.ObjectId }): Account {
  return { ref: row.providerRef, userRef: row.workspaceId.toHexString() };
}
