import { Aggregator, Query } from 'mingo';
import { update as applyUpdate } from 'mingo/updater';
import mongoose, { Types, type Schema } from 'mongoose';

type Doc = Record<string, any>;

/**
 * An in-memory stand-in for a Mongoose model, for tests and the local demo backend (MongoDB
 * can't run in every environment). Supports the subset of the API the services use:
 * find / findOne / findById / findOneAndUpdate / updateOne / exists / create / countDocuments,
 * with real MongoDB query and update operators (via mingo) and the schema's defaults.
 */
export class MemoryModel {
  readonly docs: Doc[] = [];
  private readonly ctor: new (doc: Doc) => { toObject(o?: Doc): Doc };

  constructor(name: string, schema: Schema) {
    // A private Mongoose instance: casts values and applies defaults without a connection.
    const m = new mongoose.Mongoose();
    this.ctor = m.model(name, schema.clone()) as unknown as typeof this.ctor;
  }

  find(filter: Doc = {}, projection?: Doc) {
    return new Cursor(() => this.docs.filter((d) => matches(filter, d)), projection);
  }

  findOne(filter: Doc = {}, projection?: Doc) {
    return single(async () => this.docs.find((d) => matches(filter, d)), projection);
  }

  findById(id: Types.ObjectId | string) {
    return this.findOne({ _id: new Types.ObjectId(String(id)) });
  }

  findOneAndUpdate(filter: Doc, update: Doc, opts: { new?: boolean; projection?: Doc } = {}) {
    return single(async () => {
      const doc = this.docs.find((d) => matches(filter, d));
      if (!doc) return undefined;
      const before = clone(doc);
      apply(doc, update);
      return opts.new ? doc : before;
    }, opts.projection);
  }

  async updateOne(filter: Doc, update: Doc, opts: { upsert?: boolean } = {}) {
    const doc = this.docs.find((d) => matches(filter, d));
    if (!doc && opts.upsert) {
      // New document from the filter's plain fields, then the update (with $setOnInsert).
      const base = Object.fromEntries(
        Object.entries(filter).filter(([k, v]) => !k.startsWith('$') && !isOp(v)),
      );
      const { $setOnInsert, ...rest } = update;
      await this.create({ ...base, ...$setOnInsert });
      apply(this.docs[this.docs.length - 1]!, rest);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    if (!doc) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    apply(doc, update);
    return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
  }

  async updateMany(filter: Doc, update: Doc) {
    const hits = this.docs.filter((d) => matches(filter, d));
    for (const d of hits) apply(d, update);
    return { matchedCount: hits.length, modifiedCount: hits.length, upsertedCount: 0 };
  }

  async deleteMany(filter: Doc) {
    const before = this.docs.length;
    for (let i = this.docs.length - 1; i >= 0; i--)
      if (matches(filter, this.docs[i]!)) this.docs.splice(i, 1);
    return { deletedCount: before - this.docs.length };
  }

  async deleteOne(filter: Doc) {
    const i = this.docs.findIndex((d) => matches(filter, d));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }

  async exists(filter: Doc) {
    const doc = this.docs.find((d) => matches(filter, d));
    return doc ? { _id: doc._id } : null;
  }

  async aggregate<T = Doc>(pipeline: Doc[]): Promise<T[]> {
    return new Aggregator(pipeline as never).run(this.docs.map(clone)) as T[];
  }

  async countDocuments(filter: Doc = {}) {
    return this.docs.filter((d) => matches(filter, d)).length;
  }

  async create(input: Doc | Doc[]): Promise<any> {
    const many = Array.isArray(input);
    const out = (many ? input : [input]).map((raw) => {
      const now = new Date();
      const doc = new this.ctor(raw).toObject({ depopulate: true, virtuals: false, versionKey: false });
      doc.createdAt ??= now;
      doc.updatedAt ??= now;
      this.docs.push(doc);
      return { ...clone(doc), toObject: () => clone(doc) };
    });
    return many ? out : out[0];
  }
}

class Cursor {
  private sortSpec?: Doc;
  private max?: number;

  constructor(
    private readonly source: () => Doc[],
    private readonly projection?: Doc,
  ) {}

  sort(spec: Doc) {
    this.sortSpec = spec;
    return this;
  }

  limit(n: number) {
    this.max = n;
    return this;
  }

  async lean<T = Doc[]>(): Promise<T> {
    let rows = [...this.source()];
    if (this.sortSpec) rows.sort(comparator(this.sortSpec));
    if (this.max !== undefined) rows = rows.slice(0, this.max);
    return rows.map((r) => project(clone(r), this.projection)) as T;
  }

  // Mongoose queries are thenable (`await model.find(...)`); this mirrors that on purpose.
  // oxlint-disable-next-line unicorn/no-thenable
  then<R>(ok: (v: Doc[]) => R, fail?: (e: unknown) => R) {
    return this.lean<Doc[]>().then(ok, fail);
  }
}

function single(get: () => Promise<Doc | undefined>, projection?: Doc) {
  const run = async () => {
    const d = await get();
    return d ? project(clone(d), projection) : null;
  };
  // oxlint-disable-next-line unicorn/no-thenable
  return { lean: <T = Doc>() => run() as Promise<T>, then: (ok: any, fail?: any) => run().then(ok, fail) };
}

function isOp(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    !(v instanceof Types.ObjectId) &&
    !(v instanceof Date) &&
    Object.keys(v).some((k) => k.startsWith('$'))
  );
}

function matches(filter: Doc, doc: Doc): boolean {
  return new Query(filter).test(doc);
}

function apply(doc: Doc, update: Doc) {
  const hasOps = Object.keys(update).some((k) => k.startsWith('$'));
  const modifier: Doc = hasOps ? { ...update } : { $set: update };
  // Only applies when an upsert inserts (handled in updateOne); a matched document ignores it.
  delete modifier.$setOnInsert;
  modifier.$set = { ...modifier.$set, updatedAt: new Date() };
  applyUpdate(doc, modifier, undefined, undefined, { cloneMode: 'none' });
}

function comparator(spec: Doc) {
  const keys = Object.entries(spec);
  return (a: Doc, b: Doc) => {
    for (const [k, dir] of keys) {
      const x = key(a[k]);
      const y = key(b[k]);
      if (x === y) continue;
      if (x === undefined || x === null) return -1 * dir;
      if (y === undefined || y === null) return 1 * dir;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  };
}

function key(v: any) {
  if (v instanceof Date) return v.getTime();
  if (v instanceof Types.ObjectId) return v.toHexString();
  return v;
}

function project(doc: Doc, projection?: Doc): Doc {
  if (!projection) return doc;
  const include = Object.entries(projection).filter(([, v]) => v);
  if (!include.length) return doc;
  const out: Doc = { _id: doc._id };
  for (const [k] of include) out[k] = doc[k];
  return out;
}

function clone(v: any): any {
  if (v instanceof Types.ObjectId || v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(clone);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)]));
}
