// Dip-reversion with an EMA anchor on pump.fun bonding curves.
//
// Idea: a coin that falls fast usually keeps falling, so a dip buy only works
// when buyers are already absorbing the fall and the dip is deep enough to be
// a real dislocation but not a collapse. Buy the pullback, exit fast on a
// partial bounce, cut fast when the dip keeps dipping. Never chase a vertical
// spike: entries only happen AFTER a drop, never into a rising price.
//
// Price is the marginal price, virtual_quote_reserves / virtual_token_reserves
// (SOL per token), taken from each TradeEvent's post-trade reserves.
//
// Everything here is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, no environment reads, so the two graded
// executions produce byte-identical action logs. Every map walk that can
// affect the orders is in sorted mint order.

import type { Batch, BotState, Mark, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Trades kept per coin (rolling window for the high, the flow and the EMA). */
  maxTicks: number;
  /** Trades a coin needs before it can be entered. */
  minTicks: number;
  /** Lookback (trades) for the recent high the drawdown is measured from. */
  highTrades: number;
  /** The recent high must be at least this many ticks old (not the current spike). */
  highMinAge: number;
  /** Enter when the price is at least this far below the recent high (fraction). */
  ddMin: number;
  /** ...and not further than this (a collapse, not a dip). */
  ddMax: number;
  /** Per-trade EMA weight for the price anchor. */
  emaAlpha: number;
  /** The price must sit at least this far below the EMA (fraction). */
  belowEma: number;
  /** Of the last `flowTrades` trades at least `minBuys` must be buys... */
  flowTrades: number;
  minBuys: number;
  /** ...their net SOL flow must be at least this (lamports, may be negative)... */
  minNetFlow: bigint;
  /** ...and the most recent trade must be a buy (the dip is being bought). */
  lastMustBeBuy: boolean;
  /** The curve must hold at least this much real SOL (lamports) at decision time. */
  minRealSol: bigint;
  /** Lamports per entry tranche (capped by the per-reply size cap). */
  tranche: bigint;
  /** Most lamports committed to one coin (entry + one add). */
  maxPosition: bigint;
  /** Smallest buy worth sending (tx fees are 105k lamports per order). */
  minBuy: bigint;
  /** An add needs the price this far below the first entry price (fraction). */
  addDrop: number;
  /** Most adds per position. */
  maxAdds: number;
  /**
   * The bounce must already have started: the price must sit at least this far
   * above the lowest price of the last `flowTrades` ticks (fraction). Without
   * it the entry catches the knife mid-fall instead of the turn.
   */
  recoverMin: number;
  /** Sell half the position when its gain reaches this (fraction of cost). */
  stage1Gain: number;
  /** Sell the rest when its gain reaches this (fraction of cost). */
  stage2Gain: number;
  /** Sell everything when its gain falls to this (fraction of cost). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After a full exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply. */
  maxEntriesPerBatch: number;
  /** Cash (lamports) never deployed; kept back as a reserve. */
  reserveCash: bigint;
}

// Tuned on the dev window by sweeping a small grid (not a single best point:
// recoverMin 0.04-0.06 is positive throughout, +0.012 to +0.032 SOL): the
// recovery filter is what turns the dip buy from catching a falling knife
// into buying the turn, and the 300-slot hold cap stops the slow bleed. The
// pilot reversion baseline lost ~2.77 SOL and the pilot momentum baseline
// ~9.49 SOL on the same window, so the filters are tight and the size small:
// selectivity over volume.
export const DEFAULT_PARAMS: Params = {
  maxTicks: 40,
  minTicks: 12,
  highTrades: 20,
  highMinAge: 5,
  ddMin: 0.15,
  ddMax: 0.45,
  emaAlpha: 0.08,
  belowEma: 0.06,
  flowTrades: 8,
  minBuys: 5,
  minNetFlow: 0n,
  lastMustBeBuy: true,
  minRealSol: 5_000_000_000n,
  tranche: 250_000_000n,
  maxPosition: 500_000_000n,
  minBuy: 10_000_000n,
  addDrop: 0.08,
  maxAdds: 1,
  recoverMin: 0.05,
  stage1Gain: 0.08,
  stage2Gain: 0.18,
  stopLoss: -0.1,
  maxHoldSlots: 300,
  cooldownSlots: 200,
  buySlippageBps: 500,
  sellSlippageBps: 3000,
  maxEntriesPerBatch: 2,
  reserveCash: 2_000_000_000n,
};

interface Tick {
  slot: number;
  /** virtual SOL / virtual tokens: the marginal price. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Book {
  ticks: Tick[];
  /** EMA of the trade price (0 until the first tick). */
  ema: number;
  /** Price and slot of the first fill decision on the current position. */
  entryPrice: number;
  entrySlot: number;
  /** Lamports committed to buys on this position (sent, filled or not). */
  committed: bigint;
  /** Adds taken on the current position. */
  adds: number;
  /** Stage-1 (half) exit already taken on the current position. */
  stage1Done: boolean;
  /** Slot until which the coin is ignored after a full exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

/** Curve fee: 95 bps protocol + 30 bps creator (the fallback the harness uses). */
const FEE_BPS = 125n;
const BPS = 10_000n;

/** Marginal price from post-trade reserves: SOL per token. */
export function priceOf(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens === 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

/**
 * What selling `tokens` would pay, curve fees deducted, against the reserves
 * the harness marks for the mint (the recorded reserves shifted by our own net
 * flow into the curve). Constant-product: q = tokens * vq / (vt + tokens),
 * capped at the real quote reserves, minus the 1.25% curve fee.
 */
export function liquidationValue(mark: Mark | undefined, tokens: bigint): bigint {
  if (mark === undefined || tokens <= 0n) return 0n;
  const vq = BigInt(mark.virtual_quote_reserves);
  const vt = BigInt(mark.virtual_token_reserves);
  const rq = BigInt(mark.real_quote_reserves);
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/**
 * The per-reply buy cap, with a margin: the harness checks it against the
 * reserves shifted by our own earlier flow on the coin, which can sit a little
 * below the recorded ones the SDK keeps.
 */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/** Buyer flow over the last `n` ticks: buys, net SOL bought, last tick a buy. */
export function flowStats(ticks: Tick[], n: number): { buys: number; net: bigint; lastBuy: boolean } {
  const window = ticks.slice(-n);
  let buys = 0;
  let net = 0n;
  for (const t of window) {
    if (t.isBuy) {
      buys++;
      net += t.sol;
    } else {
      net -= t.sol;
    }
  }
  return { buys, net, lastBuy: window.length > 0 && window[window.length - 1]!.isBuy };
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = {
        ticks: [],
        ema: 0,
        entryPrice: 0,
        entrySlot: -1,
        committed: 0n,
        adds: 0,
        stage1Done: false,
        coolUntil: -1,
        exiting: false,
      };
      books.set(mint, b);
    }
    return b;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      b.ticks.push({ slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (b.ticks.length > p.maxTicks) b.ticks.splice(0, b.ticks.length - p.maxTicks);
      b.ema = b.ema === 0 ? price : b.ema + p.emaAlpha * (price - b.ema);
      if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
    }

    // A position whose sell resolved (or failed) may need another exit attempt.
    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          b.committed = 0n;
          b.entrySlot = -1;
          b.adds = 0;
          b.stage1Done = false;
          b.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        // The opening buy never filled: forget the entry.
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          b.committed = 0n;
          b.entrySlot = -1;
          b.adds = 0;
          b.stage1Done = false;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const marks = new Map<Pubkey, Mark>();
    for (const m of batch.marks) marks.set(m.mint, m);
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);
    // Lamports + tx fees already decided in this reply (pending only updates
    // after the reply is sent, so freeCashLamports alone would overspend).
    let spentThisReply = 0n;
    const afford = (amount: bigint): boolean =>
      state.freeCashLamports() - spentThisReply - amount - tx >= p.reserveCash;

    // 1. Exits and adds on held positions, in sorted mint order (deterministic).
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (b.exiting) continue;
      const value = liquidationValue(marks.get(mint), h.token_amount);
      const ticks = b.ticks;
      const price = ticks.length > 0 ? ticks[ticks.length - 1]!.price : 0;
      const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
      const gain = h.cost_lamports > 0n ? Number(value - h.cost_lamports) / Number(h.cost_lamports) : 0;
      const stale = slot - entrySlot >= p.maxHoldSlots;
      if (gain >= p.stage2Gain || gain <= p.stopLoss || stale) {
        if (pendingMints.has(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        spentThisReply += tx;
        b.exiting = true;
        continue;
      }
      if (!b.stage1Done && gain >= p.stage1Gain) {
        if (pendingMints.has(mint)) continue;
        const half = h.token_amount / 2n;
        if (half > 0n) {
          orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: p.sellSlippageBps });
          spentThisReply += tx;
          b.stage1Done = true;
          b.exiting = true;
        }
        continue;
      }
      // One add while the dip deepens and buyers are still stepping in.
      if (b.stage1Done || b.adds >= p.maxAdds || pendingMints.has(mint)) continue;
      if (b.committed >= p.maxPosition) continue;
      if (b.entryPrice <= 0 || price > b.entryPrice * (1 - p.addDrop)) continue;
      const flow = flowStats(ticks, p.flowTrades);
      if (!flow.lastBuy || flow.buys < p.minBuys) continue;
      let amount = p.maxPosition - b.committed;
      if (amount > p.tranche) amount = p.tranche;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (!afford(amount)) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      spentThisReply += amount + tx;
      b.committed += amount;
      b.adds++;
      pendingMints.add(mint);
    }

    // 2. New entries on coins that traded this slot.
    let entries = 0;
    let open = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = book(mint);
      if (slot < b.coolUntil) continue;
      const ticks = b.ticks;
      if (ticks.length < p.minTicks) continue;
      const last = ticks[ticks.length - 1]!;
      if (last.realSol < p.minRealSol) continue;
      // Recent high over the last `highTrades` ticks, set a while ago.
      let hi = 0;
      let hiAge = 0;
      const start = Math.max(0, ticks.length - p.highTrades);
      for (let i = ticks.length - 1; i >= start; i--) {
        const t = ticks[i]!;
        if (t.price > hi) {
          hi = t.price;
          hiAge = ticks.length - 1 - i;
        }
      }
      if (hi <= 0 || hiAge < p.highMinAge) continue;
      const dd = 1 - last.price / hi;
      if (dd < p.ddMin || dd > p.ddMax) continue;
      // The dip must sit below its own EMA anchor.
      if (b.ema <= 0 || last.price > b.ema * (1 - p.belowEma)) continue;
      // The bounce must already have started: up from the recent trough.
      let trough = Infinity;
      for (let i = ticks.length - p.flowTrades; i < ticks.length; i++) {
        const t = ticks[i]!;
        if (t.price < trough) trough = t.price;
      }
      if (trough === Infinity || last.price < trough * (1 + p.recoverMin)) continue;
      // Buyers still there: mostly buys, net buying, last trade a buy.
      const flow = flowStats(ticks, p.flowTrades);
      if (flow.buys < p.minBuys || flow.net < p.minNetFlow) continue;
      if (p.lastMustBeBuy && !flow.lastBuy) continue;
      let amount = p.tranche;
      if (amount > p.maxPosition) amount = p.maxPosition;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (!afford(amount)) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      spentThisReply += amount + tx;
      b.entryPrice = last.price;
      b.entrySlot = slot;
      b.committed = amount;
      b.adds = 0;
      b.stage1Done = false;
      b.exiting = false;
      pendingMints.add(mint);
      entries++;
      open++;
    }
    return orders;
  };
}
