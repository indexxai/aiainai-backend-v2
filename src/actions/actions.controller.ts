import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ApproveActionDto, JackActionDto, RejectActionDto } from './actions.dto.js';
import { ActionsService } from './actions.service.js';

const approveInput = z.object({ body: z.string().max(20_000).optional() }).strict();
const rejectInput = z.object({ note: z.string().trim().max(300).optional() }).strict();

/** Approve or reject what Jack wants to do (from either space). */
@ApiTags('approvals')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('approvals/jack')
export class ActionsController {
  constructor(
    private readonly actions: ActionsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve: Jack pays, sends or adds it now (purchases must fit the Wallet limits)',
  })
  @ApiBody({ type: ApproveActionDto, required: false })
  @ApiOkResponse({ type: JackActionDto })
  async approve(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<JackActionDto> {
    return this.actions.approve(
      await this.workspaces.spacesFor(user),
      id,
      parseInput(approveInput, body ?? {}),
    );
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject: nothing is paid, sent or added' })
  @ApiBody({ type: RejectActionDto, required: false })
  @ApiOkResponse({ type: JackActionDto })
  async reject(
    @CurrentUser() user: SessionUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<JackActionDto> {
    return this.actions.reject(
      await this.workspaces.spacesFor(user),
      id,
      parseInput(rejectInput, body ?? {}).note,
    );
  }
}
