const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://www.binance.com",
];
const PUSHPLUS = "https://www.pushplus.plus/send";
const FUNDING_THRESHOLD = 0.005;
const PRICE_CHANGE_THRESHOLD = 50;
const NOTIFICATION_INTERVAL_MS = 30 * 60 * 1000;

export async function runExtremeMoveMonitor(env, options = {}) {
  const now = options.now ?? Date.now();
  const sendNotification = options.sendNotification ?? true;
  const previous = (await env.MONITOR_STATE.get("state", "json")) || {};
  const priorModel = previous.extremeMove || {};
  const nextDueAt = Number(priorModel.lastNotificationAt || 0) + NOTIFICATION_INTERVAL_MS;

  if (Number(priorModel.lastNotificationAt || 0) > 0 && now < nextDueAt) {
    return {
      ok: true,
      due: false,
      alerts: 0,
      nextDueAt,
      matches: priorModel.matches || [],
    };
  }

  const [exchangeInfo, tickers, premiums, fundingInfo] = await Promise.all([
    api("/fapi/v1/exchangeInfo"),
    api("/fapi/v1/ticker/24hr"),
    api("/fapi/v1/premiumIndex"),
    api("/fapi/v1/fundingInfo").catch(() => []),
  ]);

  const active = new Set(exchangeInfo.symbols
    .filter((symbol) => symbol.status === "TRADING"
      && symbol.quoteAsset === "USDT"
      && symbol.contractType === "PERPETUAL")
    .map((symbol) => symbol.symbol));
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]));
  const intervalBySymbol = new Map(fundingInfo
    .map((item) => [item.symbol, number(item.fundingIntervalHours) || 8]));

  const matches = premiums
    .filter((premium) => active.has(premium.symbol))
    .map((premium) => {
      const ticker = tickerBySymbol.get(premium.symbol) || {};
      const mark = number(premium.markPrice);
      const index = number(premium.indexPrice);
      return {
        symbol: premium.symbol,
        fundingRate: number(premium.lastFundingRate),
        fundingIntervalHours: intervalBySymbol.get(premium.symbol) || 8,
        nextFundingTime: number(premium.nextFundingTime),
        priceChangePercent24h: number(ticker.priceChangePercent),
        markPrice: mark,
        indexPrice: index,
        basis: index > 0 ? mark / index - 1 : 0,
        quoteVolume: number(ticker.quoteVolume),
      };
    })
    .filter((item) => Math.abs(item.fundingRate) >= FUNDING_THRESHOLD
      && Math.abs(item.priceChangePercent24h) >= PRICE_CHANGE_THRESHOLD)
    .sort((a, b) => {
      const scoreA = Math.abs(a.fundingRate) / FUNDING_THRESHOLD
        + Math.abs(a.priceChangePercent24h) / PRICE_CHANGE_THRESHOLD;
      const scoreB = Math.abs(b.fundingRate) / FUNDING_THRESHOLD
        + Math.abs(b.priceChangePercent24h) / PRICE_CHANGE_THRESHOLD;
      return scoreB - scoreA;
    });

  const checkedAt = new Date(now).toISOString();
  const notification = matches.length ? buildNotification(matches, now) : null;
  const nextModel = {
    lastCheckAt: checkedAt,
    lastNotificationAt: priorModel.lastNotificationAt || null,
    thresholds: {
      absoluteFundingRate: FUNDING_THRESHOLD,
      absolutePriceChangePercent24h: PRICE_CHANGE_THRESHOLD,
      notificationIntervalMinutes: NOTIFICATION_INTERVAL_MS / 60_000,
    },
    matches,
  };

  await env.MONITOR_STATE.put("state", JSON.stringify({
    ...previous,
    extremeMove: nextModel,
  }));

  if (!matches.length) {
    return { ok: true, due: true, alerts: 0, matches: [], checkedAt };
  }

  if (!sendNotification) {
    return { ok: true, due: true, alerts: 1, matches, notification, checkedAt };
  }

  await sendPushPlus(env.PUSHPLUS_TOKEN, notification);
  nextModel.lastNotificationAt = now;
  await env.MONITOR_STATE.put("state", JSON.stringify({
    ...previous,
    extremeMove: nextModel,
  }));

  return {
    ok: true,
    due: true,
    alerts: 1,
    matches,
    notification,
    checkedAt,
    nextDueAt: now + NOTIFICATION_INTERVAL_MS,
  };
}

export function selectExtremeMoves(items) {
  return items.filter((item) => Math.abs(item.fundingRate) >= FUNDING_THRESHOLD
    && Math.abs(item.priceChangePercent24h) >= PRICE_CHANGE_THRESHOLD);
}

function buildNotification(matches, now) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(now));
  const lines = matches.flatMap((item) => [
    `### ${item.symbol}`,
    `- 资金费率：${pct(item.fundingRate)} / ${item.fundingIntervalHours}小时`,
    `- 24小时涨跌幅：${item.priceChangePercent24h.toFixed(2)}%`,
    `- 标记价 / 指数价：${fmt(item.markPrice)} / ${fmt(item.indexPrice)}`,
    `- 标记/指数基差：${pct(item.basis)}`,
    `- 24小时成交额：${formatVolume(item.quoteVolume)} USDT`,
  ]);
  return {
    title: `极端资金费率与涨跌幅提醒（${matches.length}个）`,
    content: [
      `## 极端行情半小时更新`,
      ...lines,
      `- 更新时间：${time}（Asia/Shanghai）`,
      "- 条件：|资金费率| >= 0.5%，且 |24小时涨跌幅| >= 50%。",
      "- 这是行情异常提醒，不代表做多或做空建议，不是订单，也不保证收益。",
    ].join("\n"),
  };
}

async function sendPushPlus(token, notification) {
  if (!token) throw new Error("PUSHPLUS_TOKEN is not configured");
  const response = await fetch(PUSHPLUS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token,
      title: notification.title,
      content: notification.content,
      template: "markdown",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(`PushPlus extreme-move notification failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

async function api(path) {
  const failures = [];
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, {
        headers: { "user-agent": "BinanceExtremeMoveMonitor/1.0" },
      });
      if (response.ok) return await response.json();
      failures.push(`${host}:${response.status}`);
    } catch (error) {
      failures.push(`${host}:${String(error?.message || error)}`);
    }
  }
  throw new Error(`Binance ${path} failed across public hosts (${failures.join(", ")})`);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(value) {
  return `${(value * 100).toFixed(4)}%`;
}

function fmt(value) {
  if (value >= 1000) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  if (value >= 0.01) return value.toFixed(6);
  return value.toPrecision(6);
}

function formatVolume(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  return value.toFixed(0);
}

