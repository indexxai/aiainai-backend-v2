import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ComposioConnector } from './composio-connector.js';
import { ConnectionsController } from './connections.controller.js';
import { ConnectionsService } from './connections.service.js';
import { CONNECTOR, type Connector } from './connector.js';
import { DemoConnector } from './demo-connector.js';

/** Composio with a key; the stand-in otherwise outside production; nothing to connect in production. */
export function createConnector(config: ConfigService<Env, true>): Connector {
  const key = config.get('COMPOSIO_API_KEY', { infer: true });
  if (key)
    return new ComposioConnector(key, {
      gmail: config.get('COMPOSIO_AUTH_CONFIG_GMAIL', { infer: true }),
      'google-calendar': config.get('COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR', { infer: true }),
      'google-drive': config.get('COMPOSIO_AUTH_CONFIG_GOOGLE_DRIVE', { infer: true }),
      slack: config.get('COMPOSIO_AUTH_CONFIG_SLACK', { infer: true }),
    });
  if (config.get('NODE_ENV', { infer: true }) === 'production') {
    const off = new DemoConnector();
    return Object.assign(off, { isAvailable: () => false });
  }
  return new DemoConnector();
}

@Module({
  imports: [WorkspacesModule],
  controllers: [ConnectionsController],
  providers: [
    ConnectionsService,
    { provide: CONNECTOR, useFactory: createConnector, inject: [ConfigService] },
  ],
  exports: [ConnectionsService],
})
export class ConnectionsModule {}
