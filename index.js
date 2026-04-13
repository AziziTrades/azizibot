// AziziBot v2 — Real-time Discord alerts
// Railway.app Node.js 18+

const https = require('https');
const WebSocket = require('ws');

const POLY_KEY   = '5jLrhuNS7DQZCp3eZpKHiuCBxuTddlLc';
const FMP_KEY    = 'nBekBFFFeKcrOj6Nd95DiF43jEEkJDW4';
const FINVIZ_KEY = '6a7d3078-e6c0-4537-823f-b140c3b0dcb6';
const BOT_NAME   = 'AziziBot';

const WH = {
  TOP_GAPPERS:    'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3',
  PRESS_RELEASES: 'https://discord.com/api/webhooks/1493289596732309657/tuhNqm8r3VB2k1rNcWDq487BNiPdlluNjDBX45IpdshxZv969Uskq1z3jKJ3AtGzkLdb',
  HALT_ALERTS:    'https://discord.com/api/webhooks/1493289994075242538/Jo3kfIzST8pqSAcxUbQ2_nzeWbQACDee4DTydBCZW5WcQjHBAdxA2jNeynkGafte7g5T',
  SEC_FILINGS:    'https://discord.com/api/webhooks/1493290146068697259/VPRB_3eUUyQReJpF_XkqeC324FKTVbARCf15jvOSb33lKguSdlf3eR1euWnsV6gq2enj',
  MAIN_CHAT:      'https://discord.com/api/webhooks/1493201376484786217/Hv4PUUUVCVTa80ukQuR5pUc5wa5ZrXAfGtAdqa2KLoEN3WJ7h79hZiXzEMIzQ9-IfmRW'
};

// ── ET TIME ───────────────────────────────────────────────────────────────────
function getETInfo() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const h = parseInt(p.find(x => x.type === 'hour').value);
  const m = parseInt(p.find(x => x.type === 'minute').value);
  const hh = h === 24 ? 0 : h;
  const etMin = hh * 60 + m;
  const timeStr = now.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
  const sess = etMin >= 240 && etMin < 570 ? 'PRE-MARKET' : etMin >= 570 && etMin < 960 ? 'MARKET' : etMin >= 960 && etMin < 1200 ? 'AFTER-HOURS' : 'CLOSED';
  return { h: hh, m, etMin, timeStr, sess };
}
function isActive() { const { etMin } = getETInfo(); return etMin >= 240 && etMin < 1200; }

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
  if (p < 1) return '<$1';
  if (p < 2) return '<$2';
  if (p < 5) return '<$5';
  if (p < 10) return '<$10';
  return '<$20';
}
function countryFlag(ticker) {
  if (/^[A-Z]{2,4}(AO|BO|O|Y|YY)$/.test(ticker)) return '🇨🇳';
  if (/^[A-Z]{2,4}L$/.test(ticker)) return '🇬🇧';
  return '🇺🇸';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP ──────────────────────────────────────────────────────────────────────
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'AziziBot/1.0' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve(null); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}
function polyGet(path) { const sep = path.includes('?') ? '&' : '?'; return httpGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`); }
function fmpGet(path)  { const sep = path.includes('?') ? '&' : '?'; return httpGet(`https://financialmodelingprep.com${path}${sep}apikey=${FMP_KEY}`); }

async function post(webhook, payload) {
  payload.username = BOT_NAME;
  return new Promise(resolve => {
    const body = JSON.stringify(payload);
    const u = new URL(webhook);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', () => resolve(0));
    req.setTimeout(5000, () => { req.destroy(); resolve(0); });
    req.write(body); req.end();
  });
}

// ── ENRICHMENT ────────────────────────────────────────────────────────────────
async function getFinvizData(ticker) {
  const result = { si: '--', regSho: false, ctb: '' };
  try {
    const html = await new Promise((resolve, reject) => {
      const req = https.get(`https://elite.finviz.com/quote.ashx?t=${ticker}&auth=${FINVIZ_KEY}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Cookie': `finvizAuth=${FINVIZ_KEY}`, 'Referer': 'https://elite.finviz.com/' }
      }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(d)); });
      req.on('error', reject);
      req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')); });
    });
    const siM = html.match(/Short Float[^>]*>([\d.]+%)/i);
    if (siM) result.si = siM[1];
    result.regSho = /Reg SHO.*?Yes/i.test(html);
    const ctbM = html.match(/CTB[^>]*>([^<]{1,15})<\/td>/i);
    if (ctbM) { const v = ctbM[1].trim(); result.ctb = /high/i.test(v) ? 'High CTB' : /low/i.test(v) ? 'Low CTB' : ''; }
  } catch(e) {}
  return result;
}
async function getLatestNewsUrl(ticker) {
  try { const n = await fmpGet(`/stable/news/stock?symbols=${ticker}&limit=1`); if (Array.isArray(n) && n.length && n[0].url) return n[0].url; } catch(e) {}
  return null;
}
async function getRecentSplit(ticker) {
  try {
    const splits = await fmpGet(`/stable/splits?symbol=${ticker}`);
    if (Array.isArray(splits) && splits.length) {
      const s = splits.find(s => { const d = (Date.now() - new Date(s.date).getTime()) / 86400000; return d <= 90 && s.denominator > s.numerator; });
      if (s) { const d = new Date(s.date); return `${s.numerator} for ${s.denominator} R/S ${d.toLocaleString('en-US', { month: 'short' })}. ${d.getDate()}`; }
    }
  } catch(e) {}
  return null;
}

// ── STATE ─────────────────────────────────────────────────────────────────────
const state = {
  tickers: new Map(),      // ticker -> {high, nhod, price, chgPct, volume, rvol}
  sentNews: new Set(),
  sentHalts: new Set(),
  sentFilings: new Set(),
  morningPosted: new Set(),
  lastTrade: new Map(),
  priceHistory: new Map(), // ticker -> [{price, time}]
};
let topGappers = [];
const nhoodCooldown = new Map();
const greenBarCooldown = new Map();
let lastFilingCheck = 0;

// ── FETCH TOP GAPPERS ─────────────────────────────────────────────────────────
async function refreshTopGappers() {
  try {
    // Fetch gainers + actives to catch all movers like SNYR
    const [pg, pa] = await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=true&sort=changePercent&direction=desc&limit=100')
    ]);

    const merge = new Map();
    const process = (t) => {
      const lp = (t.lastTrade && t.lastTrade.p) || (t.day && t.day.c) || 0;
      const prev = (t.prevDay && t.prevDay.c) || 0;
      const chg = lp > 0 && prev > 0 ? ((lp - prev) / prev) * 100 : (t.todaysChangePerc || 0);
      const vol = (t.day && t.day.v) || (t.min && t.min.av) || 0;
      const prevVol = (t.prevDay && t.prevDay.v) || 0;
      const rvol = prevVol > 0 ? vol / prevVol : 0;
      const high = (t.day && t.day.h) || lp;
      return { ticker: t.ticker, price: lp, prev, chgPct: chg, volume: vol, prevVol, rvol, high };
    };

    for (const t of ((pg && pg.tickers) || [])) merge.set(t.ticker, process(t));
    for (const t of ((pa && pa.tickers) || [])) { if (!merge.has(t.ticker)) merge.set(t.ticker, process(t)); }

    topGappers = [...merge.values()]
      .filter(t => t.chgPct >= 5 && t.price >= 0.1 && t.price <= 20)
      .sort((a, b) => b.chgPct - a.chgPct)
      .slice(0, 40);

    // Update state
    for (const g of topGappers) {
      const ex = state.tickers.get(g.ticker) || { high: 0, nhod: 0 };
      state.tickers.set(g.ticker, { ...ex, price: g.price, prev: g.prev, chgPct: g.chgPct, volume: g.volume, rvol: g.rvol, high: Math.max(g.high, ex.high) });
    }
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} gappers refreshed`);
  } catch(e) { console.error('refreshTopGappers:', e.message); }
}

// ── NHOD (WebSocket-triggered) ────────────────────────────────────────────────
async function checkNHODForTicker(ticker, price) {
  if (!isActive()) return;
  const etInfo = getETInfo();
  const gapper = topGappers.find(g => g.ticker === ticker);
  if (!gapper) return;
  const s = state.tickers.get(ticker);
  if (!s) return;
  if (price <= s.high + 0.001) return;

  const nhod = (s.nhod || 0) + 1;
  state.tickers.set(ticker, { ...s, high: price, nhod });

  // 10 min cooldown per ticker
  const last = nhoodCooldown.get(ticker) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  nhoodCooldown.set(ticker, Date.now());
  console.log(`[${etInfo.timeStr}] NHOD ${ticker} $${price.toFixed(2)} (${nhod}x)`);

  const [fv, newsUrl, rs] = await Promise.all([getFinvizData(ticker), getLatestNewsUrl(ticker), getRecentSplit(ticker)]);

  // IO% and MC
  let ioStr = '', mcStr = '';
  try {
    const profile = await fmpGet(`/stable/profile?symbol=${ticker}`);
    const p = Array.isArray(profile) ? profile[0] : profile;
    if (p) {
      const io = p.institutionalOwnershipPercentage || p.institutionalOwnership || 0;
      const mc = p.mktCap || p.marketCap || 0;
      if (io > 0) ioStr = ` | IO: ${(io < 1 ? io * 100 : io).toFixed(2)}%`;
      if (mc > 0) mcStr = ` | MC: ${fmtN(mc)}`;
    }
  } catch(e) {}

  // After-lull detection
  let afterLull = '';
  const hist = state.priceHistory.get(ticker) || [];
  if (hist.length >= 10) {
    const old = hist.filter(h => h.time < Date.now() - 10 * 60 * 1000);
    if (old.length >= 3) {
      const oHigh = Math.max(...old.map(h => h.price));
      const oLow = Math.min(...old.map(h => h.price));
      if ((oHigh - oLow) / oLow < 0.02 && price > oHigh * 1.03) afterLull = ' · `after-lull`';
    }
  }

  const tickerLink = newsUrl ? `[${ticker}](<${newsUrl}>)` : `**${ticker}**`;
  const hodLabel = nhod === 1 ? 'NSH' : `${nhod} NHOD`;
  const flag = countryFlag(ticker);
  const regSho = fv.regSho ? ' | **Reg SHO**' : '';
  const si = fv.si !== '--' ? ` | SI: ${fv.si}` : '';
  const ctb = fv.ctb ? ` | ${fv.ctb}` : '';
  const rsStr = rs ? ` | ${rs}` : '';

  const line = `\`${etInfo.timeStr}\` ↑ ${tickerLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${hodLabel}${afterLull} ~ ${flag}${ioStr}${mcStr} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${regSho}${si}${ctb}${rsStr}`;
  await post(WH.MAIN_CHAT, { content: line });
}

// ── BREAKING NEWS ─────────────────────────────────────────────────────────────
async function checkBreakingNews() {
  if (!isActive() || !topGappers.length) return;
  const etInfo = getETInfo();
  try {
    const tickers = topGappers.map(g => g.ticker).join(',');
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
      const ageSec = Math.floor((Date.now() - new Date(n.publishedDate).getTime()) / 1000);
      const ageStr = ageSec < 60 ? `${ageSec} seconds ago` : `${Math.floor(ageSec / 60)} min ago`;
      const ticker = n.symbol || n.symbols || '';
      const title = (n.title || '').slice(0, 200);
      const link = n.url || '';
      const isOffering = /offering|shelf|ATM|dilut|direct offering|registered direct/i.test(title);
      const color = isOffering ? 0xf0a500 : (n.sentiment || '').toLowerCase() === 'positive' ? 0x39d353 : (n.sentiment || '').toLowerCase() === 'negative' ? 0xf85149 : 0x5865f2;
      // Embed to press-releases (NuntioBot style)
      await post(WH.PRESS_RELEASES, { embeds: [{ title: `${ticker} — ${ageStr}`, description: `${title}\n${link ? `[Link](<${link}>)` : ''}`, color, timestamp: new Date(n.publishedDate).toISOString() }] });
      await sleep(300);
      // Compact to main-chat
      const gapper = topGappers.find(g => g.ticker === ticker);
      const priceCtx = gapper ? ` \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\`` : '';
      const sentIcon = (n.sentiment || '').toLowerCase() === 'positive' ? '📈' : (n.sentiment || '').toLowerCase() === 'negative' ? '📉' : '📰';
      await post(WH.MAIN_CHAT, { content: `\`${etInfo.timeStr}\` ${sentIcon}${isOffering ? ' ⚠️' : ''} **${ticker}**${priceCtx} ${ageStr} — ${title.slice(0, 90)}${link ? ` | [PR →](<${link}>)` : ''}` });
      await sleep(300);
    }
    if (state.sentNews.size > 500) { const a = [...state.sentNews]; state.sentNews.clear(); a.slice(-200).forEach(id => state.sentNews.add(id)); }
  } catch(e) { console.error('checkBreakingNews:', e.message); }
}

// ── HALT DETECTION ────────────────────────────────────────────────────────────
async function checkHalts() {
  if (!isActive() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();
  for (const g of topGappers) {
    try {
      if (state.sentHalts.has(g.ticker)) continue;
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${g.ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;
      const lastTradeMs = (td.lastTrade && td.lastTrade.t) || 0;
      const lastQuoteMs = (td.lastQuote && td.lastQuote.t) || 0;
      if (!lastTradeMs || !lastQuoteMs) continue;
      const tradeAge = (now - lastTradeMs) / 1000;
      const quoteAge = (now - lastQuoteMs) / 1000;
      if (tradeAge < 120 || quoteAge < 120 || g.volume < 75000) continue;
      state.sentHalts.add(g.ticker);
      const minAgo = Math.floor(tradeAge / 60);
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ ${countryFlag(g.ticker)} | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)} | ~${minAgo}m ago`;
      await post(WH.MAIN_CHAT, { content: line });
      await sleep(300);
      await post(WH.HALT_ALERTS, { content: line });
      console.log(`[${etInfo.timeStr}] HALT: ${g.ticker}`);
    } catch(e) {}
  }
  // Resume detection
  for (const ticker of [...state.sentHalts]) {
    try {
      const snap = await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
      const td = snap && snap.ticker;
      if (!td) continue;
      const lastTradeMs = (td.lastTrade && td.lastTrade.t) || 0;
      if (lastTradeMs > 0 && (now - lastTradeMs) / 1000 < 60) {
        state.sentHalts.delete(ticker);
        const g = topGappers.find(x => x.ticker === ticker);
        if (g) {
          const newsUrl = await getLatestNewsUrl(ticker);
          const tLink = newsUrl ? `[${ticker}](<${newsUrl}>)` : `**${ticker}**`;
          const line = `\`${etInfo.timeStr}\` ▶️ **RESUMED** ${tLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ ${countryFlag(ticker)} | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)}`;
          await post(WH.MAIN_CHAT, { content: line });
          await sleep(300);
          await post(WH.HALT_ALERTS, { content: line });
        }
        console.log(`[${etInfo.timeStr}] RESUMED: ${ticker}`);
      }
    } catch(e) {}
  }
}

// ── GREEN BARS ────────────────────────────────────────────────────────────────
async function checkGreenBars() {
  if (!isActive() || !topGappers.length) return;
  const etInfo = getETInfo();
  for (const g of topGappers.slice(0, 20)) {
    try {
      const last = greenBarCooldown.get(g.ticker) || 0;
      if (Date.now() - last < 15 * 60 * 1000) continue;
      const now = new Date();
      const from = new Date(now - 60 * 60 * 1000).toISOString().slice(0, 10);
      const to = now.toISOString().slice(0, 10);
      const aggs = await polyGet(`/v2/aggs/ticker/${g.ticker}/range/5/minute/${from}/${to}?adjusted=true&sort=desc&limit=10`);
      if (!aggs || !aggs.results || aggs.results.length < 3) continue;
      let greenCount = 0;
      for (const bar of aggs.results) { if (bar.c > bar.o) greenCount++; else break; }
      if (greenCount < 3) continue;
      greenBarCooldown.set(g.ticker, Date.now());
      const newsUrl = await getLatestNewsUrl(g.ticker);
      const tLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
      const line = `\`${etInfo.timeStr}\` ↗ ${tLink} \`${priceFlag(g.price)}\` · ${greenCount}${greenCount >= 5 ? ' 🔥' : ''} green bars 5m ~ ${countryFlag(g.ticker)} | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``;
      await post(WH.MAIN_CHAT, { content: line });
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} ${greenCount}x`);
    } catch(e) {}
  }
}

// ── SEC FILINGS ───────────────────────────────────────────────────────────────
async function checkSECFilings() {
  if (!isActive() || !topGappers.length) return;
  if (Date.now() - lastFilingCheck < 5 * 60 * 1000) return;
  lastFilingCheck = Date.now();
  const etInfo = getETInfo();
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const g of topGappers.slice(0, 15)) {
    try {
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
        const line = `\`${etInfo.timeStr}\` **SEC** **${g.ticker}**${isDilutive ? ' ⚠️' : ''} — Form ${formType}${linkStr}`;
        await post(WH.SEC_FILINGS, { content: line });
        await sleep(300);
        await post(WH.MAIN_CHAT, { content: `${line} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\`` });
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
  if (!topGappers.length) return;
  let adv = '--', dec = '--', unch = '--';
  try {
    const snap = await polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true');
    const tks = (snap && snap.tickers) || [];
    const a = tks.filter(t => (t.todaysChangePerc || 0) > 0.1).length;
    const d = tks.filter(t => (t.todaysChangePerc || 0) < -0.1).length;
    adv = a; dec = d; unch = tks.length - a - d;
  } catch(e) {}
  let rows = '';
  topGappers.forEach(g => {
    const dot = g.chgPct >= 200 ? '🔴' : g.chgPct >= 100 ? '🟠' : g.chgPct >= 50 ? '🟡' : '🟢';
    rows += `${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}\n`;
  });
  await post(WH.TOP_GAPPERS, {
    content: `# ${etInfo.h === 6 ? '🌅 6AM' : '☀️ 7AM'} Pre-Market Scan`,
    embeds: [{ title: `📊 Top ${topGappers.length} Gappers ($0.10–$20)`, description: rows || 'No data', color: 0x00d4ff, fields: [{ name: 'Market Breadth', value: `🟢 ADV: ${adv}  🔴 DEC: ${dec}  ⚪ UNCH: ${unch}`, inline: false }], footer: { text: `AziziBot · ${etInfo.timeStr} ET · Polygon.io` }, timestamp: new Date().toISOString() }]
  });
  console.log(`[${etInfo.timeStr}] Morning snapshot posted`);
}

// ── WEBSOCKET ─────────────────────────────────────────────────────────────────
let ws = null;
function connectWebSocket() {
  if (ws) { try { ws.terminate(); } catch(e) {} }
  console.log('Connecting to Polygon WebSocket...');
  ws = new WebSocket('wss://socket.polygon.io/stocks');
  ws.on('open', () => ws.send(JSON.stringify({ action: 'auth', params: POLY_KEY })));
  ws.on('message', data => {
    try {
      for (const msg of JSON.parse(data.toString())) {
        if (msg.ev === 'status' && msg.status === 'auth_success') {
          const subs = topGappers.map(g => `T.${g.ticker},A.${g.ticker}`).join(',');
          if (subs) ws.send(JSON.stringify({ action: 'subscribe', params: subs }));
          console.log(`WebSocket subscribed to ${topGappers.length} tickers`);
        }
        if (msg.ev === 'T' || msg.ev === 'A') {
          const ticker = msg.sym;
          const price = msg.ev === 'T' ? msg.p : (msg.c || msg.h || 0);
          const ts = msg.ev === 'T' ? (msg.t || Date.now()) : (msg.e || Date.now());
          if (!price) continue;
          state.lastTrade.set(ticker, ts);
          if (!state.priceHistory.has(ticker)) state.priceHistory.set(ticker, []);
          const hist = state.priceHistory.get(ticker);
          hist.push({ price, time: Date.now() });
          if (hist.length > 60) hist.shift();
          const s = state.tickers.get(ticker);
          if (s && price > s.high + 0.001) checkNHODForTicker(ticker, price).catch(() => {});
        }
      }
    } catch(e) {}
  });
  ws.on('error', err => console.error('WS error:', err.message));
  ws.on('close', () => { console.log('WS closed, reconnecting in 5s...'); setTimeout(connectWebSocket, 5000); });
}
function resubscribeWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN && topGappers.length) {
    const subs = topGappers.map(g => `T.${g.ticker},A.${g.ticker}`).join(',');
    ws.send(JSON.stringify({ action: 'subscribe', params: subs }));
    console.log(`[${getETInfo().timeStr}] Resubscribed to ${topGappers.length} tickers`);
  }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🤖 AziziBot starting...');
  await refreshTopGappers();
  connectWebSocket();
  // Refresh gappers + resubscribe every 60s
  setInterval(async () => { await refreshTopGappers(); resubscribeWebSocket(); }, 60 * 1000);
  // Poll every 60s
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
