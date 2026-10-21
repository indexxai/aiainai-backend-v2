import type { Types } from 'mongoose';
import type { Chat } from '../database/schemas/chat.schema.js';
import { AUTO } from '../models/models.logic.js';
import type { ChatSummaryDto } from './chats.dto.js';

export type ChatLean = Chat & { _id: Types.ObjectId };

export function toSummary(c: ChatLean): ChatSummaryDto {
  return {
    id: c._id.toHexString(),
    title: c.title,
    preview: c.preview ?? '',
    pinned: !!c.pinnedAt,
    messageCount: c.messageCount ?? 0,
    lastMessageAt: new Date(c.lastMessageAt).toISOString(),
    model: c.model ?? AUTO,
    projectId: c.projectId ? c.projectId.toHexString() : null,
    appsOff: c.appsOff ?? [],
  };
}
