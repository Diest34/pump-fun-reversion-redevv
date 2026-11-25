// Local unit tests for the dip-reversion strategy (strategy.ts).
// Run: node --test tests/
// Everything is driven through the real BotState so the strategy sees exactly
// what the harness would send it: a hello, then batches with events, marks,
// fills and an account. No clock, no randomness, no I/O.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotState } from '../vendor/makefun-bot.ts';
import {
  createStrategy,
  DEFAULT_PARAMS,
  flowStats,
  liquidationValue,
  priceOf,
} from '../strategy.ts';
import type { Batch, Hello, OrderInput } from '../vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;
const MINT_A = 'FdfDYUcHRar4ezebmC7dbYvFLjoFK7ceUy5WzHzvpump';
const MINT_B = 'RUNFv5qADCy5zKtALCXwUjFuwspdBaeVwJFBHbWpump';

function makeHello(): Hello {
  return {
    type: 'hello',
    protocol: 'agent-fun/replay/v2',
    seed: '12345',
    universe: {
      program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
      quote: 'SOL',
      mayhem: 'excluded',
      exclude_cashback: true,
      sample: { hash: 'sha256', modulus: 1, residue: 0 },
    },
    capital: { lamports: (10n * SOL).toString() },
    caps: { max_open_positions: 5, max_order_bps_of_real_reserve: 100, max_orders_per_batch: 16, shorts: false, leverage: false },
    latency_slots: 2,
    fees: {
      protocol_bps_fallback: 95,
      creator_bps_fallback: 30,
      base_fee_lamports: '5000',
      priority_fee_lamports: '100000',
      failed_tx_bps: 200,
    },
  };
}

interface TradeSpec {
  mint: string;
  price: number;
  isBuy: boolean;
  sol: bigint;
  realSol?: bigint;
}

function tradeEvent(mint: string, slot: number, spec: TradeSpec): Record<string, unknown> {
  const vt = 1_000_000_000_000n; // 1e12 virtual tokens
  const vq = BigInt(Math.round(spec.price * 1e12));
  const realSol = spec.realSol ?? 10n * SOL;
  return {
    event: 'TradeEvent',
    mint,
    sol_amount: spec.sol.toString(),
    token_amount: '1000000000',
    is_buy: spec.isBuy,
    user: 'E1CrPhVtP9A7XWyAZQacdG5LxZSENRDm2FVrmV3Ndz1Y',
    timestamp: '1793588980',
    virtual_sol_reserves: vq.toString(),
    virtual_token_reserves: vt.toString(),
    real_sol_reserves: realSol.toString(),
    real_token_reserves: '791340161970015',
    fee_recipient: '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ',
    fee_basis_points: '95',
    fee: '0',
    creator: 'E1CrPhVtP9A7XWyAZQacdG5LxZSENRDm2FVrmV3Ndz1Y',
    creator_fee_basis_points: '0',
    creator_fee: '0',
    track_volume: true,
    total_unclaimed_tokens: '0',
    total_claimed_tokens: '0',
    current_sol_volume: '0',
    last_update_timestamp: '1793588980',
    ix_name: 'trade',
    mayhem_mode: false,
    cashback_fee_basis_points: '0',
    cashback: '0',
    buyback_fee_basis_points: '0',
    buyback: '0',
    shareholders: [],
    quote_mint: '11111111111111111111111111111111',
    quote_amount: spec.sol.toString(),
    virtual_quote_reserves: vq.toString(),
    real_quote_reserves: realSol.toString(),
    holder_rewards_bps: '0',
    holder_rewards: '0',
    creator_fee_unclaimed: '0',
    slot,
    signature: `sig-${mint.slice(0, 4)}-${slot}`,
    block_time: 1793588980,
    chain_seq: 0,
  };
}

function markAt(mint: string, slot: number, price: number): Record<string, unknown> {
  const vt = 1_000_000_000_000n;
  const vq = BigInt(Math.round(price * 1e12));
  return {
    mint,
    slot,
    virtual_token_reserves: vt.toString(),
    virtual_quote_reserves: vq.toString(),
    real_token_reserves: '791340161970015',
    real_quote_reserves: (1000n * SOL).toString(),
  };
}

interface AccountSpec {
  cash?: bigint;
  positions?: { mint: string; tokens: bigint; cost: bigint }[];
}

function makeBatch(seq: number, slot: number, opts: {
  events?: Record<string, unknown>[];
  marks?: Record<string, unknown>[];
  fills?: Record<string, unknown>[];
  account?: AccountSpec;
}): Batch {
  const account = opts.account ?? {};
  return {
    type: 'batch',
    seq,
    slot,
    events: (opts.events ?? []) as never,
    marks: (opts.marks ?? []) as never,
    fills: (opts.fills ?? []) as never,
    account: {
      cash_lamports: (account.cash ?? 10n * SOL).toString(),
      positions: (account.positions ?? []).map((p) => ({
        mint: p.mint,
        token_amount: p.tokens.toString(),
        cost_lamports: p.cost.toString(),
      })),
    },
  };
}

/** A 25-tick dip sequence: 10 ticks flat at 100, a slide to 60, then buys recovering to 65. */
function dipEvents(mint: string, slot: number): Record<string, unknown>[] {
  const specs: TradeSpec[] = [];
  for (let i = 0; i < 10; i++) specs.push({ mint, price: 100, isBuy: true, sol: 200_000_000n });
  for (const p of [95, 88, 80, 72, 66, 62, 60]) {
    specs.push({ mint, price: p, isBuy: false, sol: 50_000_000n });
  }
  for (const p of [61, 62, 63, 64, 65, 66, 67, 68]) {
    specs.push({ mint, price: p, isBuy: true, sol: 200_000_000n });
  }
  return specs.map((s) => tradeEvent(mint, slot, s));
}

/** Drive one batch through a fresh BotState + strategy; returns the orders. */
function step(state: BotState, onBatch: (s: BotState, b: Batch) => OrderInput[], batch: Batch): OrderInput[] {
  state.applyBatch(batch);
  return onBatch(state, batch);
}

test('priceOf and liquidationValue match the constant-product math', () => {
  assert.equal(priceOf(30000000000n, 1073000000000000n), 30000000000 / 1073000000000000);
  const mark = {
    mint: MINT_A,
    slot: 1,
    virtual_token_reserves: '1000000000000',
    virtual_quote_reserves: '100000000000',
    real_token_reserves: '1000000000000',
    real_quote_reserves: '1000000000000',
  };
  // Selling 10% of the virtual tokens: q = 1e11 * 1e11 / 1.1e12 = 9090909090, minus 1.25% fee.
  const value = liquidationValue(mark, 100_000_000_000n);
  const q = (100_000_000_000n * 100_000_000_000n) / (1_000_000_000_000n + 100_000_000_000n);
  assert.equal(value, q - (q * 125n + 10_000n - 1n) / 10_000n);
  assert.equal(liquidationValue(undefined, 100n), 0n);
  assert.equal(liquidationValue(mark, 0n), 0n);
});

test('flowStats counts buys and net SOL over the window', () => {
  const ticks = [
    { slot: 1, price: 100, realSol: 1n, isBuy: true, sol: 5n },
    { slot: 2, price: 99, realSol: 1n, isBuy: false, sol: 2n },
    { slot: 3, price: 98, realSol: 1n, isBuy: true, sol: 3n },
  ];
  const f = flowStats(ticks, 3);
  assert.equal(f.buys, 2);
  assert.equal(f.net, 6n);
  assert.equal(f.lastBuy, true);
});

test('entry fires on a deep dip with buyer flow, sized to the buy cap', () => {
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const orders = step(state, onBatch, makeBatch(1, 1000, { events: dipEvents(MINT_A, 1000) }));
  assert.equal(orders.length, 1);
  const buy = orders[0]!;
  assert.equal(buy.side, 'buy');
  assert.equal(buy.mint, MINT_A);
  // 97% of 1% of 10 SOL real reserves = 0.097 SOL, under the 0.25 SOL tranche.
  assert.equal(buy.quote_lamports, 97_000_000n);
  assert.equal(buy.max_slippage_bps, 500);
});

test('no entry when the dip is shallow', () => {
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const specs: TradeSpec[] = [];
  for (let i = 0; i < 12; i++) specs.push({ mint: MINT_A, price: 100, isBuy: true, sol: 200_000_000n });
  for (const p of [96, 94, 93, 92]) specs.push({ mint: MINT_A, price: p, isBuy: true, sol: 200_000_000n });
  const orders = step(state, onBatch, makeBatch(1, 1000, {
    events: specs.map((s) => tradeEvent(MINT_A, 1000, s)),
  }));
  assert.equal(orders.length, 0); // 8% drawdown is under the 15% minimum
});

test('no entry when the last trade is a sell (no buyers stepping in)', () => {
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const events = dipEvents(MINT_A, 1000);
  // Flip the last tick to a sell.
  (events[events.length - 1] as Record<string, unknown>).is_buy = false;
  const orders = step(state, onBatch, makeBatch(1, 1000, { events }));
  assert.equal(orders.length, 0);
});

test('no entry on a thin curve (real SOL under the minimum)', () => {
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const specs: TradeSpec[] = [];
  for (let i = 0; i < 10; i++) specs.push({ mint: MINT_A, price: 100, isBuy: true, sol: 200_000_000n, realSol: 2n * SOL });
  for (const p of [90, 80, 70, 65]) specs.push({ mint: MINT_A, price: p, isBuy: true, sol: 200_000_000n, realSol: 2n * SOL });
  const orders = step(state, onBatch, makeBatch(1, 1000, {
    events: specs.map((s) => tradeEvent(MINT_A, 1000, s)),
  }));
  assert.equal(orders.length, 0);
});

test('stage-1 exit sells half at +8..18% gain; stop sells all at -10%', () => {
  // Tokens consistent with the entry: cost / entry price (SOL per token).
  const entryPrice = 68;
  const cost = 97_000_000n;
  const tokens = cost / BigInt(entryPrice);
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  // Enter first.
  const entered = step(state, onBatch, makeBatch(1, 1000, { events: dipEvents(MINT_A, 1000) }));
  assert.equal(entered.length, 1);
  // Simulate the buy filling: the position now exists at the entry price.
  const wire = state.toOrders(entered);
  state.recordOrders(wire);
  const account = { cash: 10n * SOL - cost, positions: [{ mint: MINT_A, tokens, cost }] };
  // Find a price whose liquidation gain sits between +9% and +15%.
  let target: number | null = null;
  for (let p = entryPrice * 1.05; p < entryPrice * 3; p *= 1.01) {
    const m = markAt(MINT_A, 1001, p) as never;
    const gain = Number(liquidationValue(m, tokens) - cost) / Number(cost);
    if (gain >= 0.09 && gain < 0.15) {
      target = p;
      break;
    }
  }
  assert.ok(target !== null, 'found a +9..15% price');
  const stage1 = step(state, onBatch, makeBatch(2, 1001, {
    events: [tradeEvent(MINT_A, 1001, { mint: MINT_A, price: target, isBuy: true, sol: 100_000_000n })],
    marks: [markAt(MINT_A, 1001, target)],
    fills: [{ client_id: wire[0]!.client_id, mint: MINT_A, side: 'buy', status: 'filled', reason: null, decided_slot: 1000, slot: 1001, quote_lamports: cost.toString(), token_amount: tokens.toString(), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false }],
    account,
  }));
  assert.equal(stage1.length, 1);
  assert.equal(stage1[0]!.side, 'sell');
  assert.equal(stage1[0]!.token_amount, tokens / 2n);

  // Now a hard fall: liquidation gain under -10% sells everything.
  const state2 = new BotState(makeHello());
  const onBatch2 = createStrategy(DEFAULT_PARAMS);
  const entered2 = step(state2, onBatch2, makeBatch(1, 1000, { events: dipEvents(MINT_A, 1000) }));
  const wire2 = state2.toOrders(entered2);
  state2.recordOrders(wire2);
  let stopPrice: number | null = null;
  for (let p = entryPrice; p > entryPrice * 0.3; p *= 0.99) {
    const m = markAt(MINT_A, 1001, p) as never;
    const gain = Number(liquidationValue(m, tokens) - cost) / Number(cost);
    if (gain <= -0.11) {
      stopPrice = p;
      break;
    }
  }
  assert.ok(stopPrice !== null, 'found a -11% price');
  const stopped = step(state2, onBatch2, makeBatch(2, 1001, {
    events: [tradeEvent(MINT_A, 1001, { mint: MINT_A, price: stopPrice, isBuy: false, sol: 100_000_000n })],
    marks: [markAt(MINT_A, 1001, stopPrice)],
    fills: [{ client_id: wire2[0]!.client_id, mint: MINT_A, side: 'buy', status: 'filled', reason: null, decided_slot: 1000, slot: 1001, quote_lamports: cost.toString(), token_amount: tokens.toString(), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false }],
    account,
  }));
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]!.side, 'sell');
  assert.equal(stopped[0]!.token_amount, tokens);
});

test('cooldown blocks re-entry for 200 slots after a full exit', () => {
  const tokens = 1_000_000_000_000n;
  const cost = 97_000_000n;
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const entered = step(state, onBatch, makeBatch(1, 1000, { events: dipEvents(MINT_A, 1000) }));
  assert.equal(entered.length, 1);
  const wire = state.toOrders(entered);
  state.recordOrders(wire);
  // Full exit fills at slot 1001: sell everything, position gone.
  const exited = step(state, onBatch, makeBatch(2, 1001, {
    events: [tradeEvent(MINT_A, 1001, { mint: MINT_A, price: 200, isBuy: true, sol: 100_000_000n })],
    marks: [markAt(MINT_A, 1001, 200)],
    fills: [
      { client_id: wire[0]!.client_id, mint: MINT_A, side: 'buy', status: 'filled', reason: null, decided_slot: 1000, slot: 1001, quote_lamports: cost.toString(), token_amount: tokens.toString(), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false },
      { client_id: 'o9', mint: MINT_A, side: 'sell', status: 'filled', reason: null, decided_slot: 1001, slot: 1001, quote_lamports: '200000000', token_amount: tokens.toString(), fee_lamports: '0', tx_fee_lamports: '105000', fee_fallback: false },
    ],
    account: { cash: 10n * SOL, positions: [] },
  }));
  assert.equal(exited.length, 0);
  // Same dip 100 slots later: still cooling down.
  const tooSoon = step(state, onBatch, makeBatch(3, 1100, { events: dipEvents(MINT_A, 1100) }));
  assert.equal(tooSoon.length, 0);
  // 250 slots later: the dip is tradeable again.
  const later = step(state, onBatch, makeBatch(4, 1251, { events: dipEvents(MINT_A, 1251) }));
  assert.equal(later.length, 1);
  assert.equal(later[0]!.side, 'buy');
});

test('determinism: the same batch sequence yields identical orders twice', () => {
  const run = (): OrderInput[][] => {
    const state = new BotState(makeHello());
    const onBatch = createStrategy(DEFAULT_PARAMS);
    const out: OrderInput[][] = [];
    out.push(step(state, onBatch, makeBatch(1, 1000, { events: [...dipEvents(MINT_A, 1000), ...dipEvents(MINT_B, 1000)] })));
    out.push(step(state, onBatch, makeBatch(2, 1001, {
      events: [
        tradeEvent(MINT_A, 1001, { mint: MINT_A, price: 75, isBuy: true, sol: 100_000_000n }),
        tradeEvent(MINT_B, 1001, { mint: MINT_B, price: 70, isBuy: true, sol: 100_000_000n }),
      ],
      marks: [markAt(MINT_A, 1001, 75), markAt(MINT_B, 1001, 70)],
      account: { cash: 10n * SOL, positions: [] },
    })));
    out.push(step(state, onBatch, makeBatch(3, 1002, {
      events: [tradeEvent(MINT_A, 1002, { mint: MINT_A, price: 80, isBuy: true, sol: 100_000_000n })],
      marks: [markAt(MINT_A, 1002, 80)],
      account: { cash: 10n * SOL, positions: [] },
    })));
    return out;
  };
  const a = run();
  const b = run();
  const stringify = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
  assert.equal(stringify(a), stringify(b));
  assert.ok(a.flat().length > 0, 'the sequence produces at least one order');
});

test('reply never exceeds the batch order cap, even with many tradeable coins', () => {
  const state = new BotState(makeHello());
  const onBatch = createStrategy(DEFAULT_PARAMS);
  const mints: string[] = [];
  for (let i = 0; i < 30; i++) {
    // Deterministic pseudo-mints (base58-ish, 43-44 chars).
    mints.push(`${'A'.repeat(40)}${String(i).padStart(3, '0')}pump`);
  }
  const events = mints.flatMap((m) => dipEvents(m, 1000));
  const orders = step(state, onBatch, makeBatch(1, 1000, { events }));
  assert.ok(orders.length <= 16, `orders ${orders.length} over the 16 cap`);
  assert.ok(orders.length <= DEFAULT_PARAMS.maxEntriesPerBatch, 'entries per batch capped');
  for (const o of orders) {
    assert.equal(o.side, 'buy');
    assert.ok(BigInt(o.quote_lamports as string) >= DEFAULT_PARAMS.minBuy);
  }
});
