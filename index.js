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
    .filter(t => t.chgPct >= 5 && t.price >= 0.1 && t.price <= 20)
    .sort((a, b) => b.chgPct - a.chgPct)
    .slice(0, 15);

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
  if (Date.now() - last < 5 * 60 * 1000) return;
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

  const line = `\`${etInfo.timeStr}\` ↑ ${tickerLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${nhod} NHOD ~ 🇺🇸 | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${regSho}${si}${ctb}${rsStr}`;
  await post(WH.MAIN_CHAT, { content: line });
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
        await post(WH.PRESS_RELEASES, { content: line });
        await sleep(300);
      }
    }
    if (state.sentNews.size > 500) {
      const arr = [...state.sentNews]; state.sentNews.clear();
      arr.slice(-200).forEach(id => state.sentNews.add(id));
    }
  } catch (e) { console.error('checkBreakingNews:', e.message); }
}

// ── HALT DETECTION ────────────────────────────────────────────────────────────
async function checkHalts() {
  if (!isActiveSession() || !topGappers.length) return;
  const etInfo = getETInfo();
  const now = Date.now();
  for (const g of topGappers) {
    const lastTrade = state.lastTrade.get(g.ticker) || 0;
    const secsSince = lastTrade > 0 ? (now - lastTrade) / 1000 : 9999;
    if (secsSince < 180 || g.volume < 5000) continue;
    if (state.sentHalts.has(g.ticker)) continue;
    state.sentHalts.add(g.ticker);
    const minAgo = Math.floor(secsSince / 60);
    const newsUrl = await getLatestNewsUrl(g.ticker);
    const tickerLink = newsUrl ? `[${g.ticker}](<${newsUrl}>)` : `**${g.ticker}**`;
    const line = `\`${etInfo.timeStr}\` ⏸ **HALT** ${tickerLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` ~ 🇺🇸 | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | Last trade: ${minAgo}m ago`;
    await post(WH.MAIN_CHAT, { content: line });
    await sleep(300);
    await post(WH.HALT_ALERTS, { content: line });
    await sleep(300);
    console.log(`[${etInfo.timeStr}] HALT: ${g.ticker}`);
  }
  // Clear resumed tickers
  for (const [ticker, lt] of state.lastTrade.entries()) {
    if ((now - lt) / 1000 < 60) state.sentHalts.delete(ticker);
  }
}

// ── SEC FILINGS ───────────────────────────────────────────────────────────────
let lastFilingCheck = 0;
async function checkSECFilings() {
  if (!isActiveSession() || !topGappers.length) return;
  if (Date.now() - lastFilingCheck < 5 * 60 * 1000) return;
  lastFilingCheck = Date.now();
  const etInfo = getETInfo();
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const g of topGappers.slice(0, 10)) {
    try {
      const filings = await fmpGet(`/stable/rss-feed-8k?symbol=${g.ticker}&limit=5`);
      if (!Array.isArray(filings)) continue;
      for (const f of filings.slice(0, 2)) {
        const filed = new Date(f.date || f.filledDate || f.acceptedDate || 0).getTime();
        const id = (f.link || f.url || f.title || '').slice(0, 80);
        if (filed <= cutoff || state.sentFilings.has(id)) continue;
        state.sentFilings.add(id);
        const formType = (f.formType || f.type || 'SEC').toUpperCase();
        const link = f.link || f.url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${g.ticker}`;
        const isDilutive = /S-3|S-1|424B|ATM|DEFA14/i.test(formType);
        const isUrgent = /8-K/i.test(formType);
        const icon = isDilutive ? '💧' : isUrgent ? '📋' : '📄';
        const flag = isDilutive ? ' ⚠️ **DILUTION RISK**' : isUrgent ? ' 📌' : '';
        const line = `\`${etInfo.timeStr}\` ${icon} **${g.ticker}** \`${formType}\`${flag} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\` | [View Filing](<${link}>)`;
        await post(WH.SEC_FILINGS, { content: line });
        await sleep(300);
        await post(WH.MAIN_CHAT, { content: line });
        await sleep(300);
      }
      await sleep(200);
    } catch (e) {}
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
          // Subscribe only to our top 15 gappers for efficiency
          const subs = topGappers.map(g => `T.${g.ticker}`).join(',');
          if (subs) ws.send(JSON.stringify({ action: 'subscribe', params: subs }));
          console.log(`WebSocket subscribed to ${topGappers.length} tickers`);
        }
        if (msg.ev === 'T') {
          const ticker = msg.sym;
          const price = msg.p;
          state.lastTrade.set(ticker, msg.t || Date.now());
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
    const subs = topGappers.map(g => `T.${g.ticker}`).join(',');
    ws.send(JSON.stringify({ action: 'subscribe', params: subs }));
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
    await checkBreakingNews();
    await checkHalts();
    await checkSECFilings();
  }, 60 * 1000);

  console.log('🤖 AziziBot running. Real-time alerts active.');
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
