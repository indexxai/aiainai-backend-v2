import { HttpStatus, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomInt } from 'node:crypto';
import { Types, type Model } from 'mongoose';
import { AppError } from '../common/api-error.js';
import { JackAction, type PurchasePayload } from '../database/schemas/jack-action.schema.js';
import { Receipt, Wallet } from '../database/schemas/wallet.schema.js';
import type { ReceiptDto, WalletDto } from './wallet.dto.js';
import {
  blockedBy,
  domainOf,
  isDomain,
  overLimit,
  SITE_KINDS,
  startOfDay,
  startOfMonth,
} from './wallet.logic.js';

type WalletLean = Wallet & { _id: Types.ObjectId };
type ReceiptLean = Receipt & { _id: Types.ObjectId; createdAt: Date };

/** The test card used until a card-issuing provider is set up. */
const TEST_CARD = { brand: 'Visa', last4: '4242' };

/**
 * Wallet per space (v2): limits, blocked sites, receipts. Payments run in test mode: approving a
 * purchase records a receipt paid with a one-time test card, and no real money moves.
 */
@Injectable()
export class WalletService {
  constructor(
    @InjectModel(Wallet.name) private readonly wallets: Model<Wallet>,
    @InjectModel(Receipt.name) private readonly receipts: Model<Receipt>,
    @InjectModel(JackAction.name) private readonly actions: Model<JackAction>,
  ) {}

  /** The space's wallet, made with the default limits the first time. */
  private async wallet(workspaceId: Types.ObjectId): Promise<WalletLean> {
    const found = await this.wallets.findOne({ workspaceId }).lean<WalletLean>();
    if (found) return found;
    try {
      await this.wallets.create({ workspaceId });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // made by a request at the same moment
    }
    return (await this.wallets.findOne({ workspaceId }).lean<WalletLean>())!;
  }

  async spent(workspaceId: Types.ObjectId, now = new Date()): Promise<{ today: number; month: number }> {
    const rows = await this.receipts
      .find(
        { workspaceId, status: 'paid', createdAt: { $gte: startOfMonth(now) } },
        { amount: 1, createdAt: 1 },
      )
      .lean<ReceiptLean[]>();
    const day = startOfDay(now).getTime();
    return {
      month: rows.reduce((n, r) => n + r.amount, 0),
      today: rows.filter((r) => new Date(r.createdAt).getTime() >= day).reduce((n, r) => n + r.amount, 0),
    };
  }

  async get(workspaceId: Types.ObjectId): Promise<WalletDto> {
    const [w, spent] = await Promise.all([this.wallet(workspaceId), this.spent(workspaceId)]);
    return {
      currency: w.currency ?? 'PKR',
      perPurchase: w.perPurchase,
      perDay: w.perDay,
      perMonth: w.perMonth,
      spentToday: spent.today,
      spentMonth: spent.month,
      blockedSites: w.blockedSites ?? [],
      siteKinds: Object.entries(SITE_KINDS).map(([id, k]) => ({ id, label: k.label })),
      card: w.card ?? TEST_CARD,
      test: true,
    };
  }

  async update(
    workspaceId: Types.ObjectId,
    input: Partial<Pick<Wallet, 'currency' | 'perPurchase' | 'perDay' | 'perMonth' | 'blockedSites'>>,
  ): Promise<WalletDto> {
    const w = await this.wallet(workspaceId);
    const next = { ...w, ...input };
    if (next.perPurchase > next.perDay || next.perDay > next.perMonth)
      throw new AppError(
        'validation_failed',
        'Limits must grow: per purchase ≤ per day ≤ per month.',
        HttpStatus.UNPROCESSABLE_ENTITY,
        { fields: { perPurchase: 'order' } },
      );
    // Each entry is a kind ("banking") or a site address, saved as its bare domain ("example.com").
    const blockedSites = input.blockedSites && [
      ...new Set(
        input.blockedSites.map((s) => {
          const entry = s.trim().toLowerCase();
          if (SITE_KINDS[entry]) return entry;
          const domain = domainOf(entry);
          if (!isDomain(domain))
            throw new AppError(
              'validation_failed',
              `“${s.trim().slice(0, 60)}” isn’t a site address. Use one like example.com.`,
              HttpStatus.UNPROCESSABLE_ENTITY,
              { fields: { blockedSites: 'invalid' } },
            );
          return domain;
        }),
      ),
    ];
    await this.wallets.updateOne(
      { workspaceId },
      { $set: { ...input, ...(blockedSites && { blockedSites }) } },
    );
    return this.get(workspaceId);
  }

  /** May Jack open this site at all? */
  async siteBlocked(workspaceId: Types.ObjectId, site: string): Promise<string | null> {
    const w = await this.wallet(workspaceId);
    return blockedBy(site, w.blockedSites ?? []);
  }

  /** Why this purchase can't go ahead now (blocked site or over a limit), or null. */
  async check(workspaceId: Types.ObjectId, p: PurchasePayload): Promise<string | null> {
    const [w, spent] = await Promise.all([this.wallet(workspaceId), this.spent(workspaceId)]);
    const blocked = blockedBy(p.site, w.blockedSites ?? []);
    if (blocked) return `${p.site} is blocked in your Wallet (${blocked}).`;
    return overLimit({
      amount: p.amount,
      currency: p.currency,
      perPurchase: w.perPurchase,
      perDay: w.perDay,
      perMonth: w.perMonth,
      spentToday: spent.today,
      spentMonth: spent.month,
    });
  }

  /** Pay an approved purchase with a one-time card (test mode). */
  async pay(workspaceId: Types.ObjectId, actionId: Types.ObjectId, p: PurchasePayload): Promise<ReceiptDto> {
    const problem = await this.check(workspaceId, p);
    if (problem) throw new AppError('conflict', problem, HttpStatus.CONFLICT);
    const row = await this.receipts.create({
      workspaceId,
      actionId,
      item: p.item,
      seller: p.seller,
      site: p.site,
      amount: p.amount,
      currency: p.currency,
      status: 'paid',
      test: true,
      cardLast4: String(randomInt(1000, 9999)),
    });
    return this.toDto(row.toObject() as unknown as ReceiptLean);
  }

  async list(workspaceId: Types.ObjectId): Promise<ReceiptDto[]> {
    const rows = await this.receipts
      .find({ workspaceId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean<ReceiptLean[]>();
    return Promise.all(rows.map((r) => this.toDto(r)));
  }

  private async toDto(r: ReceiptLean): Promise<ReceiptDto> {
    const action = await this.actions.findById(r.actionId, { chatId: 1 }).lean<Pick<JackAction, 'chatId'>>();
    return {
      id: r._id.toHexString(),
      item: r.item,
      seller: r.seller,
      site: r.site,
      amount: r.amount,
      currency: r.currency,
      status: r.status,
      test: r.test,
      cardLast4: r.cardLast4,
      createdAt: new Date(r.createdAt).toISOString(),
      chatId: action?.chatId ? String(action.chatId) : null,
    };
  }
}
