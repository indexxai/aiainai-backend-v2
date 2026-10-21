import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module.js';
import { ModelsModule } from '../models/models.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { DocsExportService } from './docs-export.service.js';
import { DocsSharingService } from './docs-sharing.service.js';
import { DocsVersionsController } from './docs-versions.controller.js';
import { DocsVersionsService } from './docs-versions.service.js';
import { DocsController } from './docs.controller.js';
import { PublicDocsController } from './public-docs.controller.js';
import { ProjectContextService } from '../projects/project-context.service.js';
import { DocsService } from './docs.service.js';

@Module({
  imports: [GatewayModule, ModelsModule, WorkspacesModule],
  controllers: [DocsController, DocsVersionsController, PublicDocsController],
  exports: [DocsService],
  providers: [DocsService, DocsSharingService, DocsVersionsService, DocsExportService, ProjectContextService],
})
export class DocsModule {}
