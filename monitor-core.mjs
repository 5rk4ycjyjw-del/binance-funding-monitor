const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://www.binance.com",
  "https://api.binance.com",
  "https://binance.com",
];
const BINANCE = BINANCE_HOSTS[0];
const PUSHPLUS = "https://www.pushplus.plus/send";
const MIN_QUOTE_VOLUME = 50_000_000;
const COOLDOWN_MS = 60 * 60 * 1000;
const FEE_SLIPPAGE_RATE = 0.0012;

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runMonitor(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "binance-funding-monitor" });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      if (!env.RUN_SECRET || request.headers.get("authorization") !== `Bearer ${env.RUN_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        return Response.json(await runMonitor(env));
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
      }
    }
    if (url.pathname === "/probe" && request.method === "POST") {
      if (!env.RUN_SECRET || request.headers.get("authorization") !== `Bearer ${env.RUN_SECRET}`) {
        return new Response("Unauthorized", { status: 401 });
      }
      const results = [];
      for (const host of BINANCE_HOSTS) {
        const response = await fetch(`${host}/fapi/v1/time`, {
          headers: {
            accept: "application/json",
            origin: "https://www.binance.com",
            referer: "https://www.binance.com/",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          },
        }).catch(() => null);
        results.push({ host, status: response?.status || 0 });
      }
      return Response.json(results);
    }
    return new Response("Not found", { status: 404 });
  },
};

async function runMonitor(env) {
  const startedAt = Date.now();
  const previous = (await env.MONITOR_STATE.get("state", "json")) || { alerts: {} };

  try {
    const [exchangeInfo, tickers, premiums, fundingInfo] = await Promise.all([
      api("/fapi/v1/exchangeInfo"),
      api("/fapi/v1/ticker/24hr"),
      api("/fapi/v1/premiumIndex"),
      api("/fapi/v1/fundingInfo").catch(() => []),
    ]);

    const active = new Set(
      exchangeInfo.symbols
        .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.contractType === "PERPETUAL")
        .map((s) => s.symbol),
    );
    const volumeBySymbol = new Map(tickers.map((x) => [x.symbol, number(x.quoteVolume)]));
    const intervalBySymbol = new Map(fundingInfo.map((x) => [x.symbol, number(x.fundingIntervalHours) || 8]));

    const liquid = premiums
      .filter((x) => active.has(x.symbol) && volumeBySymbol.get(x.symbol) >= MIN_QUOTE_VOLUME)
      .map((x) => ({
        symbol: x.symbol,
        funding: number(x.lastFundingRate),
        mark: number(x.markPrice),
        index: number(x.indexPrice),
        basis: number(x.indexPrice) ? (number(x.markPrice) / number(x.indexPrice)) - 1 : 0,
        volume: volumeBySymbol.get(x.symbol),
        fundingIntervalHours: intervalBySymbol.get(x.symbol) || 8,
      }));

    const positive = liquid.filter((x) => x.funding > 0).sort((a, b) => b.funding - a.funding).slice(0, 3);
    const negative = liquid.filter((x) => x.funding < 0).sort((a, b) => a.funding - b.funding).slice(0, 3);
    const candidates = [
      ...positive.map((x) => ({ ...x, side: "SHORT" })),
      ...negative.map((x) => ({ ...x, side: "LONG" })),
    ];

    const analyses = [];
    for (const candidate of candidates) {
      analyses.push(await analyze(candidate));
    }
    const now = Date.now();
    const alerts = { ...(previous.alerts || {}) };
    const qualified = [];

    for (const result of analyses.filter((item) => item && item.qualified)) {
      const key = `${result.symbol}:${result.side}`;
      const old = alerts[key];
      const materialChange = old && Math.abs(result.entry - old.entry) / result.entry >= 0.008;
      if (old && now - old.timestamp < COOLDOWN_MS && !materialChange) continue;
      alerts[key] = { timestamp: now, entry: result.entry, trigger: result.trigger };
      qualified.push(result);
    }

    const state = {
      lastRun: new Date(now).toISOString(),
      durationMs: Date.now() - startedAt,
      rankings: {
        positive: positive.map(compactCandidate),
        negative: negative.map(compactCandidate),
      },
      analyses: analyses.map((x, index) => x || {
        symbol: candidates[index].symbol,
        side: candidates[index].side,
        qualified: false,
      }),
      alerts,
    };

    await env.MONITOR_STATE.put("state", JSON.stringify(state));

    for (const signal of qualified) {
      await sendPushPlus(env.PUSHPLUS_TOKEN, signal);
    }

    return { ok: true, checked: candidates.length, alerts: qualified.length };
  } catch (error) {
    await env.MONITOR_STATE.put("state", JSON.stringify({
      ...previous,
      lastRun: new Date().toISOString(),
      lastError: String(error && error.message ? error.message : error),
    }));
    throw error;
  }
}

async function analyze(candidate) {
  const symbol = encodeURIComponent(candidate.symbol);
  const requests = [
    api(`/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=120`),
    api(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=120`),
    api(`/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=120`),
    api(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=7`),
  ];
  const settled = [
    ...await Promise.allSettled(requests.slice(0, 6)),
    ...await Promise.allSettled(requests.slice(6)),
  ];
  if (settled.some((x) => x.status !== "fulfilled")) return null;

  const [raw15m, raw1h, raw4h, oiRaw, globalRaw, topRaw, takerRaw] = settled.map((x) => x.value);
  const bars15 = candles(raw15m);
  const bars1h = candles(raw1h);
  const bars4h = candles(raw4h);
  if ([bars15, bars1h, bars4h].some((x) => x.length < 60) || oiRaw.length < 2) return null;

  const m15 = indicators(bars15);
  const h1 = indicators(bars1h);
  const h4 = indicators(bars4h);
  const current = m15.close;
  const oiChange = change(number(oiRaw[0].sumOpenInterest), number(oiRaw.at(-1).sumOpenInterest));
  const globalRatio = number(globalRaw.at(-1)?.longShortRatio);
  const topRatio = number(topRaw.at(-1)?.longShortRatio);
  const takerRatio = number(takerRaw.at(-1)?.buySellRatio);
  const prior15 = bars15.slice(-22, -2);
  const last = bars15.at(-1);
  const previous = bars15.at(-2);
  const priorHigh = Math.max(...prior15.map((x) => x.high));
  const priorLow = Math.min(...prior15.map((x) => x.low));

  const longSetup = candidate.side === "LONG";
  const trendAligned = longSetup
    ? h4.ema20 > h4.ema50 && h1.ema20 > h1.ema50
    : h4.ema20 < h4.ema50 && h1.ema20 < h1.ema50;
  const rsiUsable = longSetup
    ? h1.rsi >= 42 && h1.rsi <= 68 && m15.rsi >= 45 && m15.rsi <= 70
    : h1.rsi >= 32 && h1.rsi <= 58 && m15.rsi >= 30 && m15.rsi <= 55;
  const confirmation = longSetup
    ? (last.close > priorHigh || (previous.low <= m15.ema20 && last.close > m15.ema20 && last.close > previous.high))
    : (last.close < priorLow || (previous.high >= m15.ema20 && last.close < m15.ema20 && last.close < previous.low));
  const basisSupports = longSetup ? candidate.basis < -0.00005 : candidate.basis > 0.00005;
  const positioningSupports = longSetup
    ? globalRatio <= 0.95 && topRatio <= 1.02 && takerRatio >= 1.04
    : globalRatio >= 1.05 && topRatio >= 0.98 && takerRatio <= 0.96;
  const oiSupports = oiChange >= 0.0025;
  const abnormalFunding = Math.abs(candidate.funding) >= 0.0003;

  const swingHigh = Math.max(...bars15.slice(-12).map((x) => x.high));
  const swingLow = Math.min(...bars15.slice(-12).map((x) => x.low));
  const stop = longSetup
    ? Math.min(swingLow, current - 1.15 * m15.atr)
    : Math.max(swingHigh, current + 1.15 * m15.atr);
  const risk = Math.abs(current - stop);
  const structureTarget = longSetup
    ? Math.max(...bars1h.slice(-48).map((x) => x.high))
    : Math.min(...bars1h.slice(-48).map((x) => x.low));
  const grossReward = longSetup ? structureTarget - current : current - structureTarget;
  const netReward = grossReward - current * FEE_SLIPPAGE_RATE;
  const netRisk = risk + current * FEE_SLIPPAGE_RATE;
  const rr = netRisk > 0 ? netReward / netRisk : 0;

  const qualified = abnormalFunding && basisSupports && trendAligned && rsiUsable && confirmation
    && positioningSupports && oiSupports && rr >= 1.8;

  if (!qualified) {
    return {
      symbol: candidate.symbol,
      side: candidate.side,
      qualified: false,
      funding: candidate.funding,
      basis: candidate.basis,
      oiChange,
      globalRatio,
      topRatio,
      takerRatio,
      rr,
      checks: { abnormalFunding, basisSupports, trendAligned, rsiUsable, confirmation, positioningSupports, oiSupports },
    };
  }

  const target1 = structureTarget;
  const target2 = longSetup ? current + 3 * risk : current - 3 * risk;
  return {
    symbol: candidate.symbol,
    side: candidate.side,
    qualified: true,
    entry: current,
    entryLow: longSetup ? current - 0.12 * m15.atr : current - 0.05 * m15.atr,
    entryHigh: longSetup ? current + 0.05 * m15.atr : current + 0.12 * m15.atr,
    stop,
    target1,
    target2,
    funding: candidate.funding,
    fundingIntervalHours: candidate.fundingIntervalHours,
    basis: candidate.basis,
    oiChange,
    rr,
    trigger: longSetup ? "15分钟突破或回踩企稳" : "15分钟跌破或反抽受阻",
    reason: longSetup
      ? "负资金费率拥挤，趋势转强且持仓量、主动买盘确认"
      : "正资金费率拥挤，趋势转弱且持仓量、主动卖盘确认",
  };
}

async function sendPushPlus(token, signal) {
  if (!token) throw new Error("PUSHPLUS_TOKEN is not configured");
  const direction = signal.side === "LONG" ? "做多" : "做空";
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date());
  const content = [
    `### ${signal.symbol} 条件交易机会：${direction}`,
    `- 触发：${signal.trigger}`,
    `- 参考入场：${fmt(signal.entryLow)} - ${fmt(signal.entryHigh)}`,
    `- 止损：${fmt(signal.stop)}（以标记价格触发）`,
    `- 止盈1：${fmt(signal.target1)}`,
    `- 止盈2：${fmt(signal.target2)}`,
    `- 资金费率：${pct(signal.funding)} / ${signal.fundingIntervalHours}小时`,
    `- 30分钟持仓量变化：${pct(signal.oiChange)}`,
    `- 首目标预估盈亏比：${signal.rr.toFixed(2)}`,
    `- 时间：${time}（Asia/Shanghai）`,
    `- 原因：${signal.reason}`,
    "",
    "这是条件观察信号，不是订单或收益保证；合约风险高，请自行确认后操作。",
  ].join("\n");
  const response = await fetch(PUSHPLUS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, title: `${signal.symbol} ${direction}条件机会`, content, template: "markdown" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(`PushPlus failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

async function api(path) {
  const response = await fetch(`${BINANCE}${path}`, {
    headers: { "user-agent": "BinanceFundingMonitor/1.0" },
  });
  if (!response.ok) throw new Error(`Binance ${path} returned ${response.status}`);
  return response.json();
}

function candles(rows) {
  return rows.slice(0, -1).map((x) => ({
    open: number(x[1]), high: number(x[2]), low: number(x[3]), close: number(x[4]), volume: number(x[5]),
  }));
}

function indicators(bars) {
  const closes = bars.map((x) => x.close);
  return {
    close: closes.at(-1),
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    rsi: rsi(closes, 14),
    atr: atr(bars, 14),
  };
}

function ema(values, period) {
  const multiplier = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (const next of values.slice(period)) value = next * multiplier + value * (1 - multiplier);
  return value;
}

function rsi(values, period) {
  let gain = 0;
  let loss = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function atr(bars, period) {
  const ranges = [];
  for (let i = bars.length - period; i < bars.length; i += 1) {
    const previousClose = bars[i - 1].close;
    ranges.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - previousClose),
      Math.abs(bars[i].low - previousClose),
    ));
  }
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

function compactCandidate(x) {
  return { symbol: x.symbol, funding: x.funding, basis: x.basis, volume: x.volume, fundingIntervalHours: x.fundingIntervalHours };
}

function change(first, last) {
  return first ? (last / first) - 1 : 0;
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

export { runMonitor };

