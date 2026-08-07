const BINANCE_HOSTS = [
  "https://fapi.binance.com",
  "https://fapi1.binance.com",
  "https://fapi2.binance.com",
  "https://fapi3.binance.com",
  "https://www.binance.com",
  "https://api.binance.com",
];
const PUSHPLUS = "https://www.pushplus.plus/send";
const MIN_QUOTE_VOLUME = 50_000_000;
const FEE_SLIPPAGE_RATE = 0.0012;
const COOLDOWN_MS = 60 * 60 * 1000;
const FUNDING_HAIRCUT = 0.6;
const MIN_PRICE_RR = 1.5;
const MIN_COMBINED_RR = 1.8;

const CHIP_AND_STORAGE = new Map([
  ["NVDAUSDT", "NVDA"], ["AMDUSDT", "AMD"], ["AVGOUSDT", "AVGO"],
  ["TSMUSDT", "TSM"], ["INTCUSDT", "INTC"], ["QCOMUSDT", "QCOM"],
  ["ARMUSDT", "ARM"], ["ASMLUSDT", "ASML"], ["MRVLUSDT", "MRVL"],
  ["AMATUSDT", "AMAT"], ["LRCXUSDT", "LRCX"], ["SMHUSDT", "SMH"],
  ["MUUSDT", "MU"], ["SNDKUSDT", "SNDK"], ["WDCUSDT", "WDC"],
]);

export async function runTradifiMonitor(env) {
  const previous = (await env.MONITOR_STATE.get("state", "json")) || { alerts: {} };
  if (!isUsPremarket(new Date())) {
    const now = new Date().toISOString();
    await env.MONITOR_STATE.put("state", JSON.stringify({
      ...previous,
      tradifi: { lastRun: now, active: false, skipped: "outside_us_premarket", rankings: [], analyses: [] },
    }));
    return { ok: true, checked: 0, alerts: 0, skipped: "outside_us_premarket" };
  }
  const [exchangeInfo, tickers, premiums, fundingInfo, macro] = await Promise.all([
    api("/fapi/v1/exchangeInfo"),
    api("/fapi/v1/ticker/24hr"),
    api("/fapi/v1/premiumIndex"),
    api("/fapi/v1/fundingInfo").catch(() => []),
    loadMacroContext(),
  ]);

  const active = new Set(exchangeInfo.symbols
    .filter((x) => x.status === "TRADING" && x.contractType === "TRADIFI_PERPETUAL" && x.quoteAsset === "USDT")
    .map((x) => x.symbol));
  const tickerBySymbol = new Map(tickers.map((x) => [x.symbol, x]));
  const premiumBySymbol = new Map(premiums.map((x) => [x.symbol, x]));
  const intervalBySymbol = new Map(fundingInfo.map((x) => [x.symbol, number(x.fundingIntervalHours) || 8]));

  const top = [...CHIP_AND_STORAGE]
    .filter(([symbol]) => active.has(symbol))
    .map(([symbol, equityTicker]) => {
      const ticker = tickerBySymbol.get(symbol) || {};
      const premium = premiumBySymbol.get(symbol) || {};
      return {
        symbol,
        equityTicker,
        volume: number(ticker.quoteVolume),
        change24h: number(ticker.priceChangePercent) / 100,
        mark: number(premium.markPrice),
        index: number(premium.indexPrice),
        funding: number(premium.lastFundingRate),
        fundingIntervalHours: intervalBySymbol.get(symbol) || 8,
        nextFundingTime: number(premium.nextFundingTime),
      };
    })
    .filter((x) => x.volume >= MIN_QUOTE_VOLUME && x.mark > 0 && x.index > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 3);

  const analyses = await Promise.all(top.map((candidate) => analyze(candidate, macro)));
  const now = Date.now();
  const alerts = { ...(previous.alerts || {}) };
  const qualified = [];

  for (const result of analyses.filter((x) => x.qualified)) {
    const key = `tradifi:${result.symbol}:${result.side}`;
    const old = alerts[key];
    const materiallyChanged = old && Math.abs(result.entry - old.entry) / result.entry >= 0.008;
    if (old && now - old.timestamp < COOLDOWN_MS && !materiallyChanged) continue;
    alerts[key] = {
      timestamp: now,
      symbol: result.symbol,
      direction: result.side,
      trigger: result.trigger,
      entry: result.entry,
      entryZone: [result.entryLow, result.entryHigh],
      markPriceStop: result.stop,
      targets: [result.target1, result.target2],
      metrics: {
        funding: result.funding,
        fundingIntervalHours: result.fundingIntervalHours,
        nextFundingTime: result.nextFundingTime,
        conservativeFundingCarryRate: result.fundingCarryRate,
        priceRr: result.priceRr,
        rrWithFunding: result.rrWithFunding,
        basis: result.basis,
        equityGap: result.equityGap,
        oiChange: result.oiChange,
        globalRatio: result.globalRatio,
        topRatio: result.topRatio,
        takerRatio: result.takerRatio,
      },
      invalidation: "mark_price_reaches_stop_or_entry_confirmation_fails_before_entry",
    };
    qualified.push(result);
  }

  const state = {
    ...previous,
    lastRun: new Date(now).toISOString(),
    alerts,
    tradifi: {
      lastRun: new Date(now).toISOString(),
      macro,
      rankings: top.map(compact),
      analyses,
    },
  };
  await env.MONITOR_STATE.put("state", JSON.stringify(state));

  for (const signal of qualified) await sendPushPlus(env.PUSHPLUS_TOKEN, signal);
  return { ok: true, checked: top.length, alerts: qualified.length, top: top.map((x) => x.symbol) };
}

async function analyze(candidate, macro) {
  const symbol = encodeURIComponent(candidate.symbol);
  const [raw15m, raw1h, raw4h, oiRaw, globalRaw, topRaw, takerRaw, equity] = await Promise.all([
    api(`/fapi/v1/klines?symbol=${symbol}&interval=15m&limit=120`),
    api(`/fapi/v1/klines?symbol=${symbol}&interval=1h&limit=120`),
    api(`/fapi/v1/klines?symbol=${symbol}&interval=4h&limit=120`),
    api(`/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=5m&limit=7`),
    api(`/futures/data/takerlongshortRatio?symbol=${symbol}&period=5m&limit=7`),
    loadEquityQuote(candidate.equityTicker),
  ]);

  const bars15 = candles(raw15m);
  const bars1h = candles(raw1h);
  const bars4h = candles(raw4h);
  if ([bars15, bars1h, bars4h].some((x) => x.length < 60) || oiRaw.length < 2) {
    return { symbol: candidate.symbol, qualified: false, reason: "insufficient_data" };
  }

  const m15 = indicators(bars15);
  const h1 = indicators(bars1h);
  const h4 = indicators(bars4h);
  const current = m15.close;
  const basis = candidate.index ? candidate.mark / candidate.index - 1 : 0;
  const oiChange = change(number(oiRaw[0]?.sumOpenInterest), number(oiRaw.at(-1)?.sumOpenInterest));
  const globalRatio = number(globalRaw.at(-1)?.longShortRatio);
  const topRatio = number(topRaw.at(-1)?.longShortRatio);
  const takerRatio = number(takerRaw.at(-1)?.buySellRatio);
  const equityGap = equity?.price ? current / equity.price - 1 : null;
  const equityFresh = equity && Date.now() - equity.timestamp <= 15 * 60 * 1000;
  const premarket = isUsPremarket(new Date());

  const side = h4.ema20 >= h4.ema50 && h1.ema20 > h1.ema50 ? "LONG"
    : h4.ema20 <= h4.ema50 && h1.ema20 < h1.ema50 ? "SHORT" : null;
  const prior15 = bars15.slice(-22, -2);
  const previous = bars15.at(-2);
  const last = bars15.at(-1);
  const priorHigh = Math.max(...prior15.map((x) => x.high));
  const priorLow = Math.min(...prior15.map((x) => x.low));
  const longSetup = side === "LONG";
  const confirmation = longSetup
    ? (last.close > priorHigh || (previous.low <= m15.ema20 && last.close > m15.ema20 && last.close > previous.high))
    : side === "SHORT" && (last.close < priorLow || (previous.high >= m15.ema20 && last.close < m15.ema20 && last.close < previous.low));
  const rsiUsable = longSetup
    ? h1.rsi >= 44 && h1.rsi <= 68 && m15.rsi >= 45 && m15.rsi <= 70
    : side === "SHORT" && h1.rsi >= 32 && h1.rsi <= 58 && m15.rsi >= 30 && m15.rsi <= 56;
  const positioningSupports = longSetup
    ? globalRatio <= 1.25 && topRatio <= 1.30 && takerRatio >= 1.04
    : side === "SHORT" && globalRatio >= 0.80 && topRatio >= 0.78 && takerRatio <= 0.96;
  const basisSupports = longSetup ? basis <= 0.0005 : side === "SHORT" && basis >= -0.0005;
  const equitySupports = equityFresh && (longSetup ? equityGap <= 0.0025 : equityGap >= -0.0025);
  const oiSupports = oiChange >= 0.0025;

  const swingHigh = Math.max(...bars15.slice(-12).map((x) => x.high));
  const swingLow = Math.min(...bars15.slice(-12).map((x) => x.low));
  const stop = longSetup ? Math.min(swingLow, current - 1.15 * m15.atr) : Math.max(swingHigh, current + 1.15 * m15.atr);
  const risk = Math.abs(current - stop);
  const structureTarget = longSetup
    ? Math.max(...bars1h.slice(-48).map((x) => x.high))
    : Math.min(...bars1h.slice(-48).map((x) => x.low));
  const grossReward = longSetup ? structureTarget - current : current - structureTarget;
  const netReward = grossReward - current * FEE_SLIPPAGE_RATE;
  const netRisk = risk + current * FEE_SLIPPAGE_RATE;
  const priceRr = netRisk > 0 ? netReward / netRisk : 0;
  const fundingSupported = (longSetup && candidate.funding < 0) || (side === "SHORT" && candidate.funding > 0);
  const millisecondsToFunding = candidate.nextFundingTime - Date.now();
  const fundingWithinHoldingWindow = millisecondsToFunding > 0
    && millisecondsToFunding <= candidate.fundingIntervalHours * 60 * 60 * 1000;
  const fundingSettlementCount = fundingSupported && fundingWithinHoldingWindow ? 1 : 0;
  const fundingCarryRate = Math.abs(candidate.funding) * FUNDING_HAIRCUT * fundingSettlementCount;
  const fundingCarryPerUnit = current * fundingCarryRate;
  const rrWithFunding = netRisk > 0 ? (netReward + fundingCarryPerUnit) / netRisk : 0;
  const requiredCombinedRr = macro.riskOff ? 2.3 : MIN_COMBINED_RR;

  const qualified = Boolean(side) && premarket && equityFresh && equitySupports && basisSupports
    && confirmation && rsiUsable && positioningSupports && oiSupports
    && priceRr >= MIN_PRICE_RR && rrWithFunding >= requiredCombinedRr;

  const result = {
    symbol: candidate.symbol,
    equityTicker: candidate.equityTicker,
    side,
    qualified,
    funding: candidate.funding,
    fundingIntervalHours: candidate.fundingIntervalHours,
    nextFundingTime: candidate.nextFundingTime,
    basis,
    equityPrice: equity?.price ?? null,
    equityGap,
    equityFresh: Boolean(equityFresh),
    change24h: candidate.change24h,
    oiChange,
    globalRatio,
    topRatio,
    takerRatio,
    priceRr,
    rrWithFunding,
    fundingCarryRate,
    fundingCarryPerUnit,
    fundingSettlementCount,
    checks: { premarket, equitySupports, basisSupports, confirmation, rsiUsable, positioningSupports, oiSupports, priceRr: priceRr >= MIN_PRICE_RR, rrWithFunding: rrWithFunding >= requiredCombinedRr },
  };
  if (!qualified) return result;

  return {
    ...result,
    entry: current,
    entryLow: longSetup ? current - 0.12 * m15.atr : current - 0.05 * m15.atr,
    entryHigh: longSetup ? current + 0.05 * m15.atr : current + 0.12 * m15.atr,
    stop,
    target1: structureTarget,
    target2: longSetup ? current + 3 * risk : current - 3 * risk,
    trigger: longSetup ? "美股盘前15分钟突破或回踩企稳" : "美股盘前15分钟跌破或反抽受阻",
    macro,
  };
}

async function loadMacroContext() {
  const [oil, headlines] = await Promise.all([
    loadOil().catch(() => ({ price: 0, change1h: 0, change24h: 0 })),
    loadGeopoliticalHeadlines(),
  ]);
  const severeNews = headlines.filter((title) => /taiwan|strait|blockade|war|attack|sanction|export control|missile|refiner|hormuz|iran/i.test(title));
  const oilShock = Math.abs(oil.change1h) >= 0.015 || Math.abs(oil.change24h) >= 0.04;
  return {
    oilPrice: oil.price,
    oilChange1h: oil.change1h,
    oilChange24h: oil.change24h,
    geopoliticalHeadlineCount: severeNews.length,
    headlineSample: severeNews.slice(0, 3),
    riskOff: oilShock || severeNews.length >= 3,
  };
}

async function loadOil() {
  const chart = await yahooChart("CL=F", "5d", "5m");
  const points = chart.points;
  const latest = points.at(-1);
  const oneHour = nearestPoint(points, latest.timestamp - 60 * 60 * 1000);
  const oneDay = nearestPoint(points, latest.timestamp - 24 * 60 * 60 * 1000);
  return {
    price: latest.price,
    change1h: change(oneHour?.price, latest.price),
    change24h: change(oneDay?.price, latest.price),
  };
}

async function loadEquityQuote(ticker) {
  try {
    const chart = await yahooChart(ticker, "1d", "1m");
    return chart.points.at(-1) || null;
  } catch {
    return null;
  }
}

async function yahooChart(ticker, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=true`;
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Equity data returned ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((timestamp, index) => ({ timestamp: timestamp * 1000, price: number(closes[index]) }))
    .filter((x) => x.price > 0);
  if (!points.length) throw new Error("Equity data has no current prices");
  return { points };
}

async function loadGeopoliticalHeadlines() {
  try {
    const query = encodeURIComponent("(Taiwan OR semiconductor OR oil) (war OR sanctions OR attack OR blockade) when:1d");
    const response = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, {
      headers: { "user-agent": "Mozilla/5.0" },
    });
    if (!response.ok) return [];
    const xml = await response.text();
    return [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/gi)]
      .map((match) => ({ title: decodeXml(match[1]), timestamp: Date.parse(match[2]) }))
      .filter((x) => Number.isFinite(x.timestamp) && Date.now() - x.timestamp <= 8 * 60 * 60 * 1000)
      .map((x) => x.title);
  } catch {
    return [];
  }
}

async function sendPushPlus(token, signal) {
  const direction = signal.side === "LONG" ? "做多" : "做空";
  const macro = signal.macro;
  const content = [
    `### ${signal.symbol} 美股盘前条件机会：${direction}`,
    `- 对应股票：${signal.equityTicker}`,
    `- 触发：${signal.trigger}`,
    `- 参考入场：${fmt(signal.entryLow)} - ${fmt(signal.entryHigh)}`,
    `- 止损：${fmt(signal.stop)}（以币安标记价格触发）`,
    `- 止盈1：${fmt(signal.target1)}`,
    `- 止盈2：${fmt(signal.target2)}`,
    `- 币安/股票价差：${pct(signal.equityGap)}`,
    `- 标记/指数基差：${pct(signal.basis)}`,
    `- 资金费率：${pct(signal.funding)} / ${signal.fundingIntervalHours}小时`,
    `- 保守资金费收益：${pct(signal.fundingCarryRate)}（按下一次结算、60%折扣；每1000 USDT名义仓位约 ${fmt(signal.fundingCarryRate * 1000)} USDT）`,
    `- 30分钟持仓量变化：${pct(signal.oiChange)}`,
    `- WTI：${fmt(macro.oilPrice)}，1小时 ${pct(macro.oilChange1h)}`,
    `- 地缘风险新闻数：${macro.geopoliticalHeadlineCount}`,
    `- 首目标价格本身RR：${signal.priceRr.toFixed(2)}；含资金费RR：${signal.rrWithFunding.toFixed(2)}`,
    "- 杠杆只放大保证金口径收益和爆仓风险，不增加同一名义仓位的资金费；资金费可能变化，不能视为保证收益。",
    "",
    "这是盘前条件观察信号，不是订单或收益保证。股票休市价格可能滞后，合约风险高，请自行确认。",
  ].join("\n");
  const response = await fetch(PUSHPLUS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, title: `${signal.symbol} ${direction}盘前条件机会`, content, template: "markdown" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 200)) {
    throw new Error(`PushPlus failed: ${response.status} ${JSON.stringify(body)}`);
  }
}

function isUsPremarket(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && minutes >= 8 * 60 && minutes < 9 * 60 + 30;
}

function nearestPoint(points, timestamp) {
  return points.reduce((best, point) => Math.abs(point.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? point : best, points[0]);
}

function candles(rows) {
  return rows.slice(0, -1).map((x) => ({ open: number(x[1]), high: number(x[2]), low: number(x[3]), close: number(x[4]) }));
}

function indicators(bars) {
  const closes = bars.map((x) => x.close);
  return { close: closes.at(-1), ema20: ema(closes, 20), ema50: ema(closes, 50), rsi: rsi(closes, 14), atr: atr(bars, 14) };
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
  for (let index = values.length - period; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    if (delta >= 0) gain += delta;
    else loss -= delta;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

function atr(bars, period) {
  const ranges = [];
  for (let index = bars.length - period; index < bars.length; index += 1) {
    const previous = bars[index - 1].close;
    ranges.push(Math.max(bars[index].high - bars[index].low, Math.abs(bars[index].high - previous), Math.abs(bars[index].low - previous)));
  }
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

async function api(path) {
  const failures = [];
  for (const host of BINANCE_HOSTS) {
    try {
      const response = await fetch(`${host}${path}`, { headers: { "user-agent": "BinanceFundingMonitor/1.0" } });
      if (response.ok) return await response.json();
      failures.push(`${host}:${response.status}`);
    } catch (error) {
      failures.push(`${host}:${String(error?.message || error)}`);
    }
  }
  throw new Error(`Binance ${path} failed across public hosts (${failures.join(", ")})`);
}

function compact(x) {
  return {
    symbol: x.symbol,
    equityTicker: x.equityTicker,
    volume: x.volume,
    change24h: x.change24h,
    funding: x.funding,
    fundingIntervalHours: x.fundingIntervalHours,
  };
}

function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function change(first, last) { return first ? last / first - 1 : 0; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function pct(value) { return value === null ? "N/A" : `${(value * 100).toFixed(3)}%`; }
function fmt(value) { return value >= 1000 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toPrecision(6); }
