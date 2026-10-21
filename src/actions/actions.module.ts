import { Module } from '@nestjs/common';
import { ConnectionsModule } from '../connections/connections.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ActionsController } from './actions.controller.js';
import { ActionsService } from './actions.service.js';

@Module({
  imports: [WalletModule, ConnectionsModule, WorkspacesModule],
  controllers: [ActionsController],
  providers: [ActionsService],
  exports: [ActionsService],
})
export class ActionsModule {}
