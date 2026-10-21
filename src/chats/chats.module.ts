import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { JackModule } from '../jack/jack.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { ConnectionsModule } from '../connections/connections.module.js';
import { ChatsController } from './chats.controller.js';
import { FilesModule } from '../files/files.module.js';
import { ChatsService } from './chats.service.js';

@Module({
  imports: [
    GatewayModule,
    ModelsModule,
    WorkspacesModule,
    JackModule,
    MemoryModule,
    ConnectionsModule,
    FilesModule,
  ],
  controllers: [ChatsController],
  providers: [ChatsService],
  exports: [ChatsService],
})
export class ChatsModule {}
