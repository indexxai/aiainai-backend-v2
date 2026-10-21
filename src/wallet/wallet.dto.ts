import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SiteKindDto {
  @ApiProperty({ example: 'banking' }) id!: string;
  @ApiProperty({ example: 'Banking sites' }) label!: string;
}

export class WalletDto {
  @ApiProperty({ example: 'PKR' }) currency!: string;
  @ApiProperty() perPurchase!: number;
  @ApiProperty() perDay!: number;
  @ApiProperty() perMonth!: number;
  @ApiProperty() spentToday!: number;
  @ApiProperty() spentMonth!: number;
  @ApiProperty({ type: [String], description: 'Kinds of sites (see siteKinds) and addresses' })
  blockedSites!: string[];
  @ApiProperty({ type: [SiteKindDto] }) siteKinds!: SiteKindDto[];
  @ApiProperty({ description: 'Card one-time cards are made from' }) card!: { brand: string; last4: string };
  @ApiProperty({ description: 'Test mode: no real money moves' }) test!: boolean;
}

export class UpdateWalletDto {
  @ApiPropertyOptional() currency?: string;
  @ApiPropertyOptional() perPurchase?: number;
  @ApiPropertyOptional() perDay?: number;
  @ApiPropertyOptional() perMonth?: number;
  @ApiPropertyOptional({ type: [String] }) blockedSites?: string[];
}

export class ReceiptDto {
  @ApiProperty() id!: string;
  @ApiProperty() item!: string;
  @ApiProperty() seller!: string;
  @ApiProperty() site!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: ['paid', 'refunded', 'failed'] }) status!: 'paid' | 'refunded' | 'failed';
  @ApiProperty() test!: boolean;
  @ApiProperty() cardLast4!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: String, nullable: true }) chatId!: string | null;
}

export class ReceiptListDto {
  @ApiProperty({ type: [ReceiptDto] }) items!: ReceiptDto[];
}
