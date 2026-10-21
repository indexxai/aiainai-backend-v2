import { Controller, Get, HttpStatus, Logger, Res } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import {
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { Connection } from 'mongoose';
import { Public } from '../auth/auth.decorators.js';
import { HealthCheckDto, HealthReportDto } from './health.dto.js';

export type HealthReport = HealthReportDto;

@Public()
@ApiTags('system')
@ApiExtraModels(HealthCheckDto)
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get()
  @ApiOperation({ summary: 'Liveness and dependency check for uptime monitors and load balancers' })
  @ApiOkResponse({ type: HealthReportDto })
  @ApiServiceUnavailableResponse({
    type: HealthReportDto,
    description: 'A dependency (e.g. MongoDB) is unreachable',
  })
  async check(@Res({ passthrough: true }) res: Response): Promise<HealthReport> {
    const checks: HealthReport['checks'] = {};
    const started = Date.now();
    try {
      await this.connection.asPromise();
      const db = this.connection.db;
      if (!db) throw new Error('database handle not ready');
      await db.admin().ping();
      checks.database = { ok: true, ms: Date.now() - started };
    } catch (err) {
      // Details stay in the server log; the public response is generic.
      this.logger.error('database check failed', err instanceof Error ? err.stack : String(err));
      checks.database = { ok: false, error: 'unreachable' };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).setHeader('cache-control', 'no-store');
    return { ok, version: process.env.APP_VERSION ?? 'dev', checks };
  }
}
