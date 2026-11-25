# Pump.fun Dip-Reversion Paper Bot

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Diest34/pump-fun-reversion-redevv/rank.svg)
![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Diest34/pump-fun-reversion-redevv/reward.svg)

A paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun). It trades 10 SOL of paper money over a 24-hour replay of recorded pump.fun bonding-curve activity, ranked by net PnL.

Referral code: `y12bs3e6`

## Strategy — dip-reversion with an EMA anchor

Pump.fun coins that fall fast usually keep falling, so a dip buy only works when buyers are already absorbing the fall and the dip is deep enough to be a real dislocation but not a collapse:

- **Entry:** the price has fallen 15–45% from its recent high (measured over the last 20 trades, high set at least 5 trades ago), sits at least 6% below its own trade-count EMA, and buyer flow is present — at least 5 of the last 8 trades are buys, net buy SOL is non-negative, and the last trade is a buy. The curve must hold at least 5 SOL of real reserves. Never chase a vertical spike: entries only happen after a drop.
- **Size:** 0.25 SOL per entry (capped at 97% of the per-reply buy cap), one 0.25 SOL add if the price falls a further 8% below entry while buyers are still stepping in. Max 0.5 SOL per coin, max 5 open positions, 2 SOL cash always held back.
- **Exits:** sell half at +8% vs entry, sell the rest at +18%, stop out at −10%, or exit after 300 slots held. A 200-slot cooldown follows every full exit.
- **Determinism:** the bot is a pure function of the `hello` / `batch` stream the harness sends — no clock, no unseeded randomness, no I/O — so its two graded executions produce byte-identical action logs. Orders decided on the `batch` for a `slot` fill two slots later, as the protocol specifies.

## Layout

- `main.ts` — entrypoint: wires `runBot({ onBatch })` from the strategy.
- `strategy.ts` — all strategy logic (pure function of batches; see `createStrategy` and `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied unchanged.
- `tests/strategy.test.ts` — local unit tests for the strategy logic.

## Run locally

```sh
node --test tests/
```

Grade on the dev window with the kit CLI (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## License

MIT — see [LICENSE](LICENSE).
