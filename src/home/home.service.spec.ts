import { Types, type Model } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { DocumentRecordSchema } from '../database/schemas/document.schema.js';
import { ImageGenerationSchema } from '../database/schemas/image.schema.js';
import { MemoryModel } from '../testing/memory-model.js';
import { MemorySchema } from '../database/schemas/memory.schema.js';
import { ConnectionSchema } from '../database/schemas/connection.schema.js';
import { JackActionSchema } from '../database/schemas/jack-action.schema.js';
import { HomeService } from './home.service.js';

const m = <T>(x: MemoryModel) => x as unknown as Model<T>;

describe('Jack’s home', () => {
  it('lists what needs the person and what is running, only for the given space', async () => {
    const docs = new MemoryModel('DocumentRecord', DocumentRecordSchema);
    const images = new MemoryModel('ImageGeneration', ImageGenerationSchema);
    const svc = new HomeService(
      m(docs),
      m(images),
      m(new MemoryModel('Memory', MemorySchema)),
      m(new MemoryModel('Connection', ConnectionSchema)),
      m(new MemoryModel('JackAction', JackActionSchema)),
    );
    const biz = new Types.ObjectId();
    const other = new Types.ObjectId();

    await docs.create({ workspaceId: biz, ownerUserId: 'u', title: 'Sales report', status: 'writing' });
    await images.create({
      workspaceId: biz,
      userId: 'u',
      prompt: 'A launch poster',
      model: 'auto',
      count: 2,
      ratio: '1:1',
    });
    await docs.create({ workspaceId: other, ownerUserId: 'u', title: 'Not this space', status: 'writing' });

    const home = await svc.summary(biz, 'business');
    expect(home.needsYou).toEqual([]);
    expect(home.inProgressCount).toBe(2);
    expect(home.inProgress.map((i) => i.kind).sort()).toEqual(['doc', 'image']);
    expect(home.inProgress.find((i) => i.kind === 'image')!.detail).toBe('Making 2 images in AI Image');
    expect(home.inProgress.some((i) => i.title === 'Not this space')).toBe(false);

    const empty = await svc.summary(other, 'personal');
    expect(empty.needsYou).toEqual([]);
    expect(empty.suggestions.length).toBe(3);
  });
});
