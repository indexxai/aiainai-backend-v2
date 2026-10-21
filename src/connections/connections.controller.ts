import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import type { Env } from '../config/env.js';
import { ACCESS_LEVELS, CONNECTION_APPS, type ConnectionApp } from '../database/schemas/connection.schema.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ConnectionsDto, ConnectResultDto, SetLevelDto } from './connections.dto.js';
import { ConnectionsService, type ConnectionsActor } from './connections.service.js';

const appParam = z.enum(CONNECTION_APPS);
const levelInput = z.object({ level: z.enum(ACCESS_LEVELS) }).strict();

/** Connections for the current space (header x-aiainai-space). */
@ApiTags('connections')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly workspaces: WorkspacesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private async actor(user: SessionUser): Promise<ConnectionsActor> {
    const { workspace, space } = await this.workspaces.forRequest(user);
    return { userId: user.id, workspaceId: workspace._id, email: user.email, space };
  }

  private app(raw: string): ConnectionApp {
    return parseInput(appParam, raw);
  }

  @Get()
  @ApiOperation({ summary: 'Apps Jack can use in this space and how much he may do in each' })
  @ApiOkResponse({ type: ConnectionsDto })
  async list(@CurrentUser() user: SessionUser): Promise<ConnectionsDto> {
    return this.connections.list(await this.actor(user));
  }

  @Post(':app/connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Start connecting an app: returns the app’s sign-in page to open' })
  @ApiOkResponse({ type: ConnectResultDto })
  async connect(@CurrentUser() user: SessionUser, @Param('app') app: string): Promise<ConnectResultDto> {
    const a = this.app(app);
    const back = `${this.config.get('APP_URL', { infer: true })}/connections?connected=${a}`;
    return this.connections.connect(await this.actor(user), a, back);
  }

  @Post(':app/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check a connection after the person comes back from signing in' })
  @ApiOkResponse({ type: ConnectionsDto })
  async refresh(@CurrentUser() user: SessionUser, @Param('app') app: string): Promise<ConnectionsDto> {
    return this.connections.refresh(await this.actor(user), this.app(app));
  }

  @Patch(':app')
  @ApiOperation({ summary: 'How much Jack may do in this app: read · draft · ask first · on his own' })
  @ApiBody({ type: SetLevelDto })
  @ApiOkResponse({ type: ConnectionsDto })
  async level(
    @CurrentUser() user: SessionUser,
    @Param('app') app: string,
    @Body() body: unknown,
  ): Promise<ConnectionsDto> {
    const { level } = parseInput(levelInput, body ?? {});
    return this.connections.setLevel(await this.actor(user), this.app(app), level);
  }

  @Delete(':app')
  @ApiOperation({ summary: 'Disconnect an app from this space' })
  @ApiOkResponse({ type: ConnectionsDto })
  async disconnect(@CurrentUser() user: SessionUser, @Param('app') app: string): Promise<ConnectionsDto> {
    return this.connections.disconnect(await this.actor(user), this.app(app));
  }
}
