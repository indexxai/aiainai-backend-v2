import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { FilesController } from './files.controller.js';
import { FilesService } from './files.service.js';

@Module({
  imports: [ModelsModule, CreditsModule, WorkspacesModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
