const BINANCE = "https://fapi.binance.com";
const PUSHPLUS = "https://www.pushplus.plus/send";
const MIN_QUOTE_VOLUME = 50_000_000;
const FEE_SLIPPAGE_RATE = 0.0012;
const COOLDOWN_MS = 60 * 60 * 1000;
const FUNDING_HAIRCUT = 0.6;
const MIN_PRICE_RR = 1.5;
const MIN_COMBINED_RR = 1.8;
const CLOSED_MARKET_RR = 2.3;

const CHIP_AND_STORAGE = new Map([
  ["NVDAUSDT", "NVDA"], ["AMDUSDT", "AMD"], ["AVGOUSDT", "AVGO"],
  ["TSMUSDT", "TSM"], ["INTCUSDT", "INTC"], ["QCOMUSDT", "QCOM"],
  ["ARMUSDT", "ARM"], ["ASMLUSDT", "ASML"], ["MRVLUSDT", "MRVL"],
  ["AMATUSDT", "AMAT"], ["LRCXUSDT", "LRCX"], ["SMHUSDT", "SMH"],
  ["MUUSDT", "MU"], ["SNDKUSDT", "SNDK"], ["WDCUSDT", "WDC"],
]);

export async function runOvernightTradifiMonitor(env) {
  const previous = (await env.MONITOR_STATE.get("state", "json")) || { alerts: {} };
  const regime = usOffHoursRegime(new Date());
  const now = Date.now();
  if (!regime.active) {
    await env.MONITOR_STATE.put("state", JSON.stringify({
      ...previous,
      overnightTradifi: { lastRun: new Date(now).toISOString(), active: false, regime: regime.name, analyses: [] },
    }));
    return { ok: true, active: false, alerts: 0, regime: regime.name };
  }

  const [exchangeInfo, tickers, premiums, fundingInfo, macro] = await Promise.all([
    api("/fapi/v1/exchangeInfo"),
    api("/fapi/v1/ticker/24hr"),
    api("/fapi/v1/premiumIndex"),
    api("/fapi/v1/fundingInfo").catch(() => []),
    loadOvernightMacro(),
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

  const analyses = await Promise.all(top.map((candidate) => analyze(candidate, top, macro, regime)));
  const alerts = { ...(previous.alerts || {}) };
  const qualified = [];
  for (const result of analyses.filter((x) => x.qualified)) {
    const key = `overnight:${result.symbol}:${result.side}`;
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
        regime: result.regime,
        funding: result.funding,
        fundingIntervalHours: result.fundingIntervalHours,
        conservativeFundingCarryRate: result.fundingCarryRate,
        priceRr: result.priceRr,
        rrWithFunding: result.rrWithFunding,
        basis: result.basis,
        equityGap: result.equityGap,
        equityAgeMinutes: result.equityAgeMinutes,
        nqChange1h: result.nqChange1h,
        sectorBreadth: result.sectorBreadth,
        oiChange: result.oiChange,
        globalRatio: result.globalRatio,
        topRatio: result.topRatio,
        takerRatio: result.takerRatio,
      },
      invalidation: "mark_price_reaches_stop_or_next_regular_session_invalidates_the_lead",
    };
    qualified.push(result);
  }

  const state = {
    ...previous,
    alerts,
    overnightTradifi: {
      lastRun: new Date(now).toISOString(),
      active: true,
      regime: regime.name,
      macro,
      rankings: top.map(compact),
      analyses,
    },
  };
  await env.MONITOR_STATE.put("state", JSON.stringify(state));
  for (const signal of qualified) await sendPushPlus(env.PUSHPLUS_TOKEN, signal);
  return { ok: true, active: true, checked: top.length, alerts: qualified.length, regime: regime.name, top: top.map((x) => x.symbol) };
}

async function analyze(candidate, top, macro, regime) {
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
    return { symbol: candidate.symbol, qualified: false, regime: regime.name, reason: "insufficient_data" };
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
  const equityAgeMinutes = equity ? (Date.now() - equity.timestamp) / 60000 : Infinity;
  const equityFresh = Boolean(equity && equityAgeMinutes <= 15);
  const equityGap = equity?.price ? current / equity.price - 1 : null;
  const side = h4.ema20 > h4.ema50 && h1.ema20 > h1.ema50 ? "LONG"
    : h4.ema20 < h4.ema50 && h1.ema20 < h1.ema50 ? "SHORT" : null;
  const longSetup = side === "LONG";
  const prior15 = bars15.slice(-22, -2);
  const previous = bars15.at(-2);
  const last = bars15.at(-1);
  const priorHigh = Math.max(...prior15.map((x) => x.high));
  const priorLow = Math.min(...prior15.map((x) => x.low));
  const confirmation = longSetup
    ? last.close > priorHigh || (previous.low <= m15.ema20 && last.close > m15.ema20 && last.close > previous.high)
    : side === "SHORT" && (last.close < priorLow || (previous.high >= m15.ema20 && last.close < m15.ema20 && last.close < previous.low));
  const rsiUsable = longSetup
    ? h1.rsi >= 44 && h1.rsi <= 68 && m15.rsi >= 45 && m15.rsi <= 70
    : side === "SHORT" && h1.rsi >= 32 && h1.rsi <= 58 && m15.rsi >= 30 && m15.rsi <= 56;
  const positioningSupports = longSetup
    ? globalRatio <= 1.25 && topRatio <= 1.30 && takerRatio >= 1.04
    : side === "SHORT" && globalRatio >= 0.80 && topRatio >= 0.78 && takerRatio <= 0.96;
  const basisSupports = longSetup ? basis <= 0.0005 : side === "SHORT" && basis >= -0.0005;
  const nqSupports = longSetup ? macro.nqChange1h >= 0.0015 : side === "SHORT" && macro.nqChange1h <= -0.0015;
  const breadthCount = top.filter((x) => longSetup ? x.change24h > 0 : x.change24h < 0).length;
  const sectorBreadth = top.length ? breadthCount / top.length : 0;
  const breadthSupports = sectorBreadth >= 2 / 3;
  const newsSupports = macro.newsBias[candidate.equityTicker] === 0
    || (longSetup ? macro.newsBias[candidate.equityTicker] > 0 : macro.newsBias[candidate.equityTicker] < 0);
  const equityGapSupports = equityFresh && (longSetup ? equityGap <= -0.0025 : equityGap >= 0.0025);
  const closedReferenceSupports = !equityFresh && macro.nqFresh && nqSupports && breadthSupports && newsSupports;
  const referenceSupports = regime.name === "完全闭市" ? closedReferenceSupports : equityGapSupports && macro.nqFresh && nqSupports;
  const oiSupports = oiChange >= 0.0025;
  const fundingSupported = (longSetup && candidate.funding < 0) || (!longSetup && candidate.funding > 0);
  const fundingNeutral = Math.abs(candidate.funding) < 0.0003;
  const fundingDirectionSupports = fundingSupported || fundingNeutral;
  const swingHigh = Math.max(...bars15.slice(-12).map((x) => x.high));
  const swingLow = Math.min(...bars15.slice(-12).map((x) => x.low));
  const stop = longSetup ? Math.min(swingLow, current - 1.15 * m15.atr) : Math.max(swingHigh, current + 1.15 * m15.atr);
  const risk = Math.abs(current - stop);
  const structureTarget = longSetup ? Math.max(...bars1h.slice(-48).map((x) => x.high)) : Math.min(...bars1h.slice(-48).map((x) => x.low));
  const grossReward = longSetup ? structureTarget - current : current - structureTarget;
  const netReward = grossReward - current * FEE_SLIPPAGE_RATE;
  const netRisk = risk + current * FEE_SLIPPAGE_RATE;
  const priceRr = netRisk > 0 ? netReward / netRisk : 0;
  const millisecondsToFunding = candidate.nextFundingTime - Date.now();
  const oneSettlement = millisecondsToFunding > 0 && millisecondsToFunding <= candidate.fundingIntervalHours * 60 * 60 * 1000;
  const fundingCarryRate = fundingSupported && oneSettlement ? Math.abs(candidate.funding) * FUNDING_HAIRCUT : 0;
  const rrWithFunding = netRisk > 0 ? (netReward + current * fundingCarryRate) / netRisk : 0;
  const requiredCombinedRr = macro.riskOff || regime.name === "完全闭市" ? CLOSED_MARKET_RR : MIN_COMBINED_RR;
  const qualified = Boolean(side) && referenceSupports && basisSupports && confirmation && rsiUsable && positioningSupports
    && oiSupports && fundingDirectionSupports && priceRr >= MIN_PRICE_RR && rrWithFunding >= requiredCombinedRr;
  const result = {
    symbol: candidate.symbol,
    equityTicker: candidate.equityTicker,
    side,
    qualified,
    regime: regime.name,
    funding: candidate.funding,
    fundingIntervalHours: candidate.fundingIntervalHours,
    basis,
    equityGap,
    equityAgeMinutes: Number.isFinite(equityAgeMinutes) ? equityAgeMinutes : null,
    equityFresh,
    nqChange1h: macro.nqChange1h,
    sectorBreadth,
    oiChange,
    globalRatio,
    topRatio,
    takerRatio,
    priceRr,
    rrWithFunding,
    fundingCarryRate,
    checks: { referenceSupports, basisSupports, confirmation, rsiUsable, positioningSupports, oiSupports, fundingDirectionSupports, priceRr: priceRr >= MIN_PRICE_RR, rrWithFunding: rrWithFunding >= requiredCombinedRr },
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
    trigger: "币安隔夜先行：纳指期货、板块广度与15分钟结构同步",
    macro,
  };
}

async function loadOvernightMacro() {
  const [nq, oil, headlines] = await Promise.all([
    loadChart("NQ=F", "1d", "5m").catch(() => ({ points: [] })),
    loadChart("CL=F", "5d", "5m").catch(() => ({ points: [] })),
    loadGeopoliticalHeadlines(),
  ]);
  const latestNq = nq.points.at(-1);
  const oneHourNq = latestNq ? nearestPoint(nq.points, latestNq.timestamp - 60 * 60 * 1000) : null;
  const latestOil = oil.points.at(-1);
  const oneHourOil = latestOil ? nearestPoint(oil.points, latestOil.timestamp - 60 * 60 * 1000) : null;
  const oneDayOil = latestOil ? nearestPoint(oil.points, latestOil.timestamp - 24 * 60 * 60 * 1000) : null;
  const severe = headlines.filter((x) => /taiwan|strait|blockade|war|attack|sanction|export control|missile|refiner|hormuz|iran/i.test(x));
  const newsBias = {};
  for (const ticker of CHIP_AND_STORAGE.values()) {
    const relevant = headlines.filter((title) => new RegExp(ticker, "i").test(title));
    const positive = relevant.filter((title) => /beat|upgrade|surge|record|approved|strong|raises|bullish/i.test(title)).length;
    const negative = relevant.filter((title) => /miss|downgrade|cut|ban|sanction|weak|delay|war|attack|blockade/i.test(title)).length;
    newsBias[ticker] = positive > negative ? 1 : negative > positive ? -1 : 0;
  }
  const nqChange1h = latestNq && oneHourNq ? change(oneHourNq.price, latestNq.price) : 0;
  const oilChange1h = latestOil && oneHourOil ? change(oneHourOil.price, latestOil.price) : 0;
  const oilChange24h = latestOil && oneDayOil ? change(oneDayOil.price, latestOil.price) : 0;
  return {
    nqPrice: latestNq?.price || 0,
    nqChange1h,
    nqFresh: Boolean(latestNq && Date.now() - latestNq.timestamp <= 15 * 60 * 1000),
    oilPrice: latestOil?.price || 0,
    oilChange1h,
    oilChange24h,
    geopoliticalHeadlineCount: severe.length,
    headlineSample: severe.slice(0, 3),
    newsBias,
    riskOff: Math.abs(nqChange1h) >= 0.015 || Math.abs(oilChange1h) >= 0.015 || Math.abs(oilChange24h) >= 0.04 || severe.length >= 3,
  };
}

async function sendPushPlus(token, signal) {
  if (!token) throw new Error("PUSHPLUS_TOKEN is not configured");
  const direction = signal.side === "LONG" ? "做多" : "做空";
  const macro = signal.macro;
  const equityReference = signal.equityFresh ? `新鲜，价差 ${pct(signal.equityGap)}` : `陈旧 ${signal.equityAgeMinutes == null ? "N/A" : signal.equityAgeMinutes.toFixed(0)} 分钟，仅作锚点`;
  const content = [
    `### ${signal.symbol} 隔夜先行模型 ${direction}`,
    `- 市场状态：美股${signal.regime}；这是开盘前条件观察，不是追价指令`,
    `- 触发：${signal.trigger}`,
    `- 参考入场：${fmt(signal.entryLow)} - ${fmt(signal.entryHigh)}`,
    `- 标记价格止损：${fmt(signal.stop)}`,
    `- 目标1/2：${fmt(signal.target1)} / ${fmt(signal.target2)}`,
    `- 股票参考：${equityReference}`,
    `- Binance标记/指数基差：${pct(signal.basis)}`,
    `- 纳指期货1小时：${pct(signal.nqChange1h)}；板块广度：${pct(signal.sectorBreadth)}`,
    `- OI/全局多空/顶级多空/主动买卖：${pct(signal.oiChange)} / ${signal.globalRatio.toFixed(2)} / ${signal.topRatio.toFixed(2)} / ${signal.takerRatio.toFixed(2)}`,
    `- 资金费：${pct(signal.funding)} / ${signal.fundingIntervalHours}小时；保守 carry：${pct(signal.fundingCarryRate)} / 每1000 USDT名义仓位约 ${fmt(signal.fundingCarryRate * 1000)} USDT`,
    `- 价格本身RR：${signal.priceRr.toFixed(2)}；含资金费RR：${signal.rrWithFunding.toFixed(2)}`,
    `- WTI：${fmt(macro.oilPrice)}，1小时 ${pct(macro.oilChange1h)}；地缘风险新闻：${macro.geopoliticalHeadlineCount}条`,
    "- 失效：标记价格触及止损、纳指/板块方向反转，或美股开盘后价差被反向补回。杠杆只放大保证金收益和爆仓风险，不保证资金费收益。",
    "这是一条隔夜先行条件 setup，不是订单，也不是收益保证；美股开盘可能跳空。",
  ].join("\n");
  const response = await fetch(PUSHPLUS, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, title: `${signal.symbol} 隔夜先行模型 ${direction}`, content, template: "markdown" }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || (body.code !== undefined && body.code !== 200)) throw new Error(`PushPlus failed: ${response.status} ${JSON.stringify(body)}`);
}

function usOffHoursRegime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  const weekend = ["Sat", "Sun"].includes(parts.weekday);
  if (weekend) return { active: false, name: "周末" };
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return { active: false, name: "美股regular_session" };
  if (minutes >= 20 * 60 || minutes < 4 * 60) return { active: true, name: "完全闭市" };
  return { active: true, name: minutes < 9 * 60 + 30 ? "盘前" : "盘后" };
}

async function loadEquityQuote(ticker) {
  try { return (await loadChart(ticker, "1d", "1m")).points.at(-1) || null; } catch { return null; }
}

async function loadChart(ticker, range, interval) {
  const response = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}&includePrePost=true`, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`Yahoo ${ticker} returned ${response.status}`);
  const result = (await response.json()).chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const points = timestamps.map((timestamp, index) => ({ timestamp: timestamp * 1000, price: number(closes[index]) })).filter((x) => x.price > 0);
  if (!points.length) throw new Error(`Yahoo ${ticker} has no data`);
  return { points };
}

async function loadGeopoliticalHeadlines() {
  try {
    const query = encodeURIComponent("(Taiwan OR semiconductor OR oil OR Nvidia OR AMD) (war OR sanctions OR attack OR blockade OR export control) when:1d");
    const response = await fetch(`https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`, { headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) return [];
    const xml = await response.text();
    return [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>[\s\S]*?<pubDate>(.*?)<\/pubDate>[\s\S]*?<\/item>/gi)]
      .map((match) => ({ title: decodeXml(match[1]), timestamp: Date.parse(match[2]) }))
      .filter((x) => Number.isFinite(x.timestamp) && Date.now() - x.timestamp <= 8 * 60 * 60 * 1000)
      .map((x) => x.title);
  } catch { return []; }
}

function candles(rows) { return rows.slice(0, -1).map((x) => ({ open: number(x[1]), high: number(x[2]), low: number(x[3]), close: number(x[4]) })); }
function indicators(bars) { const closes = bars.map((x) => x.close); return { close: closes.at(-1), ema20: ema(closes, 20), ema50: ema(closes, 50), rsi: rsi(closes, 14), atr: atr(bars, 14) }; }
function ema(values, period) { const multiplier = 2 / (period + 1); let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period; for (const next of values.slice(period)) value = next * multiplier + value * (1 - multiplier); return value; }
function rsi(values, period) { let gain = 0; let loss = 0; for (let index = values.length - period; index < values.length; index += 1) { const delta = values[index] - values[index - 1]; if (delta >= 0) gain += delta; else loss -= delta; } return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
function atr(bars, period) { const ranges = []; for (let index = bars.length - period; index < bars.length; index += 1) { const previous = bars[index - 1].close; ranges.push(Math.max(bars[index].high - bars[index].low, Math.abs(bars[index].high - previous), Math.abs(bars[index].low - previous))); } return ranges.reduce((a, b) => a + b, 0) / ranges.length; }
async function api(path) { const response = await fetch(`${BINANCE}${path}`, { headers: { "user-agent": "BinanceFundingMonitor/1.0" } }); if (!response.ok) throw new Error(`Binance ${path} returned ${response.status}`); return response.json(); }
function compact(x) { return { symbol: x.symbol, equityTicker: x.equityTicker, volume: x.volume, funding: x.funding, fundingIntervalHours: x.fundingIntervalHours }; }
function nearestPoint(points, timestamp) { return points.reduce((best, point) => Math.abs(point.timestamp - timestamp) < Math.abs(best.timestamp - timestamp) ? point : best, points[0]); }
function decodeXml(value) { return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim(); }
function change(first, last) { return first ? last / first - 1 : 0; }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function pct(value) { return value === null ? "N/A" : `${(value * 100).toFixed(3)}%`; }
function fmt(value) { return value >= 1000 ? value.toFixed(2) : value >= 1 ? value.toFixed(4) : value.toPrecision(6); }
