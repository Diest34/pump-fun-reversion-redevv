// Pump.fun Replay Sprint — dip-reversion paper bot (see strategy.ts).
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored byte
// for byte in vendor/. The bot is a pure function of the hello/batch stream
// the harness sends: no clock, no randomness, no I/O.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
