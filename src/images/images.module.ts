import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { ImagesController } from './images.controller.js';
import { ImagesService } from './images.service.js';

@Module({
  imports: [GatewayModule, ModelsModule, CreditsModule, WorkspacesModule],
  controllers: [ImagesController],
  exports: [ImagesService],
  providers: [ImagesService],
})
export class ImagesModule {}
