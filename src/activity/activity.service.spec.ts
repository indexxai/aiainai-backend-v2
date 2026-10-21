import { Types, type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { ChatSchema } from '../database/schemas/chat.schema.js';
import { DocumentRecordSchema } from '../database/schemas/document.schema.js';
import { ImageGenerationSchema } from '../database/schemas/image.schema.js';
import { JackActionSchema } from '../database/schemas/jack-action.schema.js';
import { MemoryModel } from '../testing/memory-model.js';
import type { SpaceScope } from '../workspaces/workspaces.service.js';
import { ActivityService } from './activity.service.js';

const m = <T>(x: MemoryModel) => x as unknown as Model<T>;

async function setup() {
  const store = {
    chats: new MemoryModel('Chat', ChatSchema),
    docs: new MemoryModel('DocumentRecord', DocumentRecordSchema),
    images: new MemoryModel('ImageGeneration', ImageGenerationSchema),
  };
  const personal = new Types.ObjectId();
  const business = new Types.ObjectId();
  const svc = new ActivityService(
    m(store.chats),
    m(store.docs),
    m(store.images),
    m(new MemoryModel('JackAction', JackActionSchema)),
  );
  const scope = (id: Types.ObjectId, space: 'personal' | 'business') =>
    ({
      space,
      workspace: { _id: id, ownerUserId: 'u', plan: 'free' },
      billing: { _id: personal, plan: 'free' },
    }) as unknown as SpaceScope;
  return {
    store,
    svc,
    personal,
    business,
    spaces: [scope(personal, 'personal'), scope(business, 'business')],
  };
}

describe('Activity', () => {
  it('merges both spaces newest first, says who did what, and filters', async () => {
    const { store, svc, personal, business, spaces } = await setup();
    const at = (h: number) => new Date(Date.UTC(2026, 9, 8, h));
    await store.chats.create({
      workspaceId: personal,
      createdBy: 'u',
      title: 'Flights to Dubai',
      messageCount: 2,
      lastMessageAt: at(9),
    });
    await store.docs.create({
      workspaceId: personal,
      createdBy: 'u',
      title: 'Trip checklist — Dubai',
      status: 'ready',
      madeBy: 'jack',
      createdAt: at(10),
    });
    await store.images.create({
      workspaceId: business,
      createdBy: 'u',
      prompt: 'Launch poster',
      title: 'Launch poster',
      count: 2,
      ratio: '1:1',
      requestedModel: 'auto',
      status: 'done',
      createdAt: at(11),
    });
    const all = await svc.activity(spaces, { space: 'all', kind: 'all' }, at(20));
    expect(all.items.map((i) => `${i.whoName} ${i.text}`)).toEqual([
      'You made 2 images: “Launch poster”',
      'Jack of all trades made the document “Trip checklist — Dubai”',
      'You talked with Jack: “Flights to Dubai”',
    ]);
    expect(all.items[0]).toMatchObject({ space: 'business', href: expect.stringMatching(/^\/image\//) });
    expect(all.items[1]!.detail).toBe('Personal · AI Docs · Ready');
    expect(all.comingUp).toEqual([]);

    const personalOnly = await svc.activity(spaces, { space: 'personal', kind: 'all' }, at(20));
    expect(personalOnly.items.map((i) => i.kind)).toEqual(['doc', 'conversation']);
    const docsOnly = await svc.activity(spaces, { space: 'all', kind: 'doc' }, at(20));
    expect(docsOnly.items.map((i) => i.kind)).toEqual(['doc']);
    const later = await svc.activity(spaces, { space: 'all', kind: 'all' }, new Date(Date.UTC(2026, 11, 20)));
    expect(later.items).toEqual([]); // older than 30 days
  });

  it('lists Jack’s approvals (none without the actions service)', async () => {
    const { svc, spaces } = await setup();
    expect(await svc.allApprovals(spaces)).toEqual({ jackPending: [], jackDecided: [] });
  });
});
