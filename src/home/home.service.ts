import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { DocumentRecord } from '../database/schemas/document.schema.js';
import { ImageGeneration } from '../database/schemas/image.schema.js';
import { Memory } from '../database/schemas/memory.schema.js';
import { Connection } from '../database/schemas/connection.schema.js';
import { appName } from '../connections/connections.logic.js';
import { JackAction } from '../database/schemas/jack-action.schema.js';
import type { SpaceKind } from '../database/schemas/workspace.schema.js';
import { scoped } from '../database/scoped.js';
import type { HomeDto, HomeItemDto } from './home.dto.js';
import { plural, shorten, STARTER_SUGGESTIONS } from './home.logic.js';

const SHOWN = 4;

/** Jack's home: what needs the person, what's running, and ideas — all within one space. */
@Injectable()
export class HomeService {
  constructor(
    @InjectModel(DocumentRecord.name) private readonly docs: Model<DocumentRecord>,
    @InjectModel(ImageGeneration.name) private readonly images: Model<ImageGeneration>,
    @InjectModel(Memory.name) private readonly memories: Model<Memory>,
    @InjectModel(Connection.name) private readonly connections: Model<Connection>,
    @InjectModel(JackAction.name) private readonly jackActions: Model<JackAction>,
  ) {}

  async summary(workspaceId: Types.ObjectId, space: SpaceKind, jack = 'Jack'): Promise<HomeDto> {
    const [docs, images, memoryCount, apps, jackActions] = await Promise.all([
      this.docs
        .find(scoped<DocumentRecord>(workspaceId, { status: 'writing' }))
        .sort({ updatedAt: -1 })
        .limit(20)
        .lean(),
      this.images
        .find(scoped<ImageGeneration>(workspaceId, { status: 'generating' }))
        .sort({ createdAt: -1 })
        .limit(20)
        .lean(),
      this.memories.countDocuments({ workspaceId }),
      this.connections
        .find({ workspaceId, status: 'connected' }, { app: 1 })
        .lean<Pick<Connection, 'app'>[]>(),
      this.jackActions
        .find({ workspaceId, status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean<(JackAction & { _id: Types.ObjectId })[]>(),
    ]);

    const needsYou: HomeItemDto[] = jackActions.map((a) => ({
      kind: 'action' as const,
      id: String(a._id),
      title: shorten(a.title),
      detail:
        a.kind === 'purchase'
          ? `${jack} · a purchase`
          : a.kind === 'send_email'
            ? `${jack} · an email to send`
            : a.kind === 'slack_message'
              ? `${jack} · a Slack message to post`
              : `${jack} · a calendar event`,
      href: '/approvals',
    }));

    const inProgress: (HomeItemDto & { at: number })[] = [
      ...docs.map((d) => ({
        kind: 'doc' as const,
        id: String(d._id),
        title: shorten(d.title),
        detail: 'Writing in AI Docs',
        href: `/docs/${String(d._id)}`,
        at: time(d),
      })),
      ...images.map((g) => ({
        kind: 'image' as const,
        id: String(g._id),
        title: shorten(g.title || g.prompt),
        detail: `Making ${plural(g.count, 'image')} in AI Image`,
        href: `/image/${String(g._id)}`,
        at: time(g),
      })),
    ].sort((a, b) => b.at - a.at);

    return {
      space,
      needsYou: needsYou.slice(0, SHOWN),
      needsYouCount: needsYou.length,
      inProgress: inProgress.slice(0, SHOWN).map(({ at: _at, ...item }) => item),
      inProgressCount: inProgress.length,
      suggestions: STARTER_SUGGESTIONS[space],
      memoryCount,
      apps: apps.map((a) => appName(a.app)),
    };
  }
}

const time = (x: unknown) => {
  const d = (x as { updatedAt?: Date; createdAt?: Date }).updatedAt ?? (x as { createdAt?: Date }).createdAt;
  return d ? new Date(d).getTime() : 0;
};
