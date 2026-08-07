# Binance Funding Monitor

Public GitHub Actions monitor for liquid Binance USD-M USDT perpetuals. Notification credentials remain encrypted in GitHub Actions Secrets and are not stored in this repository.

It ranks the three highest positive and three most-negative funding rates every five minutes, then requires basis, 15m/1h/4h structure, RSI, open interest, positioning, taker flow, and risk/reward confirmation before sending a PushPlus WeChat notification.

It uses public Binance endpoints only and never places orders.

The extreme-move model sends a half-hour update for every TRADING USDT perpetual where both the absolute funding rate is at least 0.5% and the absolute Binance 24-hour move is at least 50%. These updates are labeled as abnormal-market information rather than directional trade signals.

Expected funding carry is included conservatively in risk/reward. The monitor counts at most the next settlement when it falls inside one current funding interval, applies a 60% haircut to the displayed rate, and requires both price-only RR >= 1.5 and combined RR >= 1.8. Funding cannot qualify a structurally weak setup by itself. Alerts show the price-only RR, funding-adjusted RR, funding interval, and estimated carry per 1,000 USDT of position notional. Leverage changes return on margin and liquidation risk, but not the funding paid on the same position notional.

The separate TradFi layer dynamically ranks the three most-liquid Binance chip and storage perpetuals. During the final 90 minutes before the U.S. regular session, it also checks fresh extended-hours equity quotes, WTI oil, geopolitical headlines, multi-timeframe structure, positioning, open interest, and risk/reward. It sends conditional observations only and never submits orders.

The independent overnight lead model runs while the U.S. regular session is closed and sends a separate `overnight` alert type. During premarket and after-hours it requires a fresh equity quote plus Binance/equity gap confirmation. During the fully closed 20:00-04:00 New York window it never treats the stale equity close as a live price; instead it requires fresh Nasdaq futures, two-thirds chip/storage breadth, compatible recent news, Binance multi-timeframe structure, open-interest expansion, positioning and taker-flow confirmation. Fully closed or macro risk-off setups require combined RR >= 2.3. Weekend alerts are disabled.
