import { Module } from '@nestjs/common';
import { CreditsModule } from '../credits/credits.module.js';
import { ModelsModule } from '../models/models.module.js';
import { GatewayService } from './gateway.service.js';

/** The model gateway. Chat, Docs, Research and AI Crews call models only through this. */
@Module({ imports: [ModelsModule, CreditsModule], providers: [GatewayService], exports: [GatewayService] })
export class GatewayModule {}
