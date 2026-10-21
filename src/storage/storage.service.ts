import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { GridFSBucket } from 'mongodb';
import type { Connection } from 'mongoose';
import type { Env } from '../config/env.js';

export interface StoredFile {
  bytes: Buffer;
  contentType: string;
}

/** Storage for binary files (generated images, later uploads). Keys are opaque strings. */
export interface StorageDriver {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}

/** MongoDB GridFS: no extra service needed (Atlas included). */
export class GridFsDriver implements StorageDriver {
  constructor(private readonly bucket: () => GridFSBucket) {}

  async put(key: string, bytes: Buffer, contentType: string) {
    await new Promise<void>((resolve, reject) => {
      const up = this.bucket().openUploadStream(key, { metadata: { contentType } });
      up.on('error', reject).on('finish', () => resolve());
      up.end(bytes);
    });
  }

  async get(key: string): Promise<StoredFile | null> {
    const file = await this.bucket().find({ filename: key }).sort({ uploadDate: -1 }).limit(1).next();
    if (!file) return null;
    const chunks: Buffer[] = [];
    for await (const c of this.bucket().openDownloadStream(file._id)) chunks.push(c as Buffer);
    return {
      bytes: Buffer.concat(chunks),
      contentType: String(file.metadata?.contentType ?? 'application/octet-stream'),
    };
  }

  async delete(key: string) {
    for await (const f of this.bucket().find({ filename: key })) await this.bucket().delete(f._id);
  }
}

/** In-process storage for tests and the local demo backend. */
export class MemoryDriver implements StorageDriver {
  readonly files = new Map<string, StoredFile>();
  async put(key: string, bytes: Buffer, contentType: string) {
    this.files.set(key, { bytes, contentType });
  }
  async get(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
}

@Injectable()
export class StorageService implements StorageDriver {
  private readonly driver: StorageDriver;

  constructor(config: ConfigService<Env, true>, @InjectConnection() connection: Connection) {
    const kind = config.get('STORAGE_DRIVER', { infer: true }) ?? 'gridfs';
    let bucket: GridFSBucket | undefined;
    this.driver =
      kind === 'memory'
        ? new MemoryDriver()
        : new GridFsDriver(() => (bucket ??= new GridFSBucket(connection.db!, { bucketName: 'files' })));
  }

  put(key: string, bytes: Buffer, contentType: string) {
    return this.driver.put(key, bytes, contentType);
  }
  get(key: string) {
    return this.driver.get(key);
  }
  delete(key: string) {
    return this.driver.delete(key);
  }
}
