import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { MemoryController } from './memory.controller.js';
import { MemoryService } from './memory.service.js';

@Module({
  imports: [GatewayModule, WorkspacesModule],
  controllers: [MemoryController],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
