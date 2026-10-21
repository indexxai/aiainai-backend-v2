import { Module } from '@nestjs/common';
import { DocsModule } from '../docs/docs.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ImagesModule } from '../images/images.module.js';
import { JackService } from './jack.service.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { BrowserModule } from '../browser/browser.module.js';
import { ActionsModule } from '../actions/actions.module.js';

/** Jack's tools in conversations: AI Docs, AI Image and the AI Crews. */
@Module({
  imports: [GatewayModule, DocsModule, ImagesModule, ConnectionsModule, BrowserModule, ActionsModule],
  providers: [JackService],
  exports: [JackService],
})
export class JackModule {}
