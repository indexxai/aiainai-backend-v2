import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, type SessionUser } from '../auth/auth.decorators.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { ReceiptListDto, UpdateWalletDto, WalletDto } from './wallet.dto.js';
import { WalletService } from './wallet.service.js';

const amount = z.number().int().min(0).max(100_000_000);
const updateInput = z
  .object({
    currency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/, 'Use a 3-letter currency code, like USD or PKR')
      .optional(),
    perPurchase: amount.optional(),
    perDay: amount.optional(),
    perMonth: amount.optional(),
    blockedSites: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  })
  .strict();

/** Wallet for the current space (header x-aiainai-space). */
@ApiTags('wallet')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('wallet')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly workspaces: WorkspacesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Card, limits, spent so far and blocked sites in this space' })
  @ApiOkResponse({ type: WalletDto })
  async get(@CurrentUser() user: SessionUser): Promise<WalletDto> {
    const { workspace } = await this.workspaces.forRequest(user);
    return this.wallet.get(workspace._id);
  }

  @Patch()
  @ApiOperation({ summary: 'Change limits, currency or blocked sites' })
  @ApiBody({ type: UpdateWalletDto })
  @ApiOkResponse({ type: WalletDto })
  async update(@CurrentUser() user: SessionUser, @Body() body: unknown): Promise<WalletDto> {
    const { workspace } = await this.workspaces.forRequest(user);
    return this.wallet.update(workspace._id, parseInput(updateInput, body ?? {}));
  }

  @Get('receipts')
  @ApiOperation({ summary: 'Everything Jack paid for in this space, newest first' })
  @ApiOkResponse({ type: ReceiptListDto })
  async receipts(@CurrentUser() user: SessionUser): Promise<ReceiptListDto> {
    const { workspace } = await this.workspaces.forRequest(user);
    return { items: await this.wallet.list(workspace._id) };
  }
}
