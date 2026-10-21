import { Module } from '@nestjs/common';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

@Module({ imports: [WorkspacesModule], controllers: [HomeController], providers: [HomeService] })
export class HomeModule {}
