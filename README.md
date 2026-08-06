# Binance Funding Monitor

Private GitHub Actions monitor for liquid Binance USD-M USDT perpetuals.

It ranks the three highest positive and three most-negative funding rates every five minutes, then requires basis, 15m/1h/4h structure, RSI, open interest, positioning, taker flow, and risk/reward confirmation before sending a PushPlus WeChat notification.

It uses public Binance endpoints only and never places orders.

