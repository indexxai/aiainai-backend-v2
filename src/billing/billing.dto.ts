import { ApiProperty } from '@nestjs/swagger';

export class PlanInfoDto {
  @ApiProperty({ enum: ['free', 'pro'] }) key!: 'free' | 'pro';
  @ApiProperty({ example: 'Free' }) label!: string;
  @ApiProperty() monthlyCredits!: number;
  @ApiProperty() periodStart!: string;
  @ApiProperty({ description: 'When plan credits reset' }) periodEnd!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Paid plans: paid up to this moment (one-time payments, no automatic renewal)',
  })
  paidUntil!: string | null;
}

export class CreditsInfoDto {
  @ApiProperty() spendable!: number;
  @ApiProperty() plan!: number;
  @ApiProperty() topup!: number;
  @ApiProperty() held!: number;
  @ApiProperty() monthly!: number;
}

export class StorageInfoDto {
  @ApiProperty() usedBytes!: number;
  @ApiProperty() limitBytes!: number;
}

export class ToolUsageDto {
  @ApiProperty({ example: 'chat' }) tool!: string;
  @ApiProperty({ example: 'AI Chat' }) label!: string;
  @ApiProperty() credits!: number;
}

export class BillingSummaryDto {
  @ApiProperty({ type: PlanInfoDto }) plan!: PlanInfoDto;
  @ApiProperty({ type: CreditsInfoDto }) credits!: CreditsInfoDto;
  @ApiProperty({ type: StorageInfoDto }) storage!: StorageInfoDto;
  @ApiProperty({ type: [ToolUsageDto], description: 'Credits used by each tool this period, most first' })
  byTool!: ToolUsageDto[];
  @ApiProperty({ description: 'Credits used this period' }) usedThisPeriod!: number;
}

export class HistoryItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ example: 'AI Chat · Claude Sonnet' }) activity!: string;
  @ApiProperty({ enum: ['charged', 'stopped', 'failed', 'added', 'expired'] })
  status!: 'charged' | 'stopped' | 'failed' | 'added' | 'expired';
  @ApiProperty({ description: 'Signed: negative = spent, positive = added' }) credits!: number;
}

export class HistoryDto {
  @ApiProperty({ type: [HistoryItemDto] }) items!: HistoryItemDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class CheckoutRequestDto {
  @ApiProperty({ enum: ['topup', 'plan'] }) kind!: 'topup' | 'plan';
  @ApiProperty({ required: false, enum: ['500', '1200', '3000'], description: 'Top-ups: the credit pack' })
  pack?: string;
  @ApiProperty({ required: false, enum: ['pro'], description: 'Plans: the plan to pay a month of' })
  plan?: 'pro';
}

export class CheckoutStartDto {
  @ApiProperty({ description: 'Stripe Checkout page to send the person to' }) url!: string;
}

export class CheckoutResultDto {
  @ApiProperty({ enum: ['paid', 'pending', 'unpaid'] }) status!: 'paid' | 'pending' | 'unpaid';
  @ApiProperty({ enum: ['topup', 'plan'] }) kind!: 'topup' | 'plan';
  @ApiProperty() credits!: number;
  @ApiProperty({ type: String, nullable: true }) paidUntil!: string | null;
}

export class PaymentItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() at!: string;
  @ApiProperty({ example: '1,200 credits' }) item!: string;
  @ApiProperty({ description: 'US cents' }) amountCents!: number;
  @ApiProperty() currency!: string;
}

export class PaymentsDto {
  @ApiProperty({ type: [PaymentItemDto] }) items!: PaymentItemDto[];
  @ApiProperty({ enum: ['live', 'sample', 'off'], description: 'Stripe, the local stand-in, or off' })
  mode!: 'live' | 'sample' | 'off';
}
