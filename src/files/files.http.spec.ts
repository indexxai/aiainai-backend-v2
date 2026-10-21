import type { INestApplication } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph } from 'docx';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toPdf } from '../docs/export/render.js';
import { GatewayService, type GatewayRequest } from '../gateway/gateway.service.js';
import { createMemoryApp } from '../testing/memory-app.js';

/** Files for Jack over HTTP: upload each kind, read its text, attach to chats, keep spaces apart. */
describe('files over HTTP', () => {
  let app: INestApplication;
  const codes: Record<string, string> = {};
  const origin = { origin: 'http://localhost:3000' };
  const api = () => request(app.getHttpServer());
  const seen: GatewayRequest[] = [];
  let a = '';
  let b = '';

  const signUp = async (email: string) => {
    const password = 'correct-horse-9';
    await api()
      .post('/api/auth/sign-up/email')
      .set(origin)
      .set('x-forwarded-for', email)
      .send({ name: 'F', email, password })
      .expect(200);
    await new Promise((r) => setTimeout(r, 20));
    await api()
      .post('/api/auth/email-otp/verify-email')
      .set(origin)
      .set('x-forwarded-for', email)
      .send({ email, otp: codes[email] })
      .expect(200);
    const res = await api()
      .post('/api/auth/sign-in/email')
      .set(origin)
      .set('x-forwarded-for', email)
      .send({ email, password })
      .expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
  };
  const upload = (cookie: string, name: string, type: string, bytes: Buffer) =>
    api()
      .post(`/api/files?name=${encodeURIComponent(name)}`)
      .set(origin)
      .set('cookie', cookie)
      .set('content-type', type)
      .send(Buffer.from(bytes));
  const sse = (cookie: string, path: string, body: object) =>
    api()
      .post(`/api${path}`)
      .set('cookie', cookie)
      .set(origin)
      .send(body)
      .buffer(true)
      .parse((res, cb) => {
        let d = '';
        res.on('data', (c: Buffer) => (d += c.toString()));
        res.on('end', () => cb(null, d));
      })
      .then((r) =>
        String(r.body)
          .split('\n\n')
          .filter((x) => x.startsWith('event:'))
          .map((x) => {
            const [e, data] = x.split('\n');
            return { event: e!.slice(7), data: JSON.parse(data!.slice(6)) };
          }),
      );

  beforeAll(async () => {
    app = await createMemoryApp({ credits: 100, demoDelayMs: 0, onCode: (e, c) => (codes[e] = c) });
    await app.init();
    // See exactly what the model is given.
    const gw = app.get(GatewayService);
    const original = gw.stream.bind(gw);
    gw.stream = (req: GatewayRequest) => {
      seen.push(req);
      return original(req);
    };
    a = await signUp('files-a@example.com');
    b = await signUp('files-b@example.com');
  });
  afterAll(async () => app?.close());

  it('reads PDF, Word, Excel, CSV and text files', async () => {
    const { buffer: pdf } = await toPdf({
      title: 'Roof quote',
      byline: 'Quote',
      blocks: [{ t: 'p', inl: [{ text: 'Total price is 4,250 dollars.' }] }],
    });
    const docx = await Packer.toBuffer(
      new Document({ sections: [{ children: [new Paragraph('Meeting notes: launch on 3 March.')] }] }),
    );
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    ws.addRow(['Name', 'Budget']);
    ws.addRow(['Sara', 1200]);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());

    const cases: [string, string, Buffer, string, RegExp][] = [
      ['quote.pdf', 'application/pdf', pdf, 'pdf', /4,250 dollars/],
      ['notes.docx', 'application/octet-stream', docx, 'word', /launch on 3 March/],
      [
        'leads.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xlsx,
        'sheet',
        /Sara,1200/,
      ],
      ['list.csv', 'text/csv', Buffer.from('a,b\n1,2\n'), 'sheet', /1,2/],
      ['readme.md', 'application/octet-stream', Buffer.from('# Hello\nPlain words.'), 'text', /Plain words/],
    ];
    for (const [name, type, bytes, kind, text] of cases) {
      const res = await upload(a, name, type, bytes).expect(200);
      expect(res.body).toMatchObject({ name, kind, note: null });
      expect(res.body.chars).toBeGreaterThan(0);
      const chat = await api().post('/api/chats').set('cookie', a).set(origin).send({}).expect(200);
      await sse(a, `/chats/${chat.body.id}/messages`, { text: 'What does it say?', fileIds: [res.body.id] });
      expect(seen.at(-1)!.system).toMatch(text);
    }
  });

  it('describes images (1 credit) so any model can use them', async () => {
    const png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#888' } })
      .png()
      .toBuffer();
    const res = await upload(a, 'photo.png', 'image/png', png).expect(200);
    expect(res.body).toMatchObject({ kind: 'image', credits: 1 });
    expect(res.body.chars).toBeGreaterThan(0);
  });

  it('attaches files to a message, keeps them for follow-ups, and charges for long ones', async () => {
    const long = Buffer.from(`Start of the contract. ${'clause '.repeat(14_000)}`);
    const f = await upload(a, 'contract.txt', 'text/plain', long).expect(200);
    const chat = await api().post('/api/chats').set('cookie', a).set(origin).send({}).expect(200);
    const events = await sse(a, `/chats/${chat.body.id}/messages`, { text: '', fileIds: [f.body.id] });
    expect(events.at(-1)!.event).toBe('done');
    const ready = events.find((e) => e.event === 'ready')!.data;
    expect(ready.userMessage.attachments).toEqual([{ id: f.body.id, name: 'contract.txt', kind: 'text' }]);
    expect(seen.at(-1)!.extraCredits).toBe(3); // ~98,000 characters
    expect(seen.at(-1)!.messages.at(-1)!.content).toMatch(/\[Attached: contract\.txt\]/);
    const detail = await api().get(`/api/chats/${chat.body.id}`).set('cookie', a).expect(200);
    expect(detail.body.chat.title).toBe('contract.txt');

    // A follow-up without files still has the contract.
    await sse(a, `/chats/${chat.body.id}/messages`, { text: 'Summarise clause 2' });
    expect(seen.at(-1)!.system).toMatch(/Start of the contract/);
  });

  it('refuses unknown, fake, empty and too many files', async () => {
    expect(
      (await upload(a, 'old.doc', 'application/msword', Buffer.from('xx')).expect(422)).body.error.message,
    ).toMatch(/\.docx/);
    await upload(a, 'fake.pdf', 'application/pdf', Buffer.from('not a pdf at all')).expect(422);
    await upload(a, 'tool.exe', 'application/x-msdownload', Buffer.from('MZ')).expect(422);
    await upload(a, 'empty.txt', 'text/plain', Buffer.alloc(0)).expect(422);
    await upload(a, 'big.txt', 'text/plain', Buffer.alloc(21 * 1024 * 1024, 97)).expect(413);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++)
      ids.push((await upload(a, `n${i}.txt`, 'text/plain', Buffer.from(`note ${i}`)).expect(200)).body.id);
    const chat = await api().post('/api/chats').set('cookie', a).set(origin).send({}).expect(200);
    await api()
      .post(`/api/chats/${chat.body.id}/messages`)
      .set('cookie', a)
      .set(origin)
      .send({ text: 'hi', fileIds: ids })
      .expect(422);
    await api()
      .post(`/api/chats/${chat.body.id}/messages`)
      .set('cookie', a)
      .set(origin)
      .send({ text: '' })
      .expect(422);
  });

  it('lists, downloads and deletes files; other people can’t see or use them', async () => {
    const f = await upload(a, 'secret.txt', 'text/plain', Buffer.from('Only for A')).expect(200);
    const list = await api().get('/api/files').set('cookie', a).expect(200);
    expect(list.body.items.map((x: { name: string }) => x.name)).toContain('secret.txt');
    const dl = await api().get(`/api/files/${f.body.id}/content?download=1`).set('cookie', a).expect(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment; filename="secret.txt"/);
    expect(dl.text).toBe('Only for A');

    expect((await api().get('/api/files').set('cookie', b).expect(200)).body.items).toEqual([]);
    await api().get(`/api/files/${f.body.id}`).set('cookie', b).expect(404);
    await api().get(`/api/files/${f.body.id}/content`).set('cookie', b).expect(404);
    await api().delete(`/api/files/${f.body.id}`).set('cookie', b).set(origin).expect(404);
    const chatB = await api().post('/api/chats').set('cookie', b).set(origin).send({}).expect(200);
    await api()
      .post(`/api/chats/${chatB.body.id}/messages`)
      .set('cookie', b)
      .set(origin)
      .send({ text: 'read', fileIds: [f.body.id] })
      .expect(404);

    await api().delete(`/api/files/${f.body.id}`).set('cookie', a).set(origin).expect(204);
    await api().get(`/api/files/${f.body.id}/content`).set('cookie', a).expect(404);
  });

  it('needs a session', async () => {
    await api().get('/api/files').expect(401);
    await api()
      .post('/api/files?name=a.txt')
      .set(origin)
      .set('content-type', 'text/plain')
      .send('x')
      .expect(401);
  });
});
