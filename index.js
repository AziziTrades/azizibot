// AziziBot — Real-time Discord alerts via Polygon WebSocket
// Deploy on Railway.app — runs 24/7
// Node.js 18+

const https = require('https');
const WebSocket = require('ws');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const POLY_KEY   = '5jLrhuNS7DQZCp3eZpKHiuCBxuTddlLc';
const FMP_KEY    = 'nBekBFFFeKcrOj6Nd95DiF43jEEkJDW4';
const FINVIZ_KEY = '6a7d3078-e6c0-4537-823f-b140c3b0dcb6';

const WH = {
  TOP_GAPPERS:    'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3',
  PRESS_RELEASES: 'https://discord.com/api/webhooks/1493289596732309657/tuhNqm8r3VB2k1rNcWDq487BNiPdlluNjDBX45IpdshxZv969Uskq1z3jKJ3AtGzkLdb',
  HALT_ALERTS:    'https://discord.com/api/webhooks/1493289994075242538/Jo3kfIzST8pqSAcxUbQ2_nzeWbQACDee4DTydBCZW5WcQjHBAdxA2jNeynkGafte7g5T',
  SEC_FILINGS:    'https://discord.com/api/webhooks/1493290146068697259/VPRB_3eUUyQReJpF_XkqeC324FKTVbARCf15jvOSb33lKguSdlf3eR1euWnsV6gq2enj',
  MAIN_CHAT:      'https://discord.com/api/webhooks/1493201376484786217/Hv4PUUUVCVTa80ukQuR5pUc5wa5ZrXAfGtAdqa2KLoEN3WJ7h79hZiXzEMIzQ9-IfmRW'
};

const BOT_NAME = 'AziziBot';

// ── SESSION HOURS: 4AM - 8PM ET ───────────────────────────────────────────────
function getETInfo() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(now);
  const h = parseInt(parts.find(p => p.type === 'hour').value);
  const m = parseInt(parts.find(p => p.type === 'minute').value);
  const etMin = (h === 24 ? 0 : h) * 60 + m;
  const timeStr = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false
  });
  const sess = etMin >= 240 && etMin < 570 ? 'PRE-MARKET'
             : etMin >= 570 && etMin < 960 ? 'MARKET'
             : etMin >= 960 && etMin < 1200 ? 'AFTER-HOURS' : 'CLOSED';
  return { h: (h === 24 ? 0 : h), m, etMin, timeStr, sess };
}
function isActiveSession() {
  const { etMin } = getETInfo();
  return etMin >= 240 && etMin < 1200;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
function fmtN(n) {
  if (!n || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}
function fmtRVol(r) {
  if (!r || isNaN(r) || r === 0) return '--';
  if (r >= 1000) return Math.round(r).toLocaleString() + 'x';
  if (r >= 10) return r.toFixed(0) + 'x';
  return r.toFixed(1) + 'x';
}
function priceFlag(p) {
  if (p < 1)  return '<$1';
  if (p < 2)  return '<$2';
  if (p < 5)  return '<$5';
  if (p < 10) return '<$10';
  return '<$20';
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP HELPERS ──────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AziziBot/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function polyGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  return httpGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`);
}
function fmpGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  return httpGet(`https://financialmodelingprep.com${path}${sep}apikey=${FMP_KEY}`);
}

// ── DISCORD POSTER ────────────────────────────────────────────────────────────
async function post(webhook, payload) {
  payload.username = BOT_NAME;
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const urlObj = new URL(webhook);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, res => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    req.write(body);
    req.end();
  });
}

// ── ENRICHMENT ────────────────────────────────────────────────────────────────
async function getFinvizData(ticker) {
  const result = { si: '--', regSho: false, ctb: '' };
  try {
    const url = `https://elite.finviz.com/quote.ashx?t=${ticker}&auth=${FINVIZ_KEY}`;
    const html = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Cookie': `finvizAuth=${FINVIZ_KEY}`,
          'Referer': 'https://elite.finviz.com/'
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const siM = html.match(/Short Float[^>]*>([\d.]+%)/i);
    if (siM) result.si = siM[1];
    result.regSho = /Reg SHO.*?Yes/i.test(html);
    const ctbM = html.match(/CTB[^>]*>([^<]{1,15})<\/td>/i);
    if (ctbM) {
      const v = ctbM[1].trim();
      result.ctb = /high/i.test(v) ? 'High CTB' : /low/i.test(v) ? 'Low CTB' : '';
    }
  } catch (e) {}
  return result;
}

async function getLatestNewsUrl(ticker) {
  try {
    const news = await fmpGet(`/stable/news/stock?symbols=${ticker}&limit=1`);
    if (Array.isArray(news) && news.length && news[0].url) return news[0].url;
  } catch (e) {}
  return null;
}

async function getRecentSplit(ticker) {
  try {
    const splits = await fmpGet(`/stable/splits?symbol=${ticker}`);
    if (Array.isArray(splits) && splits.length) {
      const s = splits.find(s => {
        const days = (Date.now() - new Date(s.date).getTime()) / 86400000;
        return days <= 90 && s.denominator > s.numerator;
      });
      if (s) {
        const d = new Date(s.date);
        return `${s.numerator} for ${s.denominator} R/S ${d.toLocaleString('en-US', { month: 'short' })}. ${d.getDate()}`;
      }
    }
  } catch (e) {}
  return null;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tickers: new Map(),
  sentNews: new Set(),
  sentHalts: new Set(),
  sentFilings: new Set(),
  sentPRs: new Set(),
  morningPosted: new Set(),
  lastTrade: new Map(),
  priceHistory: new Map(), // ticker -> [{price, time}] for after-lull detection
};

// ── TOP GAPPERS ───────────────────────────────────────────────────────────────
let topGappers = [];

async function refreshTopGappers() {
  try {
    const pg = await polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true');
    const tickers = (pg && pg.tickers) || [];
    topGappers = tickers.map(t => {
      const lp = (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || 0;
      const prev = (t.prevDay && t.prevDay.c) || 0;
      const chg = lp > 0 && prev > 0 ? ((lp - prev) / prev) * 100 : (t.todaysChangePerc || 0);
      const vol = (t.day && t.day.v) || (t.min && t.min.av) || 0;
      const prevVol = (t.prevDay && t.prevDay.v) || 0;
      const rvol = prevVol > 0 ? vol / prevVol : 0;
      const high = (t.day && t.day.h) || lp;
      return { ticker: t.ticker, price: lp, prev, chgPct: chg, volume: vol, prevVol, rvol, high };
    })
    .filter(t => {
      const sym = t.ticker;
      // Exclude warrants, rights, units
      const isWarrant = /W$|WS$|WT$|R$|U$/.test(sym);
      // Exclude preferred shares (e.g. BACPB, GS-A style)
      const isPreferred = /[A-Z]$/.test(sym) && sym.length > 5;
      // Exclude pure OTC penny tickers (6+ letters) and F-suffix foreign OTC
      const isOTC = sym.length >= 6 || (/F$/.test(sym) && sym.length === 5);
      return (
        t.chgPct >= 5 &&
        t.price >= 0.1 &&
        t.price <= 20 &&
        t.volume >= 75000 &&   // lowered to 75K to catch more valid moves
        !isWarrant &&
        !isPreferred &&
        !isOTC
      );
    })
    .sort((a, b) => b.chgPct - a.chgPct)
    .slice(0, 30);

    for (const g of topGappers) {
      const existing = state.tickers.get(g.ticker) || { high: 0, nhod: 0 };
      state.tickers.set(g.ticker, {
        ...existing, price: g.price, prev: g.prev,
        chgPct: g.chgPct, volume: g.volume, rvol: g.rvol,
        high: Math.max(g.high, existing.high)
      });
    }
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} gappers refreshed`);
  } catch (e) { console.error('refreshTopGappers:', e.message); }
}

// ── NHOD (WebSocket-triggered) ────────────────────────────────────────────────
const nhoodCooldown = new Map(); // ticker -> last alert time

async function checkNHODForTicker(ticker, price) {
  if (!isActiveSession()) return;
  const etInfo = getETInfo();
  const gapper = topGappers.find(g => g.ticker === ticker);
  if (!gapper) return;

  const s = state.tickers.get(ticker);
  if (!s) return;
  if (price <= s.high + 0.001) return; // not a new high

  const nhod = (s.nhod || 0) + 1;
  state.tickers.set(ticker, { ...s, high: price, nhod });

  // Only alert once every 5 minutes per ticker
  const last = nhoodCooldown.get(ticker) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return; // max 1 alert per 10 min per ticker
  nhoodCooldown.set(ticker, Date.now());
  console.log(`[${etInfo.timeStr}] ⚡ NHOD ${ticker} $${price.toFixed(2)} (${nhod}x)`);

  const [fv, newsUrl, rs] = await Promise.all([
    getFinvizData(ticker), getLatestNewsUrl(ticker), getRecentSplit(ticker)
  ]);

  const tickerLink = newsUrl ? `[${ticker}](<${newsUrl}>)` : `**${ticker}**`;
  const regSho = fv.regSho ? ' | **Reg SHO**' : '';
  const si = fv.si !== '--' ? ` | SI: ${fv.si}` : '';
  const ctb = fv.ctb ? ` | ${fv.ctb}` : '';
  const rsStr = rs ? ` | ${rs}` : '';

  // After-lull detection: was price flat for 10+ min then spiked?
  let afterLull = '';
  const hist = state.priceHistory.get(ticker) || [];
  if (hist.length >= 10) {
    const tenMinAgo = Date.now() - 10 * 60 * 1000;
    const oldPrices = hist.filter(h => h.time < tenMinAgo);
    if (oldPrices.length >= 3) {
      const oldHigh = Math.max(...oldPrices.map(h => h.price));
      const oldLow = Math.min(...oldPrices.map(h => h.price));
      const wasFlat = (oldHigh - oldLow) / oldLow < 0.02; // <2% range = flat
      if (wasFlat && price > oldHigh * 1.03) afterLull = ' · `after-lull`';
    }
  }

  // Country flag detection
  const t3 = gapper.ticker;
  const isChinese = /^[A-Z]{2,4}(AO|BO|O|Y|YY)$/.test(t3);
  const isUK = /^[A-Z]{2,4}L$/.test(t3);
  const flag = isChinese ? '🇨🇳' : isUK ? '🇬🇧' : '🇺🇸';
  // NSH = first new session high, NHOD = subsequent ones
  // Fetch IO% and Market Cap
  let ioStr = '', mcStr = '';
  try {
    const profile = await fmpGet(`/stable/profile?symbol=${ticker}`);
    const p = Array.isArray(profile) ? profile[0] : profile;
    if (p) {
      const io = p.institutionalOwnershipPercentage || p.institutionalOwnership || 0;
      const mc = p.mktCap || p.marketCap || 0;
      if (io > 0) ioStr = ` | IO: ${(io * (io < 1 ? 100 : 1)).toFixed(2)}%`;
      if (mc > 0) mcStr = ` | MC: ${fmtN(mc)}`;
    }
  } catch(e) {}
  const hodLabel = nhod === 1 ? 'NSH' : `${nhod} NHOD`;
  const line = `\`${etInfo.timeStr}\` ↑ ${tickerLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${hodLabel}${afterLull} ~ ${flag}${ioStr}${mcStr} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${regSho}${si}${ctb}${rsStr}`;
  await post(WH.MAIN_CHAT, { content: line });
}

// ── GREEN BARS SCANNER (3+ consecutive green 5m candles) ─────────────────────



const greenBarCooldown = new Map();

async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();
  const from = now - 60 * 60 * 1000; // last 1 hour of candles

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: max once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (now - last < 15 * 60 * 1000) continue;

      const fromTs = Math.floor(from / 1000);
      const toTs = Math.floor(now / 1000);
      const data = await polyGet(`/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromTs}/${toTs}?adjusted=true&sort=desc&limit=10`);
      const results = (data && data.results) || [];
      if (results.length < 3) continue;

      // results[0] = most recent candle (sort=desc)
      // Check consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of results) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, now);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const fv = await getFinvizData(g.ticker);
      const si = fv.si !== '--' ? ` | SI: ${fv.si}` : '';
      const ctb = fv.ctb ? ` | ${fv.ctb}` : '';
      const regSho = fv.regSho ? ' | **Reg SHO**' : '';

      const label = greenCount >= 5 ? `${greenCount} green bars 5m` : `${greenCount} green bars 5m`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` · \`${label}\` ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)}${regSho}${si}${ctb}`;
      await post(WH.MAIN_CHAT, { content: line });
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} (${greenCount}x)`);
      await sleep(400);
    } catch(e) {}
    await sleep(150); // avoid rate limits
  }
}


// ── GREEN BARS DETECTION (5m consecutive green candles) ──────────────────────



async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (Date.now() - last < 15 * 60 * 1000) continue;

      // Fetch 5-min aggregates from Polygon
      const now = new Date();
      const from = new Date(now - 60 * 60 * 1000); // last 60 min
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = now.toISOString().slice(0, 10);

      const aggs = await polyGet(
        `/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=10`
      );

      if (!aggs || !aggs.results || aggs.results.length < 3) continue;

      const bars = aggs.results; // newest first
      // Count consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of bars) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, Date.now());
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} ${greenCount}x 5m`);

      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const countLabel = greenCount >= 5 ? `${greenCount} 🔥` : `${greenCount}`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` · ${countLabel} green bars 5m ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
    } catch (e) {}
  }
}

// ── BREAKING NEWS (press release format) ────────────────────────────────────
async function checkBreakingNews() {
  if (!isActiveSession()) return;
  const etInfo = getETInfo();

  // Build watchlist - top gappers + any stock that had volume today
  const watchTickers = [...new Set(topGappers.map(g => g.ticker))];
  if (!watchTickers.length) return;

  try {
    const tickers = watchTickers.join(',');
    const news = await fmpGet(`/stable/news/stock?symbols=${tickers}&limit=50`);
    if (!Array.isArray(news)) return;

    const cutoff = Date.now() - 5 * 60 * 1000; // last 5 min
    const fresh = news.filter(n => {
      if (!n.publishedDate) return false;
      const id = (n.url || n.title || '').slice(0, 100);
      return new Date(n.publishedDate).getTime() > cutoff && !state.sentNews.has(id);
    });

    for (const n of fresh.slice(0, 5)) {
      const id = (n.url || n.title || '').slice(0, 100);
      state.sentNews.add(id);

      const ageSec = Math.floor((Date.now() - new Date(n.publishedDate).getTime()) / 1000);
      const ageStr = ageSec < 60 ? `${ageSec} seconds ago` : `${Math.floor(ageSec/60)} min ago`;
      const ticker = n.symbol || n.symbols || '';
      const title = (n.title || '').slice(0, 200);
      const link = n.url || '';
      const gapper = topGappers.find(g => g.ticker === ticker);
      const isOffering = /offering|shelf|ATM|dilut|direct offering|registered direct/i.test(title);

      // NuntioBot-style embed format
      const embedDesc = `${title}
${link ? `[Link](<${link}>)` : ''}`;
      const color = isOffering ? 0xf0a500 :
        (n.sentiment||'').toLowerCase() === 'positive' ? 0x39d353 :
        (n.sentiment||'').toLowerCase() === 'negative' ? 0xf85149 : 0x5865f2;

      // Post to press-releases as embed
      await post(WH.PRESS_RELEASES, {
        embeds: [{
          title: `${ticker} — ${ageStr}`,
          description: embedDesc,
          color,
          timestamp: new Date(n.publishedDate).toISOString()
        }]
      });
      await sleep(300);

      // Also post to main-chat as compact line
      const priceCtx = gapper ? ` \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\`` : '';
      const offerFlag = isOffering ? ' ⚠️' : '';
      const sentIcon = (n.sentiment||'').toLowerCase() === 'positive' ? '📈' :
                       (n.sentiment||'').toLowerCase() === 'negative' ? '📉' : '📰';
      const mainLine = `\`${etInfo.timeStr}\` ${sentIcon}${offerFlag} **${ticker}**${priceCtx} ${ageStr} — ${title.slice(0, 90)}${link ? ` | [PR →](<${link}>)` : ''}`;
      await post(WH.MAIN_CHAT, { content: mainLine });
      await sleep(300);

      console.log(`[${etInfo.timeStr}] NEWS: ${ticker} - ${title.slice(0,50)}`);
    }

    // Trim seen set
    if (state.sentNews.size > 500) {
      const arr = [...state.sentNews];
      state.sentNews.clear();
      arr.slice(-200).forEach(id => state.sentNews.add(id));
    }
  } catch(e) { console.error('checkBreakingNews:', e.message); }
}

// ── HALT DETECTION ───────────────────────────────────────────────────────────
async function checkHalts() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();

  // Check ALL top gappers via Polygon snapshot - most reliable method
  for (const g of topGappers) {
    try {
      if (state.sentHalts.has(g.ticker)) continue;

      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${g.ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;

      // lastTrade.t and lastQuote.t are millisecond timestamps from Polygon
      const lastTradeMs = (td.lastTrade && td.lastTrade.t) || 0;
      const lastQuoteMs = (td.lastQuote && td.lastQuote.t) || 0;

      // Need both timestamps to exist and both be stale
      if (!lastTradeMs || !lastQuoteMs) continue;

      const tradeAgeSec = (now - lastTradeMs) / 1000;
      const quoteAgeSec = (now - lastQuoteMs) / 1000;

      // Halt = no trades AND no quotes for 2+ min, during active session, with real volume
      if (tradeAgeSec < 120 || quoteAgeSec < 120) continue;
      if (g.volume < 75000) continue;

      state.sentHalts.add(g.ticker);
      const minAgo = Math.floor(tradeAgeSec / 60);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)} | ~${minAgo}m ago`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      await post(WH.HALT_ALERTS, { content: line });
      console.log(`[${etInfo.timeStr}] HALT: ${g.ticker} (trade age: ${Math.round(tradeAgeSec)}s, quote age: ${Math.round(quoteAgeSec)}s)`);
      await sleep(200);
    } catch(e) {}
  }

  // Clear resumed tickers
  for (const ticker of [...state.sentHalts]) {
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;
      const lastTradeMs = (td.lastTrade && td.lastTrade.t) || 0;
      if (lastTradeMs > 0 && (now - lastTradeMs) / 1000 < 60) {
        state.sentHalts.delete(ticker);
        const etI = getETInfo();
        // Post resume alert
        const g = topGappers.find(x => x.ticker === ticker);
        if (g) {
          const newsUrl = await getLatestNewsUrl(ticker);
          const tickerLink = newsUrl ? `[${ticker}](<${newsUrl}>)` : `**${ticker}**`;
          const line = `\`${etI.timeStr}\` ▶️ **RESUMED** ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)}`;
          await post(WH.MAIN_CHAT, { content: line });
          await sleep(300);
          await post(WH.HALT_ALERTS, { content: line });
        }
        console.log(`[${etI.timeStr}] RESUMED: ${ticker}`);
      }
    } catch(e) {}
  }
}

// ── GREEN BARS SCANNER (3+ consecutive green 5m candles) ─────────────────────



async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();
  const from = now - 60 * 60 * 1000; // last 1 hour of candles

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: max once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (now - last < 15 * 60 * 1000) continue;

      const fromTs = Math.floor(from / 1000);
      const toTs = Math.floor(now / 1000);
      const data = await polyGet(`/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromTs}/${toTs}?adjusted=true&sort=desc&limit=10`);
      const results = (data && data.results) || [];
      if (results.length < 3) continue;

      // results[0] = most recent candle (sort=desc)
      // Check consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of results) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, now);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const fv = await getFinvizData(g.ticker);
      const si = fv.si !== '--' ? ` | SI: ${fv.si}` : '';
      const ctb = fv.ctb ? ` | ${fv.ctb}` : '';
      const regSho = fv.regSho ? ' | **Reg SHO**' : '';

      const label = greenCount >= 5 ? `${greenCount} green bars 5m` : `${greenCount} green bars 5m`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` · \`${label}\` ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)}${regSho}${si}${ctb}`;
      await post(WH.MAIN_CHAT, { content: line });
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} (${greenCount}x)`);
      await sleep(400);
    } catch(e) {}
    await sleep(150); // avoid rate limits
  }
}


// ── GREEN BARS DETECTION (5m consecutive green candles) ──────────────────────



async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (Date.now() - last < 15 * 60 * 1000) continue;

      // Fetch 5-min aggregates from Polygon
      const now = new Date();
      const from = new Date(now - 60 * 60 * 1000); // last 60 min
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = now.toISOString().slice(0, 10);

      const aggs = await polyGet(
        `/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=10`
      );

      if (!aggs || !aggs.results || aggs.results.length < 3) continue;

      const bars = aggs.results; // newest first
      // Count consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of bars) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, Date.now());
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} ${greenCount}x 5m`);

      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const countLabel = greenCount >= 5 ? `${greenCount} 🔥` : `${greenCount}`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` · ${countLabel} green bars 5m ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
    } catch (e) {}
  }
}

// ── BREAKING NEWS ─────────────────────────────────────────────────────────────
async function checkBreakingNews() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const tickers = topGappers.map(g => g.ticker).join(',');
  try {
    const news = await fmpGet(`/stable/news/stock?symbols=${tickers}&limit=50`);
    if (!Array.isArray(news)) return;
    const cutoff = Date.now() - 5 * 60 * 1000;
    const fresh = news.filter(n => {
      if (!n.publishedDate) return false;
      const id = (n.url || n.title || '').slice(0, 100);
      return new Date(n.publishedDate).getTime() > cutoff && !state.sentNews.has(id);
    });
    for (const n of fresh.slice(0, 5)) {
      const id = (n.url || n.title || '').slice(0, 100);
      state.sentNews.add(id);
      const age = Math.floor((Date.now() - new Date(n.publishedDate).getTime()) / 60000);
      const sent = (n.sentiment || '').toLowerCase();
      const sentIcon = sent === 'positive' ? '📈' : sent === 'negative' ? '📉' : '📰';
      const ticker = n.symbol || n.symbols || '';
      const gapper = topGappers.find(g => g.ticker === ticker);
      const priceCtx = gapper ? ` \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\`` : '';
      const isOffering = /offering|shelf|ATM|dilut|direct offering|registered direct/i.test(n.title || '');
      const offerFlag = isOffering ? ' ⚠️' : '';
      const line = `\`${etInfo.timeStr}\` ${sentIcon}${offerFlag} **${ticker}**${priceCtx} ${age}m ago — ${(n.title || '').slice(0, 100)}\n<${n.url || ''}>`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      if (!state.sentPRs.has(id)) {
        state.sentPRs.add(id);
        const prLink2 = n.url ? ` | [PR →](<${n.url}>)` : '';
        const prLine = `\`${etInfo.timeStr}\` ${sentIcon}${offerFlag} **${ticker}**${priceCtx} ${age}m ago — ${(n.title || '').slice(0, 90)}${prLink2}`;
        await post(WH.PRESS_RELEASES, { content: prLine });
        await sleep(300);
      }
    }
    if (state.sentNews.size > 500) {
      const arr = [...state.sentNews]; state.sentNews.clear();
      arr.slice(-200).forEach(id => state.sentNews.add(id));
    }
  } catch (e) { console.error('checkBreakingNews:', e.message); }
}

// ── HALT DETECTION (Real NASDAQ halt feed) ───────────────────────────────────
async function checkHalts() {
  if (!isActiveSession()) return;
  const etInfo = getETInfo();
  try {
    // Fetch real NASDAQ halt feed - official source
    const haltFeed = await new Promise((resolve, reject) => {
      const req = https.get('https://nasdaqtrader.com/trader.aspx?id=tradehalts', {
        headers: { 'User-Agent': 'AziziBot/1.0' }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    });

    // Parse halt table from HTML
    const haltRows = haltFeed.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of haltRows) {
      // Extract ticker from row
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (cells.length < 3) continue;
      const ticker = cells[0].replace(/<[^>]+>/g, '').trim();
      const haltTime = cells[1] ? cells[1].replace(/<[^>]+>/g, '').trim() : '';
      const reason = cells[2] ? cells[2].replace(/<[^>]+>/g, '').trim() : '';

      if (!ticker || ticker.length > 5 || ticker === 'Issue') continue;
      if (state.sentHalts.has(ticker)) continue;

      // Only alert for stocks in our gapper watchlist
      const gapper = topGappers.find(g => g.ticker === ticker);
      if (!gapper) continue;

      state.sentHalts.add(ticker);
      const newsUrl = await getLatestNewsUrl(ticker);
      const tickerLink = newsUrl ? `[${ticker}](<${newsUrl}>)` : `**${ticker}**`;
      const reasonStr = reason ? ` | ${reason}` : '';
      const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tickerLink} \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${gapper.price.toFixed(2)} | Vol: ${fmtN(gapper.volume)}${reasonStr}`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      await post(WH.HALT_ALERTS, { content: line });
      console.log(`[${etInfo.timeStr}] HALT: ${ticker} - ${reason}`);
      await sleep(200);
    }
  } catch(e) {
    console.error('checkHalts:', e.message);
    // Fallback: snapshot-based detection
    if (!topGappers.length) return;
    const now = Date.now();
    await Promise.all(topGappers.slice(0, 15).map(async (g) => {
      try {
        if (state.sentHalts.has(g.ticker)) return;
        const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${g.ticker}`);
        const td = snap && snap.ticker;
        if (!td) return;
        const lastTradeTime = (td.lastTrade && td.lastTrade.t) || 0;
        const lastQuoteTime = (td.lastQuote && td.lastQuote.t) || 0;
        if (!lastTradeTime || !lastQuoteTime) return;
        const tradeAge = (now - lastTradeTime) / 1000;
        const quoteAge = (now - lastQuoteTime) / 1000;
        if (tradeAge < 120 || quoteAge < 120 || g.volume < 50000) return;
        state.sentHalts.add(g.ticker);
        const minAgo = Math.floor(tradeAge / 60);
        const newsUrl = await getLatestNewsUrl(g.ticker);
        const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
        const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | ~${minAgo}m ago`;
        await post(WH.MAIN_CHAT, { content: line });
        await sleep(300);
        await post(WH.HALT_ALERTS, { content: line });
      } catch(e) {}
    }));
  }
  // Clear resumed tickers every cycle
  for (const ticker of [...state.sentHalts]) {
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;
      const lastTradeTime = (td.lastTrade && td.lastTrade.t) || 0;
      if (lastTradeTime > 0 && (Date.now() - lastTradeTime) / 1000 < 60) {
        state.sentHalts.delete(ticker);
        console.log(`[${etInfo.timeStr}] RESUMED: ${ticker}`);
      }
    } catch(e) {}
  }
}

// ── GREEN BARS SCANNER (3+ consecutive green 5m candles) ─────────────────────



async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();
  const from = now - 60 * 60 * 1000; // last 1 hour of candles

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: max once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (now - last < 15 * 60 * 1000) continue;

      const fromTs = Math.floor(from / 1000);
      const toTs = Math.floor(now / 1000);
      const data = await polyGet(`/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromTs}/${toTs}?adjusted=true&sort=desc&limit=10`);
      const results = (data && data.results) || [];
      if (results.length < 3) continue;

      // results[0] = most recent candle (sort=desc)
      // Check consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of results) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, now);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const fv = await getFinvizData(g.ticker);
      const si = fv.si !== '--' ? ` | SI: ${fv.si}` : '';
      const ctb = fv.ctb ? ` | ${fv.ctb}` : '';
      const regSho = fv.regSho ? ' | **Reg SHO**' : '';

      const label = greenCount >= 5 ? `${greenCount} green bars 5m` : `${greenCount} green bars 5m`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` · \`${label}\` ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)}${regSho}${si}${ctb}`;
      await post(WH.MAIN_CHAT, { content: line });
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} (${greenCount}x)`);
      await sleep(400);
    } catch(e) {}
    await sleep(150); // avoid rate limits
  }
}


// ── GREEN BARS DETECTION (5m consecutive green candles) ──────────────────────



async function checkGreenBars() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();

  for (const g of topGappers.slice(0, 20)) {
    try {
      // Cooldown: once per 15 min per ticker
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (Date.now() - last < 15 * 60 * 1000) continue;

      // Fetch 5-min aggregates from Polygon
      const now = new Date();
      const from = new Date(now - 60 * 60 * 1000); // last 60 min
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = now.toISOString().slice(0, 10);

      const aggs = await polyGet(
        `/v2/aggs/ticker/${g.ticker}/range/5/minute/${fromStr}/${toStr}?adjusted=true&sort=desc&limit=10`
      );

      if (!aggs || !aggs.results || aggs.results.length < 3) continue;

      const bars = aggs.results; // newest first
      // Count consecutive green bars (close > open)
      let greenCount = 0;
      for (const bar of bars) {
        if (bar.c > bar.o) greenCount++;
        else break;
      }

      if (greenCount < 3) continue;

      greenBarCooldown.set(g.ticker, Date.now());
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} ${greenCount}x 5m`);

      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const countLabel = greenCount >= 5 ? `${greenCount} 🔥` : `${greenCount}`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tickerLink} \`${priceFlag(g.price)}\` · ${countLabel} green bars 5m ~ 🇺🇸 | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
    } catch (e) {}
  }
}

// ── BREAKING NEWS ─────────────────────────────────────────────────────────────
async function checkBreakingNews() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const tickers = topGappers.map(g => g.ticker).join(',');
  try {
    const news = await fmpGet(`/stable/news/stock?symbols=${tickers}&limit=50`);
    if (!Array.isArray(news)) return;
    const cutoff = Date.now() - 5 * 60 * 1000;
    const fresh = news.filter(n => {
      if (!n.publishedDate) return false;
      const id = (n.url || n.title || '').slice(0, 100);
      return new Date(n.publishedDate).getTime() > cutoff && !state.sentNews.has(id);
    });
    for (const n of fresh.slice(0, 5)) {
      const id = (n.url || n.title || '').slice(0, 100);
      state.sentNews.add(id);
      const age = Math.floor((Date.now() - new Date(n.publishedDate).getTime()) / 60000);
      const sent = (n.sentiment || '').toLowerCase();
      const sentIcon = sent === 'positive' ? '📈' : sent === 'negative' ? '📉' : '📰';
      const ticker = n.symbol || n.symbols || '';
      const gapper = topGappers.find(g => g.ticker === ticker);
      const priceCtx = gapper ? ` \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\`` : '';
      const isOffering = /offering|shelf|ATM|dilut|direct offering|registered direct/i.test(n.title || '');
      const offerFlag = isOffering ? ' ⚠️' : '';
      const line = `\`${etInfo.timeStr}\` ${sentIcon}${offerFlag} **${ticker}**${priceCtx} ${age}m ago — ${(n.title || '').slice(0, 100)}\n<${n.url || ''}>`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      if (!state.sentPRs.has(id)) {
        state.sentPRs.add(id);
        const prLink2 = n.url ? ` | [PR →](<${n.url}>)` : '';
        const prLine = `\`${etInfo.timeStr}\` ${sentIcon}${offerFlag} **${ticker}**${priceCtx} ${age}m ago — ${(n.title || '').slice(0, 90)}${prLink2}`;
        await post(WH.PRESS_RELEASES, { content: prLine });
        await sleep(300);
      }
    }
    if (state.sentNews.size > 500) {
      const arr = [...state.sentNews]; state.sentNews.clear();
      arr.slice(-200).forEach(id => state.sentNews.add(id));
    }
  } catch (e) { console.error('checkBreakingNews:', e.message); }
}

// ── HALT DETECTION ───────────────────────────────────────────────────────────
async function checkHalts() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();

  // Check ALL top gappers via individual REST snapshots - no WebSocket dependency
  await Promise.all(topGappers.map(async (g) => {
    try {
      if (state.sentHalts.has(g.ticker)) return;

      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${g.ticker}`);
      const td = snap && snap.ticker;
      if (!td) return;

      const lastTradeTime = (td.lastTrade && td.lastTrade.t) || 0;
      const lastQuoteTime = (td.lastQuote && td.lastQuote.t) || 0;

      // Both must be set and stale > 2 minutes
      if (!lastTradeTime || !lastQuoteTime) return;
      const tradeAge = (now - lastTradeTime) / 1000;
      const quoteAge = (now - lastQuoteTime) / 1000;

      if (tradeAge < 120 || quoteAge < 120) return; // not halted
      if (g.volume < 50000) return; // needs real volume

      state.sentHalts.add(g.ticker);
      const minAgo = Math.floor(tradeAge / 60);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | Halted ~${minAgo}m ago`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      await post(WH.HALT_ALERTS, { content: line });
      console.log(`[${etInfo.timeStr}] HALT: ${g.ticker} (${minAgo}m ago)`);
    } catch(e) {}
  }));

  // Clear resumed tickers
  for (const ticker of state.sentHalts) {
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;
      const lastTradeTime = (td.lastTrade && td.lastTrade.t) || 0;
      if (lastTradeTime > 0 && (now - lastTradeTime) / 1000 < 60) {
        state.sentHalts.delete(ticker);
        console.log(`[${etInfo.timeStr}] RESUMED: ${ticker}`);
      }
    } catch(e) {}
  }
}

// ── SEC FILINGS (all form types) ────────────────────────────────────────────
let lastFilingCheck = 0;
async function checkSECFilings() {
  if (!isActiveSession() || !topGappers.length) return;
  if (Date.now() - lastFilingCheck < 5 * 60 * 1000) return;
  lastFilingCheck = Date.now();
  const etInfo = getETInfo();
  const cutoff = Date.now() - 30 * 60 * 1000;

  for (const g of topGappers.slice(0, 15)) {
    try {
      // Fetch ALL recent filings not just 8-K
      const filings = await fmpGet(`/stable/sec-filings?symbol=${g.ticker}&limit=5`);
      if (!Array.isArray(filings)) continue;
      for (const f of filings) {
        const filed = new Date(f.date || f.filledDate || f.acceptedDate || 0).getTime();
        const id = (f.link || f.url || f.title || '').slice(0, 80);
        if (filed <= cutoff || state.sentFilings.has(id)) continue;
        state.sentFilings.add(id);
        const formType = (f.formType || f.type || 'SEC').toUpperCase();
        const link = f.link || f.url || '';
        const isDilutive = /S-3|S-1|424B|ATM|DEFA14/.test(formType);
        const linkStr = link ? ` — [Link](<${link}>)` : '';
        const flag = isDilutive ? ' ⚠️' : '';
        // Simple NuntioBot-style format
        const line = `\`${etInfo.timeStr}\` **SEC** **${g.ticker}**${flag} — Form ${formType}${linkStr}`;
        await post(WH.SEC_FILINGS, { content: line });
        await sleep(300);
        // Also post to main-chat
        const mainLine = `\`${etInfo.timeStr}\` **SEC** **${g.ticker}**${flag} — Form ${formType} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\`${linkStr}`;
        await post(WH.MAIN_CHAT, { content: mainLine });
        await sleep(300);
        console.log(`[${etInfo.timeStr}] SEC: ${g.ticker} ${formType}`);
      }
      await sleep(150);
    } catch(e) {}
  }
}

// ── MORNING SNAPSHOT ──────────────────────────────────────────────────────────
async function checkMorningSnapshot() {
  const etInfo = getETInfo();
  if ((etInfo.h !== 6 && etInfo.h !== 7) || etInfo.m !== 0) return;
  const key = `${new Date().toISOString().slice(0, 10)}_${etInfo.h}`;
  if (state.morningPosted.has(key)) return;
  state.morningPosted.add(key);
  await refreshTopGappers();
  if (!topGappers.length) return;
  let adv = '--', dec = '--', unch = '--';
  try {
    const snap = await polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true');
    const tks = (snap && snap.tickers) || [];
    const a = tks.filter(t => (t.todaysChangePerc || 0) > 0.1).length;
    const d = tks.filter(t => (t.todaysChangePerc || 0) < -0.1).length;
    adv = a; dec = d; unch = tks.length - a - d;
  } catch (e) {}
  let rows = '';
  topGappers.forEach(g => {
    const dot = g.chgPct >= 200 ? '🔴' : g.chgPct >= 100 ? '🟠' : g.chgPct >= 50 ? '🟡' : '🟢';
    rows += `${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}\n`;
  });
  await post(WH.TOP_GAPPERS, {
    content: `# ${etInfo.h === 6 ? '🌅 6AM' : '☀️ 7AM'} Pre-Market Scan`,
    embeds: [{
      title: `📊 Top ${topGappers.length} Gappers ($0.10–$20)`,
      description: rows || 'No data',
      color: 0x00d4ff,
      fields: [{ name: 'Market Breadth', value: `🟢 ADV: ${adv}  🔴 DEC: ${dec}  ⚪ UNCH: ${unch}`, inline: false }],
      footer: { text: `AziziBot · ${etInfo.timeStr} ET · Polygon.io` },
      timestamp: new Date().toISOString()
    }]
  });
  console.log(`[${etInfo.timeStr}] Morning snapshot posted`);
}

// ── POLYGON WEBSOCKET ─────────────────────────────────────────────────────────
let ws = null;
function connectWebSocket() {
  if (ws) { try { ws.terminate(); } catch (e) {} }
  console.log('Connecting to Polygon WebSocket...');
  ws = new WebSocket('wss://socket.polygon.io/stocks');

  ws.on('open', () => {
    ws.send(JSON.stringify({ action: 'auth', params: POLY_KEY }));
  });

  ws.on('message', (data) => {
    try {
      const messages = JSON.parse(data.toString());
      for (const msg of messages) {
        if (msg.ev === 'status' && msg.status === 'auth_success') {
          // Subscribe to trades + second aggregates for top gappers
          // Also subscribe to status feed for real halt events
          const tickerSubs = topGappers.map(g => `T.${g.ticker}`).join(',');
          const aggSubs = topGappers.map(g => `A.${g.ticker}`).join(',');
          const allSubs = [tickerSubs, aggSubs].filter(Boolean).join(',');
          if (allSubs) ws.send(JSON.stringify({ action: 'subscribe', params: allSubs }));
          console.log(`WebSocket subscribed to ${topGappers.length} tickers (trades + aggregates)`);
        }
        if (msg.ev === 'T') {
          // Individual trade - most real-time
          const ticker = msg.sym;
          const price = msg.p;
          const now = Date.now();
          state.lastTrade.set(ticker, msg.t || now);
          // Track price history for after-lull detection
          if (!state.priceHistory.has(ticker)) state.priceHistory.set(ticker, []);
          const hist = state.priceHistory.get(ticker);
          hist.push({ price, time: now });
          // Keep only last 60 entries
          if (hist.length > 60) hist.shift();
          const s = state.tickers.get(ticker);
          if (s && price > s.high + 0.001) {
            checkNHODForTicker(ticker, price).catch(() => {});
          }
        }
        if (msg.ev === 'A') {
          // Per-second aggregate - backup for NHOD detection
          const ticker = msg.sym;
          const price = msg.c || msg.h || 0; // close of the second
          if (!price) return;
          state.lastTrade.set(ticker, msg.e || Date.now()); // end timestamp
          const s = state.tickers.get(ticker);
          if (s && price > s.high + 0.001) {
            checkNHODForTicker(ticker, price).catch(() => {});
          }
        }
      }
    } catch (e) {}
  });

  ws.on('error', err => console.error('WS error:', err.message));
  ws.on('close', () => {
    console.log('WS closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });
}

// Resubscribe when gapper list updates
function resubscribeWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN && topGappers.length) {
    const tickerSubs = topGappers.map(g => `T.${g.ticker}`).join(',');
    const aggSubs = topGappers.map(g => `A.${g.ticker}`).join(',');
    ws.send(JSON.stringify({ action: 'subscribe', params: tickerSubs + ',' + aggSubs }));
    console.log(`[${getETInfo().timeStr}] Resubscribed to ${topGappers.length} tickers (trades+aggs)`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 AziziBot starting...');
  await refreshTopGappers();
  connectWebSocket();

  // Refresh gappers every 60s and resubscribe WS
  setInterval(async () => {
    await refreshTopGappers();
    resubscribeWebSocket();
  }, 60 * 1000);

  // Poll every 60s for news, halts, filings, morning snapshot
  setInterval(async () => {
    await checkMorningSnapshot();
    await checkGreenBars();
    await checkBreakingNews();
    await checkHalts();
    await checkSECFilings();
  }, 60 * 1000);

  console.log('🤖 AziziBot running. Real-time alerts active.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
