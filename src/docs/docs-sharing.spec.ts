import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Types, type Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import type { CreditsService } from '../credits/credits.service.js';
import { DocumentRecordSchema, type DocumentRecord } from '../database/schemas/document.schema.js';
import { UsageEventSchema, type UsageEvent } from '../database/schemas/usage-event.schema.js';
import type { EmailService, OutgoingEmail } from '../email/email.service.js';
import { GatewayService } from '../gateway/gateway.service.js';
import { FakeCredits } from '../testing/fake-credits.js';
import { modelsService, seedRows } from '../testing/fake-models.js';
import { MemoryModel } from '../testing/memory-model.js';
import { DocsSharingService } from './docs-sharing.service.js';
import { DocsService, type Actor } from './docs.service.js';

Logger.overrideLogger(false);

function setup() {
  const models = modelsService(seedRows(), { AI_DEMO: true });
  const gateway = new GatewayService(
    models,
    new FakeCredits(100) as unknown as CreditsService,
    new MemoryModel('UsageEvent', UsageEventSchema) as unknown as Model<UsageEvent>,
  );
  const store = new MemoryModel('DocumentRecord', DocumentRecordSchema);
  const docsModel = store as unknown as Model<DocumentRecord>;
  const sent: OutgoingEmail[] = [];
  const email = { send: vi.fn(async (m: OutgoingEmail) => void sent.push(m)) } as unknown as EmailService;
  const config = { get: () => 'https://app.aiainai.ai/' } as unknown as ConfigService<never, true>;
  const sharing = new DocsSharingService(docsModel, email, config as never);
  const docs = new DocsService(docsModel, gateway, models);
  const owner: Actor & { name: string } = {
    userId: 'u1',
    workspaceId: new Types.ObjectId(),
    plan: 'free',
    email: 'owner@example.com',
    name: 'Sara Khan',
  };
  const guest: Actor = {
    userId: 'u2',
    workspaceId: new Types.ObjectId(),
    plan: 'free',
    email: 'Guest@Example.com',
  };
  return { sharing, docs, owner, guest, sent, store };
}

describe('DocsSharingService', () => {
  it('turns a public link on, serves it read-only, resets and turns it off', async () => {
    const { sharing, docs, owner } = setup();
    const doc = await docs.create(owner, { title: 'Plan', type: 'plan', sections: [] });
    expect((await sharing.get(owner, doc.id)).url).toBeNull();

    const on = await sharing.update(owner, doc.id, { linkAccess: 'view' });
    expect(on.url).toMatch(/^https:\/\/app\.aiainai\.ai\/s\/[\w-]{24}$/);
    const token = on.url!.split('/s/')[1]!;
    const pub = await sharing.publicDoc(token);
    expect(pub).toMatchObject({ title: 'Plan', type: 'plan' });
    expect(pub).not.toHaveProperty('brief');

    const reset = await sharing.update(owner, doc.id, { resetLink: true });
    expect(reset.url).not.toBe(on.url);
    await expect(sharing.publicDoc(token)).rejects.toMatchObject({ code: 'not_found' });

    const off = await sharing.update(owner, doc.id, { linkAccess: 'off' });
    expect(off.url).toBeNull();
    await expect(sharing.publicDoc(reset.url!.split('/s/')[1]!)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('invites people by email; they see it read-only under Shared with me', async () => {
    const { sharing, docs, owner, guest, sent } = setup();
    const doc = await docs.create(owner, { title: 'Proposal', type: 'proposal', sections: [] });
    const s = await sharing.invite(owner, doc.id, {
      emails: ['guest@example.com', 'GUEST@example.com', 'owner@example.com'],
      message: 'Have a look',
    });
    // Duplicates and the owner are skipped; emails are compared case-insensitively.
    expect(s.invites.map((i) => i.email)).toEqual(['guest@example.com']);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe('Sara Khan shared “Proposal” with you');
    expect(sent[0]!.text).toContain(`https://app.aiainai.ai/docs/${doc.id}`);

    const shared = await docs.list(guest, { scope: 'shared' });
    expect(shared.items).toMatchObject([{ id: doc.id, sharedBy: 'Sara Khan' }]);
    expect((await docs.list(guest, {})).items).toEqual([]);
    const mine = await docs.create(guest, { title: 'Mine', type: 'plan', sections: [] });
    expect((await docs.list(guest, { scope: 'all' })).items.map((d) => d.id).sort()).toEqual(
      [doc.id, mine.id].sort(),
    );
    expect((await docs.list(owner, {})).items[0]).toMatchObject({ sharedWith: 1, sharedBy: null });
    const view = await docs.get(guest, doc.id);
    expect(view.access).toBe('view');
    expect(view.sharedBy).toBe('Sara Khan');
    expect(view.credits).toBe(0);
    // Read-only: editing goes through the owner's workspace only.
    await expect(docs.update(guest, doc.id, { title: 'Hacked' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(sharing.get(guest, doc.id)).rejects.toMatchObject({ code: 'not_found' });

    await sharing.uninvite(owner, doc.id, 'Guest@example.com');
    await expect(docs.get(guest, doc.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await docs.get(owner, doc.id)).sharedWith).toBe(0);
  });

  it('does not show drafts by link', async () => {
    const { sharing, docs, owner } = setup();
    const doc = await docs.create(owner, {
      title: 'Draft',
      type: 'plan',
      sections: [{ heading: 'Goal', note: '' }],
    });
    const on = await sharing.update(owner, doc.id, { linkAccess: 'view' });
    await expect(sharing.publicDoc(on.url!.split('/s/')[1]!)).rejects.toMatchObject({ code: 'not_found' });
  });
});
