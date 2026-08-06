# Binance Funding Monitor

Public GitHub Actions monitor for liquid Binance USD-M USDT perpetuals. Notification credentials remain encrypted in GitHub Actions Secrets and are not stored in this repository.

It ranks the three highest positive and three most-negative funding rates every five minutes, then requires basis, 15m/1h/4h structure, RSI, open interest, positioning, taker flow, and risk/reward confirmation before sending a PushPlus WeChat notification.

It uses public Binance endpoints only and never places orders.

The separate TradFi layer dynamically ranks the three most-liquid Binance chip and storage perpetuals. During the final 90 minutes before the U.S. regular session, it also checks fresh extended-hours equity quotes, WTI oil, geopolitical headlines, multi-timeframe structure, positioning, open interest, and risk/reward. It sends conditional observations only and never submits orders.
