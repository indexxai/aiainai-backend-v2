import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  ApiBody,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Public, type SessionUser } from '../auth/auth.decorators.js';
import { AppError } from '../common/api-error.js';
import type { Env } from '../config/env.js';
import { ApiErrorResponse } from '../common/api-error.js';
import { parseInput } from '../common/validation.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  BillingSummaryDto,
  CheckoutRequestDto,
  CheckoutResultDto,
  CheckoutStartDto,
  HistoryDto,
  PaymentsDto,
} from './billing.dto.js';
import { PACK_IDS } from './payments.logic.js';
import { PaymentsService } from './payments.service.js';
import { BillingService } from './billing.service.js';

const historyQuery = z.object({ cursor: z.string().max(40).optional() });
const checkoutBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('topup'), pack: z.enum(PACK_IDS as [string, ...string[]]) }),
  z.object({ kind: z.literal('plan'), plan: z.literal('pro') }),
]);
const sessionId = z.string().regex(/^(cs_(test|live)_|sample_)[A-Za-z0-9_]{4,200}$/);

@ApiTags('billing')
@ApiUnauthorizedResponse({ type: ApiErrorResponse })
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    private readonly workspaces: WorkspacesService,
    private readonly payments: PaymentsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'Plan, credits, storage and credits used by each tool this period' })
  @ApiOkResponse({ type: BillingSummaryDto })
  async summary(@CurrentUser() user: SessionUser): Promise<BillingSummaryDto> {
    return this.billing.summary(await this.workspaces.ensureForUser(user));
  }

  @Get('history')
  @ApiOperation({ summary: 'Credit history: AI usage and credits added or expired, newest first' })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkResponse({ type: HistoryDto })
  async history(@CurrentUser() user: SessionUser, @Query() raw: unknown): Promise<HistoryDto> {
    const { cursor } = parseInput(historyQuery, raw);
    return this.billing.history(await this.workspaces.ensureForUser(user), cursor);
  }

  @Get('payments')
  @ApiOperation({ summary: 'Payments made (top-ups and paid months), newest first' })
  @ApiOkResponse({ type: PaymentsDto })
  async paymentsList(@CurrentUser() user: SessionUser): Promise<PaymentsDto> {
    return this.payments.list(await this.workspaces.ensureForUser(user));
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Start a one-time payment (credit top-up or a month of a plan); returns the Stripe page',
  })
  @ApiBody({ type: CheckoutRequestDto })
  @ApiOkResponse({ type: CheckoutStartDto })
  async checkout(@CurrentUser() user: SessionUser, @Body() raw: unknown): Promise<CheckoutStartDto> {
    const body = parseInput(checkoutBody, raw) as Parameters<PaymentsService['start']>[2];
    const ws = await this.workspaces.ensureForUser(user);
    return this.payments.start(ws, user, body, this.config.get('APP_URL', { infer: true }));
  }

  @Post('checkout/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'After paying: check the payment with Stripe and apply it if needed' })
  @ApiOkResponse({ type: CheckoutResultDto })
  async confirm(@CurrentUser() user: SessionUser, @Param('id') id: string): Promise<CheckoutResultDto> {
    const ws = await this.workspaces.ensureForUser(user);
    return this.payments.confirm(ws, parseInput(sessionId, id));
  }

  /** Stripe calls this; the signature proves it. Needs the raw body (see setup.ts). */
  @Public()
  @Post('stripe/webhook')
  @HttpCode(HttpStatus.OK)
  @ApiExcludeEndpoint()
  async webhook(
    @Req() req: Request,
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    if (!signature || !Buffer.isBuffer(req.body))
      throw new AppError('bad_request', 'Not a Stripe webhook.', HttpStatus.BAD_REQUEST);
    try {
      await this.payments.webhook(req.body, signature);
    } catch (err) {
      if ((err as { type?: string }).type === 'StripeSignatureVerificationError')
        throw new AppError('bad_request', 'Webhook signature does not match.', HttpStatus.BAD_REQUEST);
      throw err;
    }
    return { received: true };
  }
}
