import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { BrowserTaskDto } from './browser.dto.js';
import { BrowserService, type BrowserActor } from './browser.service.js';

const control = z.enum(['pause', 'resume', 'takeover', 'giveback', 'stop']);
const schemeInput = z.enum(['light', 'dark']);

/** Jack's browser tasks in the current space. */
@ApiTags('browser')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('browser')
export class BrowserController {
  constructor(
    private readonly browser: BrowserService,
    private readonly workspaces: WorkspacesService,
  ) {}

  private async actor(user: SessionUser): Promise<BrowserActor> {
    const { workspace, billing, space } = await this.workspaces.forRequest(user);
    return { userId: user.id, workspaceId: workspace._id, plan: billing.plan, space };
  }

  @Get(':id')
  @ApiOperation({ summary: 'A browser task: steps, live view and the purchase waiting for your OK' })
  @ApiOkResponse({ type: BrowserTaskDto })
  async get(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<BrowserTaskDto> {
    return this.browser.get(await this.actor(user), id);
  }

  @Post(':id/appearance/:scheme')
  @HttpCode(204)
  @ApiOperation({ summary: 'Show sites in the browser dark or light, to match the app theme' })
  @ApiParam({ name: 'scheme', enum: ['light', 'dark'] })
  async appearance(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('scheme') scheme: string,
  ): Promise<void> {
    await this.browser.appearance(await this.actor(user), id, parseInput(schemeInput, scheme));
  }

  @Post(':id/:control')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pause, resume, take over, give back, or stop the task (stopping cancels its payment)',
  })
  @ApiParam({ name: 'control', enum: ['pause', 'resume', 'takeover', 'giveback', 'stop'] })
  @ApiOkResponse({ type: BrowserTaskDto })
  async control(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Param('control') what: string,
  ): Promise<BrowserTaskDto> {
    return this.browser.control(await this.actor(user), id, parseInput(control, what));
  }
}
