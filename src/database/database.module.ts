import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Env } from '../config/env.js';

/**
 * One MongoDB connection for the process (API or worker). aiainai uses its own Atlas
 * project and database, separate from other indexx products.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        uri: config.get('MONGODB_URI', { infer: true }),
        dbName: config.get('MONGODB_DB', { infer: true }),
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5_000,
        // Wait for the database at startup (with retries) so the app never serves without it.
        // DB_LAZY_CONNECT=1 is only for tooling that needs the app graph but no database (OpenAPI export).
        lazyConnection: process.env.DB_LAZY_CONNECT === '1',
        retryAttempts: 10,
        retryDelay: 3_000,
      }),
    }),
  ],
})
export class DatabaseModule {}
