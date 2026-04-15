// AziziBot v6 — Matches NuntioBot behavior exactly
// Railway.app — Node.js 18+

const https = require('https');
const WebSocket = require('ws');

const POLY_KEY      = process.env.POLY_KEY||'';
const BZ_KEY        = process.env.BZ_KEY||'';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN||'';
const APP_ID        = '1493671812247322624';
const BOT_NAME      = 'AziziBot';

const WH = {
  TOP_GAPPERS:    'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3',
  PRESS_RELEASES: 'https://discord.com/api/webhooks/1493289596732309657/tuhNqm8r3VB2k1rNcWDq487BNiPdlluNjDBX45IpdshxZv969Uskq1z3jKJ3AtGzkLdb',
  HALT_ALERTS:    'https://discord.com/api/webhooks/1493289994075242538/Jo3kfIzST8pqSAcxUbQ2_nzeWbQACDee4DTydBCZW5WcQjHBAdxA2jNeynkGafte7g5T',
  SEC_FILINGS:    'https://discord.com/api/webhooks/1493290146068697259/VPRB_3eUUyQReJpF_XkqeC324FKTVbARCf15jvOSb33lKguSdlf3eR1euWnsV6gq2enj',
  MAIN_CHAT:      'https://discord.com/api/webhooks/1493201376484786217/Hv4PUUUVCVTa80ukQuR5pUc5wa5ZrXAfGtAdqa2KLoEN3WJ7h79hZiXzEMIzQ9-IfmRW'
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getETInfo(){
  const now=new Date();
  const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',second:'numeric',hour12:false}).formatToParts(now);
  const h=parseInt(p.find(x=>x.type==='hour').value);
  const m=parseInt(p.find(x=>x.type==='minute').value);
  const s=parseInt(p.find(x=>x.type==='second').value);
  const hh=h===24?0:h;
  const etMin=hh*60+m;
  const timeStr=`${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const sess=etMin>=240&&etMin<570?'PRE-MARKET':etMin>=570&&etMin<960?'MARKET':etMin>=960&&etMin<1200?'AFTER-HOURS':'CLOSED';
  return{h:hh,m,s,etMin,timeStr,sess};
}
function isActive(){const{etMin}=getETInfo();return etMin>=240&&etMin<1200;}
function fmtN(n){if(!n||isNaN(n))return'--';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function fmtRVol(r){if(!r||isNaN(r)||r===0)return'--';if(r>=1000)return Math.round(r).toLocaleString()+'x';if(r>=10)return r.toFixed(0)+'x';return r.toFixed(1)+'x';}
function priceFlag(p){if(p<1)return'<$1';if(p<2)return'<$2';if(p<5)return'<$5';if(p<10)return'<$10';return'<$20';}
function countryFlag(t){
  // Use Polygon ticker details for accurate country — falls back to pattern
  const c=tickerCountry.get(t);
  if(c==='IL')return'🇮🇱';if(c==='CN')return'🇨🇳';if(c==='GB')return'🇬🇧';if(c==='CA')return'🇨🇦';
  if(/^[A-Z]{2,4}(AO|BO|O|Y|YY)$/.test(t))return'🇨🇳';
  if(/^[A-Z]{2,4}L$/.test(t))return'🇬🇧';
  return'🇺🇸';
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function isOTC(ticker){
  // 5-letter OTC suffixes: F=foreign, Q=bankruptcy, E=delinquent, X=mutual fund
  if(/^[A-Z]{5}$/.test(ticker)&&/[FQEX]$/.test(ticker))return true;
  // Warrants: ticker ending in W or WS (e.g. RGTIW, SLAPW)
  if(/W$|WS$/.test(ticker))return true;
  // Rights: ticker ending in R (e.g. ACMCR)
  if(/^[A-Z]{4,5}R$/.test(ticker))return true;
  // Units: ticker ending in U (e.g. IPAXU)
  if(/^[A-Z]{4,5}U$/.test(ticker))return true;
  // Contains dot (e.g. BRK.A)
  if(ticker.includes('.'))return true;
  return false;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function rawGet(url,headers={}){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'AziziBot/1.0',...headers}},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(8000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
async function jsonGet(url){try{return JSON.parse(await rawGet(url));}catch(e){return null;}}
function polyGet(path){const sep=path.includes('?')?'&':'?';return jsonGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`);}

async function post(webhook,payload){
  payload.username=BOT_NAME;
  return new Promise(resolve=>{
    const body=JSON.stringify(payload);
    const u=new URL(webhook);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',()=>resolve(0));
    req.setTimeout(5000,()=>{req.destroy();resolve(0);});
    req.write(body);req.end();
  });
}

function discordRest(method,path,body=null){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const u=new URL(`https://discord.com/api/v10${path}`);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method,headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}},res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});}});});
    req.on('error',reject);
    if(data)req.write(data);
    req.end();
  });
}

// ─── Data helpers ─────────────────────────────────────────────────────────────
const tickerCache=new Map();    // Polygon ticker details cache
const tickerCountry=new Map();  // country code per ticker
const cikCache=new Map();       // CIK → ticker cache

async function getTickerDetails(ticker){
  const c=tickerCache.get(ticker);
  if(c&&Date.now()-c.ts<4*60*60*1000)return c.data;
  try{
    const r=await polyGet(`/v3/reference/tickers/${ticker}`);
    const data=(r&&r.results)||{};
    tickerCache.set(ticker,{data,ts:Date.now()});
    if(data.locale)tickerCountry.set(ticker,data.locale.toUpperCase());
    return data;
  }catch(e){return{};}
}

async function getLatestNewsUrl(ticker){
  try{
    const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=1&order=desc&sort=published_utc`);
    const items=(r&&r.results)||[];
    if(items.length&&items[0].article_url)return items[0].article_url;
  }catch(e){}
  return null;
}

async function getRecentSplit(ticker){
  try{
    const r=await polyGet(`/v3/reference/splits?ticker=${ticker}&limit=5&order=desc`);
    const splits=(r&&r.results)||[];
    const s=splits.find(s=>{
      const d=(Date.now()-new Date(s.execution_date).getTime())/86400000;
      return d<=90&&s.split_from>s.split_to;
    });
    if(s){const d=new Date(s.execution_date);return`${s.split_to} for ${s.split_from} R/S ${d.toLocaleString('en-US',{month:'short'})}. ${d.getDate()}`;}
  }catch(e){}
  return null;
}

async function getFinvizStats(ticker){
  const r={si:'--',float:'--',io:'--'};
  try{
    const html=await rawGet(`https://finviz.com/quote.ashx?t=${ticker}`,{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept':'text/html','Accept-Language':'en-US,en;q=0.5'
    });
    if(html.length>1000){
      const fm=html.match(/Shs Float<\/b><\/td>\s*<td[^>]*>([^<]+)<\/td>/i)||html.match(/Shs Float[^<]*<\/td>[^<]*<td[^>]*>([^<]+)<\/td>/i);
      if(fm&&fm[1]&&fm[1]!=='-')r.float=fm[1].trim();
      const sm=html.match(/Short Float[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i)||html.match(/Short Float[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
      if(sm&&sm[1]&&sm[1]!=='-')r.si=sm[1].includes('%')?sm[1].trim():sm[1].trim()+'%';
      const im=html.match(/Inst Own[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i)||html.match(/Inst Own[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
      if(im&&im[1]&&im[1]!=='-')r.io=im[1].includes('%')?im[1].trim():im[1].trim()+'%';
    }
    if(r.float==='--'&&r.si==='--')console.log(`[Finviz] ${ticker}: len=${html.length} — no match`);
  }catch(e){console.error(`[Finviz] ${ticker}:`,e.message);}
  // Fallback for float: Polygon shares outstanding
  if(r.float==='--'){
    try{
      const det=await getTickerDetails(ticker);
      const sh=det.share_class_shares_outstanding||det.weighted_shares_outstanding||0;
      if(sh>0)r.float=fmtN(sh)+' (out)';
    }catch(e){}
  }
  return r;
}

async function getTickerFromCIK(cik){
  if(!cik)return'';
  if(cikCache.has(cik))return cikCache.get(cik);
  try{
    const r=await jsonGet(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10,'0')}.json`);
    const t=(r&&r.tickers&&r.tickers[0])||'';
    if(t)cikCache.set(cik,t);
    return t;
  }catch(e){return'';}
}

// ─── ETF filter ───────────────────────────────────────────────────────────────
let etfSet=new Set();
let lastEtfRefresh=0;
async function refreshEtfList(){
  if(Date.now()-lastEtfRefresh<6*60*60*1000)return;
  try{
    let path='/v3/reference/tickers?type=ETF&market=stocks&active=true&limit=1000';
    const s=new Set();let pages=0;
    while(path&&pages<5){
      const r=await polyGet(path);if(!r||!r.results)break;
      r.results.forEach(t=>s.add(t.ticker));
      path=r.next_url?r.next_url.replace('https://api.polygon.io',''):null;pages++;
    }
    if(s.size>0){etfSet=s;lastEtfRefresh=Date.now();console.log(`[ETF] ${s.size} tickers`);}
  }catch(e){}
}
function isEtf(t){
  if(etfSet.has(t))return true;
  return/^(SPY|QQQ|IWM|DIA|GLD|SLV|TLT|HYG|VXX|UVXY|SQQQ|TQQQ|SPXU|SPXL|SOXL|SOXS|TECL|TECS|LABD|LABU|NUGT|DUST|FAS|FAZ|TNA|TZA|UPRO|SDOW|UDOW|GUSH|DRIP|ERX|ERY|BOIL|KOLD|ARKK|ARKG|ARKW|ARKF|GDX|GDXJ|XLF|XLE|XLK|XLV|XLI|XLP|XLU|VTI|VOO|IVV|IJR|IJH)$/.test(t);
}
function isBadTicker(t){
  if(isEtf(t))return true;
  if(isOTC(t))return true;
  // Exchange check done at snapshot level
  return false;
}

// ─── State ────────────────────────────────────────────────────────────────────
const state={
  // Per-ticker tracking
  tickers:new Map(),       // {high, nhod, lastAlertPrice, lastAlertTime, priceHistory}
  dailyAlertCount:new Map(), // ticker -> count of alerts fired today
  // Dedup sets
  sentHalts:new Set(),sentResumes:new Set(),sentFilings:new Set(),
  sentPRSpike:new Set(),sentPRDrop:new Set(),sentNews:new Set(),
  // Session tracking
  morningPosted:new Set(),recentNewsCache:new Map(),
  alertedToday:new Set(),  // tickers alerted in current calendar day
};
let topGappers=[];
let lastHaltCheck=0;
let lastFilingCheck=0;
let lastNewsPoll=0;

// ─── Gapper refresh ───────────────────────────────────────────────────────────
async function refreshTopGappers(){
  try{
    const[pg,pc]=await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=changePercent&direction=desc&limit=100'),
    ]);
    const{etMin}=getETInfo();
    const build=t=>{
      const lp=(t.lastTrade&&t.lastTrade.p)||(t.day&&t.day.c)||0;
      const prev=(t.prevDay&&t.prevDay.c)||0;
      const chg=lp>0&&prev>0?((lp-prev)/prev)*100:(t.todaysChangePerc||0);
      const vol=(t.day&&t.day.v)||0;
      const pv2=(t.prevDay&&t.prevDay.v)||0;
      // Correct RVol: time-normalize today's volume vs yesterday's full day
      // Formula: (todayVol / minutesActive) / (prevDayVol / 390 trading minutes)
      // = todayVol * 390 / (minutesActive * prevDayVol)
      const minutesActive=Math.max(etMin-240,1);
      const tradingMins=390; // standard trading day minutes
      const rvol=pv2>0?(vol*tradingMins)/(minutesActive*pv2):vol>100000?5:0; // no prevDay data → assume 5x if enough volume
      const exchange=t.primaryExchange||'';
      // Only flag as OTC if exchange explicitly says OTC — empty exchange is OK
      // Many legit small caps don't have primaryExchange in the snapshot
      const isOTCEx=/OTC|GREY|PINK|EXPERT/i.test(exchange);
      return{ticker:t.ticker,price:lp,prev,chgPct:chg,volume:vol,prevVol:pv2,rvol,
             high:(t.day&&t.day.h)||lp,exchange,isOTCEx};
    };
    const merge=new Map();
    for(const src of[pg,pc])for(const t of((src&&src.tickers)||[]))
      if(!merge.has(t.ticker))merge.set(t.ticker,build(t));
    topGappers=[...merge.values()].filter(t=>
      t.chgPct>=5&&t.price>=0.1&&t.price<=5&&
      t.volume>=100000&&!t.isOTCEx&&!isBadTicker(t.ticker)
    ).sort((a,b)=>b.chgPct-a.chgPct).slice(0,30);
    // Sync state.tickers
    for(const g of topGappers){
      const ex=state.tickers.get(g.ticker)||{high:0,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]};
      state.tickers.set(g.ticker,{...ex,...g,high:Math.max(g.high,ex.high)});
    }
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} gappers`);
  }catch(e){console.error('refreshTopGappers:',e.message);}
}

// ─── NHOD Alert — NuntioBot style ─────────────────────────────────────────────
// Fires when a stock makes a new high AND has real unusual volume
// Cooldown: 15 min per ticker, must move 10% above last alert price
async function fireNHOD(ticker,price){
  if(!isActive())return;
  const etInfo=getETInfo();
  const gapper=topGappers.find(g=>g.ticker===ticker);
  if(!gapper)return;

  const s=state.tickers.get(ticker);
  if(!s||price<=s.high+0.001)return;

  // Debug log every NHOD candidate so we can see why things get blocked
  console.log(`[NHOD?] ${ticker} $${price.toFixed(4)} chg:${gapper.chgPct.toFixed(1)}% vol:${fmtN(gapper.volume)} rvol:${fmtRVol(gapper.rvol)} lastAlert:${s.lastAlertPrice?'$'+s.lastAlertPrice.toFixed(4):'none'} cooldown:${s.lastAlertTime?Math.round((Date.now()-s.lastAlertTime)/60000)+'m ago':'none'}`);

  // ── NuntioBot-style quality gates ────────────────────────────────────────
  // Based on observed NuntioBot behavior: only fires on low-price,
  // low-float, high-RVol stocks. Universe is <$5, tiny float, huge RVol.
  const{etMin}=getETInfo();

  // 1. Universe filter: price must be under $5 (NuntioBot never fires on $10+ stocks)
  if(price>5)return;

  // 2. RVol must be genuinely unusual — NuntioBot minimum appears to be ~10x
  if(gapper.rvol<10)return;

  // 3. Session-based volume floor
  if(etMin>=240&&etMin<360){
    // Early pre-market 4AM–6AM: 10% gain, 100K vol
    if(gapper.chgPct<10)return;
    if(gapper.volume<100000)return;
  }else if(etMin>=360&&etMin<960){
    // Main session 6AM–4PM: 20% gain, 1M vol
    if(gapper.chgPct<20)return;
    if(gapper.volume<1000000)return;
  }else{
    // After-hours 4PM–8PM: 10% gain, 100K vol
    if(gapper.chgPct<10)return;
    if(gapper.volume<100000)return;
  }

  // 4. Must move 8% above last alerted price — no micro-tick spam
  if(s.lastAlertPrice>0&&price<s.lastAlertPrice*1.20)return; // must be 20% above last alert price

  // 5. 10-min cooldown per ticker
  if(s.lastAlertTime>0&&Date.now()-s.lastAlertTime<30*60*1000)return; // 30-min cooldown
  // Hard cap: max 3 NHOD alerts per ticker per day
  const dayCount=(state.dailyAlertCount.get(ticker)||0);
  if(dayCount>=3)return;
  // ─────────────────────────────────────────────────────────────────────────

  const nhod=(s.nhod||0)+1;
  state.tickers.set(ticker,{...s,high:price,nhod,lastAlertPrice:price,lastAlertTime:Date.now()});
  state.dailyAlertCount.set(ticker,(state.dailyAlertCount.get(ticker)||0)+1);
  state.alertedToday.add(ticker);

  console.log(`[${etInfo.timeStr}] NHOD ${ticker} $${price.toFixed(4)} x${nhod} RVol:${fmtRVol(gapper.rvol)}`);

  const[newsUrl,rs,details,fv]=await Promise.all([
    getLatestNewsUrl(ticker),
    getRecentSplit(ticker),
    getTickerDetails(ticker),
    getFinvizStats(ticker)
  ]);

  const mc=details.market_cap||0;
  const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
  const siStr=fv.si!=='--'?` | SI: ${fv.si}`:'';
  const floatStr=fv.float!=='--'?` | Float: ${fv.float}`:'';
  const rsStr=rs?` | ${rs}`:'';

  // After-lull detection
  let afterLull='';
  const hist=s.priceHistory||[];
  if(hist.length>=10){
    const old=hist.filter(h=>h.time<Date.now()-10*60*1000);
    if(old.length>=3){
      const oH=Math.max(...old.map(h=>h.price)),oL=Math.min(...old.map(h=>h.price));
      if((oH-oL)/oL<0.02&&price>oH*1.03)afterLull=' · `after-lull`';
    }
  }

  // Inline PR link
  const cached=state.recentNewsCache.get(ticker);
  const prStr=cached&&(Date.now()-cached.ts)<60*60*1000?` | [PR+](<${cached.url}>)`:'';

  const sessLabel=etInfo.sess;
  const label=nhod===1?(sessLabel==='PRE-MARKET'?'PMH':sessLabel==='AFTER-HOURS'?'AHs':'NSH'):`${nhod} NHOD`;
  const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
  const flag=countryFlag(ticker);
  const line=`\`${etInfo.timeStr}\` ↑ ${tLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${label}${afterLull} ~ ${flag}${mcStr} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${floatStr}${siStr}${rsStr}${prStr}`;
  await post(WH.MAIN_CHAT,{content:line});
}

// ─── Halts ────────────────────────────────────────────────────────────────────
async function checkHalts(){
  if(!isActive())return;
  if(Date.now()-lastHaltCheck<60*1000)return;
  lastHaltCheck=Date.now();
  const etInfo=getETInfo();
  const reasonMap={'T1':'News Pending','T2':'News Released','T3':'News/Resume','T5':'Single Stock Circuit Breaker','T6':'Extraordinary Market Activity','LUDP':'Volatility Pause','LUDS':'Volatility Pause','MWC1':'Market Wide Circuit Breaker','H4':'Non-Compliance','H9':'Not Current','H10':'SEC Suspension','H11':'Regulatory Concern','IPO1':'IPO Not Yet Trading'};
  try{
    const xml=await rawGet('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts');
    const items=xml.match(/<item>[\s\S]*?<\/item>/g)||[];
    for(const item of items){
      const ticker=((item.match(/<IssueSymbol>(.*?)<\/IssueSymbol>/)||[])[1]||'').trim();
      const reason=((item.match(/<ReasonCode>(.*?)<\/ReasonCode>/)||[])[1]||'').trim();
      const haltTime=((item.match(/<HaltTime>(.*?)<\/HaltTime>/)||[])[1]||'').trim();
      const haltDate=((item.match(/<HaltDate>(.*?)<\/HaltDate>/)||[])[1]||'').trim();
      const resumeTime=((item.match(/<ResumptionTime>(.*?)<\/ResumptionTime>/)||[])[1]||'').trim();
      if(!ticker)continue;
      const id=`halt_${ticker}_${haltDate}_${haltTime}`;
      if(state.sentHalts.has(id))continue;
      state.sentHalts.add(id);
      const reasonText=reasonMap[reason]||reason||'Trading Halt';
      const gapper=topGappers.find(g=>g.ticker===ticker);
      const priceStr=gapper?` → $${gapper.price.toFixed(4)}`:'';
      const volStr=gapper?` ~ ${fmtN(gapper.volume)} vol`:'';
      const newsUrl=await getLatestNewsUrl(ticker);
      const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
      const isResumed=resumeTime&&resumeTime.length>0;
      if(isResumed){
        const rid=`resume_${id}`;if(state.sentResumes.has(rid))continue;
        state.sentResumes.add(rid);
        const line=`\`${resumeTime||etInfo.timeStr}\` ▶️ **RESUMED** ${tLink} | ${reasonText}${priceStr}${volStr}`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);await post(WH.HALT_ALERTS,{content:line});
      }else{
        const line=`\`${haltTime||etInfo.timeStr}\` ⏸️ **HALTED** ${tLink} | ${reasonText}${priceStr}${volStr}`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);await post(WH.HALT_ALERTS,{content:line});
        console.log(`[${etInfo.timeStr}] HALT: ${ticker} ${reasonText}`);
      }
      await sleep(400);
    }
  }catch(e){console.error('checkHalts:',e.message);}
}

// ─── SEC / EDGAR filings ──────────────────────────────────────────────────────
const EDGAR_FORMS=['8-K','8-K/A','S-1','S-3','424B3','424B4','424B5'];
let lastEdgarCheck=0;
async function checkSECFilings(){
  if(!isActive())return;
  if(Date.now()-lastEdgarCheck<2*60*1000)return;
  lastEdgarCheck=Date.now();
  const etInfo=getETInfo();
  const cutoff=Date.now()-15*60*1000;
  // Polygon filings for current gappers
  for(const g of topGappers.slice(0,15)){
    if(g.price>20)continue;
    try{
      const r=await polyGet(`/vX/reference/filings?ticker=${g.ticker}&limit=5&order=desc&sort=filed_at`);
      for(const f of((r&&r.results)||[])){
        const filed=new Date(f.filed_at||0).getTime();
        const id=(f.filing_url||f.accession_number||'').slice(0,80);
        if(filed<=cutoff||state.sentFilings.has(id))continue;
        state.sentFilings.add(id);
        const ft=(f.form_type||'SEC').toUpperCase();
        const isDil=/S-3|S-1|424B/.test(ft);
        const line=`\`${etInfo.timeStr}\` **SEC** **${g.ticker}**${isDil?' ⚠️':''} — Form ${ft}${f.filing_url?` — [Link](<${f.filing_url}>)`:''}`;
        await post(WH.SEC_FILINGS,{content:line});await sleep(300);
        await post(WH.MAIN_CHAT,{content:`${line} | $${g.price.toFixed(4)} \`+${g.chgPct.toFixed(1)}%\``});
        await sleep(300);
      }
    }catch(e){}
  }
  // EDGAR RSS for 8-K on any stock we know
  if(Date.now()-lastFilingCheck<5*60*1000)return;
  lastFilingCheck=Date.now();
  const knownTickers=new Set([...topGappers.map(g=>g.ticker),...state.alertedToday]);
  try{
    for(const form of EDGAR_FORMS){
      const xml=await rawGet(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(form)}&dateb=&owner=include&count=20&output=atom`,{'User-Agent':'AziziBot contact@azizibot.com'});
      const entries=xml.match(/<entry>[\s\S]*?<\/entry>/g)||[];
      for(const entry of entries){
        const title=((entry.match(/<title>(.*?)<\/title>/)||[])[1]||'').trim();
        const link=((entry.match(/<link[^>]*href="([^"]+)"/)||[])[1]||'').trim();
        const updated=((entry.match(/<updated>(.*?)<\/updated>/)||[])[1]||'').trim();
        const id=(link||title).slice(0,100);
        if(!title||state.sentFilings.has(id))continue;
        if(updated&&(Date.now()-new Date(updated).getTime())>15*60*1000)continue;
        const cikMatch=link.match(/\/data\/(\d+)\//);
        const ticker=cikMatch?await getTickerFromCIK(cikMatch[1]):'';
        if(!ticker)continue;
        if(!knownTickers.has(ticker))continue; // only known movers
        const snap=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
        const td=snap&&snap.ticker;
        const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
        if(price>20)continue;
        state.sentFilings.add(id);
        const ft=form.toUpperCase();
        const isDil=/S-3|S-1|424B/.test(ft);
        const gapper=topGappers.find(g=>g.ticker===ticker);
        const pStr=price>0?` | $${price.toFixed(4)}`+(gapper?` \`+${gapper.chgPct.toFixed(1)}%\``:''):'';
        const line=`\`${etInfo.timeStr}\` **SEC/EDGAR** **${ticker}**${isDil?' ⚠️':''} — Form ${ft}${link?` — [Link](<${link}>)`:''}${pStr}`;
        await post(WH.SEC_FILINGS,{content:line});await sleep(300);
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);
        console.log(`[${etInfo.timeStr}] EDGAR: ${ticker} ${ft}`);
      }
      await sleep(500);
    }
  }catch(e){console.error('EDGAR:',e.message);}
}

// ─── News polling — PR Spike + PR Drop ───────────────────────────────────────
const DROP_RE=/offering|public offering|convertible|shelf registration|ATM offering|at-the-market|direct offering|registered direct|dilut|warrant|prospectus|424B|S-1|S-3|secondary offering|note offering|senior notes|debenture|equity financ/i;
const SPIKE_RE=/collaboration|agreement|partnership|FDA|approval|cleared|grant|award|contract|trial|data|results|positive|breakthrough|milestone|license|acqui|merger|acquisition|joint venture|phase|cohort|study|efficacy|safety/i;

async function pollNews(){
  if(!isActive())return;
  if(BZ_KEY)return; // skip polling when Benzinga WS is active
  if(Date.now()-lastNewsPoll<5*1000)return;
  lastNewsPoll=Date.now();
  try{
    const r=await polyGet('/v2/reference/news?limit=50&order=desc&sort=published_utc');
    const items=(r&&r.results)||[];
    const cutoff=Date.now()-3*60*1000;
    for(const n of items){
      if(!n.published_utc||new Date(n.published_utc).getTime()<cutoff)continue;
      const title=n.title||'';
      const tickers=(n.tickers||[]).filter(Boolean).map(t=>t.toUpperCase());
      if(!tickers.length)continue;
      const url=n.article_url||'';
      const published_utc=n.published_utc||'';
      const id=(url||title).slice(0,100);
      if(state.sentNews.has(id))continue;
      state.sentNews.add(id);
      for(const t of tickers){if(url)state.recentNewsCache.set(t,{url,ts:Date.now()});}
      const isDrop=DROP_RE.test(title);
      const isSpike=!isDrop&&SPIKE_RE.test(title);
      if(!isDrop&&!isSpike)continue;
      const etInfo=getETInfo();
      for(const ticker of tickers.slice(0,3)){
        if(isBadTicker(ticker))continue;
        // Volume gate — only alert on stocks with real activity
        const snapVol=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
        const tdVol=snapVol&&snapVol.ticker;
        const volCheck=(tdVol&&tdVol.day&&tdVol.day.v)||0;
        const prevVolCheck=(tdVol&&tdVol.prevDay&&tdVol.prevDay.v)||0;
        const priceCheck=(tdVol&&tdVol.lastTrade&&tdVol.lastTrade.p)||(tdVol&&tdVol.day&&tdVol.day.c)||0;
        if(volCheck<100000)continue;        // hard rule: min 100K volume, no exceptions
        if(priceCheck>20||priceCheck<0.10)continue; // price $0.10–$20
        const dedupId=isDrop?`prdrop_${id}_${ticker}`:`prspike_${id}_${ticker}`;
        const dedupSet=isDrop?state.sentPRDrop:state.sentPRSpike;
        if(dedupSet.has(dedupId))continue;
        dedupSet.add(dedupId);

        const[snap,det,fv]=await Promise.all([
          polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
          getTickerDetails(ticker),
          getFinvizStats(ticker)
        ]);
        const td=snap&&snap.ticker;
        const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
        const prev=(td&&td.prevDay&&td.prevDay.c)||0;
        const chgPct=price&&prev?((price-prev)/prev)*100:0;
        const mc=det.market_cap||0;
        const io=det.weighted_shares_outstanding||0; // IO from Polygon details

        // NuntioBot format:
        // 06:30 ↑ EVTV <$3 ~ 🇺🇸 | IO: 4.61% | MC: 23.9M | SI: 22.5%
        // • 2 minutes ago [PR] Title — Link
        const pStr=price>0?` \`${priceFlag(price)}\``:'';
        const arrow=chgPct>=0?'↑':'↓';
        const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
        const ioStr=fv.io!=='--'?` | IO: ${fv.io}`:'  ';
        const siStr=fv.si!=='--'?` | SI: ${fv.si}`:'';
        const ageMs=Date.now()-new Date(published_utc||Date.now()).getTime();
        const ageStr=ageMs<60000?`${Math.round(ageMs/1000)}s ago`:ageMs<3600000?`${Math.round(ageMs/60000)} min ago`:`${Math.round(ageMs/3600000)}h ago`;
        const prTag=isDrop?'PR ↓':'PR';
        const linkStr=url?` — [Link](<${url}>)`:'';
        const line1=`\`${etInfo.timeStr}\` ${arrow} **${ticker}**${pStr} ~ ${countryFlag(ticker)}${mcStr}${ioStr}${siStr}`;
        const line2=`• ${ageStr} [${prTag}] ${title.slice(0,200)}${linkStr}`;
        const full=`${line1}\n${line2}`;
        await post(WH.PRESS_RELEASES,{content:full});await sleep(300);
        await post(WH.MAIN_CHAT,{content:full});await sleep(300);
        console.log(`[${etInfo.timeStr}] ${isDrop?'PR-DROP':'PR-SPIKE'}: ${ticker}`);
      }
    }
    if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(x=>state.sentNews.add(x));}
    if(state.sentPRDrop.size>500){const a=[...state.sentPRDrop];state.sentPRDrop.clear();a.slice(-200).forEach(x=>state.sentPRDrop.add(x));}
    if(state.sentPRSpike.size>500){const a=[...state.sentPRSpike];state.sentPRSpike.clear();a.slice(-200).forEach(x=>state.sentPRSpike.add(x));}
  }catch(e){console.error('pollNews:',e.message);}
}

// ─── Morning Snapshot ─────────────────────────────────────────────────────────
async function checkMorningSnapshot(){
  const etInfo=getETInfo();
  if((etInfo.h!==6&&etInfo.h!==7)||etInfo.m!==0)return;
  const key=`${new Date().toISOString().slice(0,10)}_${etInfo.h}`;
  if(state.morningPosted.has(key))return;
  state.morningPosted.add(key);
  if(!topGappers.length)return;
  const rows=topGappers.map(g=>{
    const dot=g.chgPct>=200?'🔴':g.chgPct>=100?'🟠':g.chgPct>=50?'🟡':'🟢';
    return`${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(4)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}`;
  }).join('\n');
  await post(WH.TOP_GAPPERS,{embeds:[{title:`${etInfo.h===6?'🌅 6AM':'☀️ 7AM'} Pre-Market Hot Gappers`,description:rows||'No data',color:0x00d4ff,footer:{text:`AziziBot · ${etInfo.timeStr} ET · Polygon.io`},timestamp:new Date().toISOString()}]});
  console.log(`[${etInfo.timeStr}] Morning snapshot posted`);
}


// ─── Benzinga News WebSocket — real-time news, sub-second delivery ────────────
let wsBZ=null;
function connectBenzingaNewsWS(){
  if(wsBZ){try{wsBZ.terminate();}catch(e){}}
  console.log('[BZ News] Connecting...');
  wsBZ=new WebSocket(`wss://api.benzinga.com/api/v1/news/stream?token=${BZ_KEY}`);
  wsBZ.on('open',()=>{
    console.log('[BZ News] Connected — streaming live news');
    // Send ping every 30s to keep alive
    wsBZ._bzPing=setInterval(()=>{
      if(wsBZ.readyState===WebSocket.OPEN)wsBZ.send(JSON.stringify({action:'ping'}));
    },30000);
  });
  wsBZ.on('message',data=>{
    try{
      const msg=JSON.parse(data.toString());
      // Benzinga message format: {id, api_version, kind, data:{action, content:{title, url, stocks:[{name}]}}}
      if(msg.kind==='news'&&msg.data&&msg.data.content){
        const n=msg.data.content;
        const title=n.title||n.headline||'';
        const url=n.url||n.article_url||'';
        const tickers=(n.stocks||[]).map(s=>s.name||s.ticker||'').filter(Boolean);
        if(title&&tickers.length){
          handleNewsEvent({title,tickers,article_url:url,published_utc:n.created||new Date().toISOString()}).catch(()=>{});
        }
      }
    }catch(e){}
  });
  wsBZ.on('error',err=>console.error('[BZ News] Error:',err.message));
  wsBZ.on('close',()=>{
    if(wsBZ._bzPing)clearInterval(wsBZ._bzPing);
    console.log('[BZ News] Closed, reconnecting in 5s...');
    setTimeout(connectBenzingaNewsWS,5000);
  });
}

// ─── Polygon LULD halt WebSocket ──────────────────────────────────────────────
let wsHalt=null;
function connectHaltWS(){
  if(wsHalt){try{wsHalt.terminate();}catch(e){}}
  wsHalt=new WebSocket('wss://socket.polygon.io/stocks');
  wsHalt.on('open',()=>wsHalt.send(JSON.stringify({action:'auth',params:POLY_KEY})));
  wsHalt.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'&&msg.status==='auth_success'){
          wsHalt.send(JSON.stringify({action:'subscribe',params:'LULD.*'}));
          console.log('[Halt WS] Subscribed to LULD.*');
        }
        if(msg.ev==='LULD'){
          const ticker=msg.T||'';const indicator=msg.i||'';
          if(!ticker)continue;
          const isResume=indicator==='U'||indicator==='A';
          const isHalt=indicator==='D';
          if(!isResume&&!isHalt)continue;
          const id=`luld_${ticker}_${msg.s||Date.now()}`;
          if(state.sentHalts.has(id))continue;
          state.sentHalts.add(id);
          const etInfo=getETInfo();
          const gapper=topGappers.find(g=>g.ticker===ticker);
          const pStr=gapper?` → $${gapper.price.toFixed(4)}`:'';
          const vStr=gapper?` ~ ${fmtN(gapper.volume)} vol`:'';
          getLatestNewsUrl(ticker).then(newsUrl=>{
            const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
            const line=isResume
              ?`\`${etInfo.timeStr}\` ▶️ **RESUMED** ${tLink}${pStr}${vStr}`
              :`\`${etInfo.timeStr}\` ⏸️ **HALTED** ${tLink} | Volatility Pause${pStr}${vStr}`;
            post(WH.MAIN_CHAT,{content:line}).then(()=>sleep(300)).then(()=>post(WH.HALT_ALERTS,{content:line}));
            console.log(`[${etInfo.timeStr}] ${isResume?'RESUME':'HALT'}: ${ticker}`);
          });
        }
      }
    }catch(e){}
  });
  wsHalt.on('error',err=>{if(!err.message.includes('404'))console.error('Halt WS:',err.message);});
  wsHalt.on('close',()=>setTimeout(connectHaltWS,10000));
}

// ─── Price WebSocket ──────────────────────────────────────────────────────────
let ws=null;
const subscribedTickers=new Set();

function connectPriceWS(){
  if(ws){try{ws.terminate();}catch(e){}}
  console.log('Connecting to Polygon price WebSocket...');
  ws=new WebSocket('wss://socket.polygon.io/stocks');
  ws.on('open',()=>ws.send(JSON.stringify({action:'auth',params:POLY_KEY})));
  ws.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'&&msg.status==='auth_success'){
          subscribedTickers.clear();
          const subs=topGappers.map(g=>`T.${g.ticker},A.${g.ticker}`).join(',');
          if(subs){ws.send(JSON.stringify({action:'subscribe',params:subs}));topGappers.forEach(g=>subscribedTickers.add(g.ticker));}
          console.log(`[Price WS] Subscribed to ${topGappers.length} tickers`);
        }
        if(msg.ev==='T'||msg.ev==='A'){
          const ticker=msg.sym;
          const price=msg.ev==='T'?msg.p:(msg.c||msg.h||0);
          if(!price)continue;
          const s=state.tickers.get(ticker);
          if(!s)continue;
          // Update price history
          if(!s.priceHistory)s.priceHistory=[];
          s.priceHistory.push({price,time:Date.now()});
          if(s.priceHistory.length>60)s.priceHistory.shift();
          // Fire NHOD if new high
          if(price>s.high+0.001)fireNHOD(ticker,price).catch(()=>{});
        }
      }
    }catch(e){}
  });
  ws.on('error',err=>console.error('Price WS:',err.message));
  ws.on('close',()=>{console.log('Price WS closed, reconnecting...');setTimeout(connectPriceWS,5000);});
}

function subscribeNewTickers(tickers){
  if(!ws||ws.readyState!==WebSocket.OPEN||!tickers.length)return;
  ws.send(JSON.stringify({action:'subscribe',params:tickers.map(t=>`T.${t},A.${t}`).join(',')}));
  tickers.forEach(t=>subscribedTickers.add(t));
  console.log(`[Price WS] +${tickers.length} new: ${tickers.join(', ')}`);
}

function resubscribeWS(){
  if(ws&&ws.readyState===WebSocket.OPEN&&topGappers.length){
    const subs=topGappers.map(g=>`T.${g.ticker},A.${g.ticker}`).join(',');
    ws.send(JSON.stringify({action:'subscribe',params:subs}));
    topGappers.forEach(g=>subscribedTickers.add(g.ticker));
  }
}

// ─── Discord slash commands ───────────────────────────────────────────────────
async function buildTickerEmbed(ticker){
  ticker=ticker.toUpperCase().trim();
  const[snap,det,fv,rs,newsR]=await Promise.all([
    polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
    getTickerDetails(ticker),
    getFinvizStats(ticker),
    getRecentSplit(ticker),
    polyGet(`/v2/reference/news?ticker=${ticker}&limit=20&order=desc&sort=published_utc`)
  ]);
  const td=snap&&snap.ticker;
  if(!td)return{content:`No data for **${ticker}**`};
  const price=(td.lastTrade&&td.lastTrade.p)||(td.day&&td.day.c)||0;
  const prev=(td.prevDay&&td.prevDay.c)||0;
  const chgPct=price&&prev?((price-prev)/prev)*100:0;
  const vol=(td.day&&td.day.v)||0;
  const pv2=(td.prevDay&&td.prevDay.v)||0;
  const{etMin}=getETInfo();
  const minutesActive=Math.max(etMin-240,1);
  const rvol=pv2>0?(vol*390)/(minutesActive*pv2):vol>100000?5:0;
  const mc=det.market_cap||0;
  const color=chgPct>=0?0x26a641:0xe03e3e;
  const cutoff=Date.now()-30*24*60*60*1000;
  const news=((newsR&&newsR.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,5);
  const newsStr=news.map(n=>{
    const age=Date.now()-new Date(n.published_utc).getTime();
    const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;
    return`• [${(n.title||'').slice(0,80)}](<${n.article_url||''}>) — *${a} ago*`;
  }).join('\n')||'No recent news (30d)';
  const fields=[
    {name:'Price',value:`$${price.toFixed(4)}  ${chgPct>=0?'▲':'▼'} \`${chgPct>=0?'+':''}${chgPct.toFixed(2)}%\``,inline:true},
    {name:'Volume',value:fmtN(vol),inline:true},
    {name:'RVol',value:fmtRVol(rvol),inline:true},
    {name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true},
    {name:'Float',value:fv.float,inline:true},
    {name:'SI%',value:fv.si,inline:true},
    {name:'Prev Close',value:`$${prev.toFixed(4)}`,inline:true},
    {name:'Day High',value:`$${((td.day&&td.day.h)||0).toFixed(4)}`,inline:true},
    {name:'Day Low',value:`$${((td.day&&td.day.l)||0).toFixed(4)}`,inline:true},
  ];
  if(rs)fields.push({name:'Recent Split',value:rs,inline:false});
  fields.push({name:'Latest News (30d)',value:newsStr,inline:false});
  return{embeds:[{title:`${ticker} — ${det.name||ticker}`,color,fields,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`},timestamp:new Date().toISOString()}]};
}

async function deferInteraction(id,token){await discordRest('POST',`/interactions/${id}/${token}/callback`,{type:5});}
async function editReply(token,data){await discordRest('PATCH',`/webhooks/${APP_ID}/${token}/messages/@original`,data);}

async function handleCommand(cmd,option,interaction){
  await deferInteraction(interaction.id,interaction.token);
  let reply={content:'Unknown command'};
  try{
    if(cmd==='quote'||cmd==='q')reply=await buildTickerEmbed(option);
    else if(cmd==='gappers'){
      if(!topGappers.length)reply={content:'No hot gappers right now.'};
      else{
        const rows=topGappers.map(g=>`**${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)}`).join('\n');
        reply={embeds:[{title:`🔥 Hot Gappers (${topGappers.length})`,description:rows,color:0x00d4ff,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`}}]};
      }
    }
    else if(cmd==='news'){
      const ticker=option.toUpperCase();
      const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=20&order=desc&sort=published_utc`);
      const cutoff=Date.now()-30*24*60*60*1000;
      const items=((r&&r.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,8);
      if(!items.length)reply={content:`No recent news for **${ticker}** (last 30 days).`};
      else{
        const rows=items.map(n=>{const age=Date.now()-new Date(n.published_utc).getTime();const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;return`• [${(n.title||'').slice(0,90)}](<${n.article_url||''}>) — *${a} ago*`;}).join('\n');
        reply={embeds:[{title:`📰 ${ticker} — Latest News`,description:rows,color:0x5865f2,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`}}]};
      }
    }
    else if(cmd==='si'||cmd==='float'){
      const ticker=option.toUpperCase();
      const[fv,det]=await Promise.all([getFinvizStats(ticker),getTickerDetails(ticker)]);
      const mc=det.market_cap||0;
      reply={embeds:[{title:`📊 ${ticker} — Short Interest & Float`,color:0xf0a500,fields:[{name:'Short Interest %',value:fv.si,inline:true},{name:'Float',value:fv.float,inline:true},{name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true}],footer:{text:`AziziBot · Finviz · ${getETInfo().timeStr} ET`}}]};
    }
    else if(cmd==='halt'){
      const xml=await rawGet('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts');
      const items=xml.match(/<item>[\s\S]*?<\/item>/g)||[];
      const halts=[];
      for(const item of items.slice(0,10)){
        const ticker=((item.match(/<IssueSymbol>(.*?)<\/IssueSymbol>/)||[])[1]||'').trim();
        const reason=((item.match(/<ReasonCode>(.*?)<\/ReasonCode>/)||[])[1]||'').trim();
        const haltTime=((item.match(/<HaltTime>(.*?)<\/HaltTime>/)||[])[1]||'').trim();
        const resumeTime=((item.match(/<ResumptionTime>(.*?)<\/ResumptionTime>/)||[])[1]||'').trim();
        if(!ticker)continue;
        halts.push(`**${ticker}** — ${resumeTime?`▶️ Resumed ${resumeTime}`:`⏸️ Halted ${haltTime}`} | ${reason}`);
      }
      reply=halts.length?{embeds:[{title:'⏸️ Recent Halts',description:halts.join('\n'),color:0xe03e3e,footer:{text:`AziziBot · NASDAQ · ${getETInfo().timeStr} ET`}}]}:{content:'No active halts.'};
    }
    else if(cmd==='filings'){
      const ticker=option.toUpperCase();
      const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=8&order=desc&sort=filed_at`);
      const filings=(r&&r.results)||[];
      if(!filings.length)reply={content:`No filings found for **${ticker}**`};
      else{
        const rows=filings.map(f=>{const ft=(f.form_type||'').toUpperCase();const d=f.filed_at?new Date(f.filed_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';return`${/S-3|S-1|424B|8-K/.test(ft)?'⚠️':'📋'} **${ft}** ${d}${f.filing_url?` · [Link](<${f.filing_url}>)`:''}`}).join('\n');
        reply={embeds:[{title:`📋 ${ticker} — SEC Filings`,description:rows,color:0x7289da,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`}}]};
      }
    }
  }catch(e){reply={content:`Error: ${e.message}`};}
  await editReply(interaction.token,reply);
}

// ─── Discord Gateway ──────────────────────────────────────────────────────────
let wsDiscord=null;
let discordHBInterval=null;
let discordSeq=null;

function connectDiscordGateway(){
  if(wsDiscord){try{wsDiscord.terminate();}catch(e){}}
  wsDiscord=new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
  wsDiscord.on('open',()=>console.log('[Discord] Gateway connected'));
  wsDiscord.on('message',async data=>{
    try{
      const msg=JSON.parse(data.toString());
      if(msg.s)discordSeq=msg.s;
      if(msg.op===10){
        if(discordHBInterval)clearInterval(discordHBInterval);
        discordHBInterval=setInterval(()=>wsDiscord.send(JSON.stringify({op:1,d:discordSeq})),msg.d.heartbeat_interval);
        wsDiscord.send(JSON.stringify({op:2,d:{token:DISCORD_TOKEN,intents:(1<<9)|(1<<15),properties:{os:'linux',browser:'azizibot',device:'azizibot'}}}));
      }
      if(msg.op===0){
        if(msg.t==='READY')console.log(`[Discord] Ready as ${msg.d.user.username}`);
        if(msg.t==='INTERACTION_CREATE'&&msg.d.type===2){
          const cmd=msg.d.data.name;
          const option=(msg.d.data.options&&msg.d.data.options[0]&&msg.d.data.options[0].value)||'';
          handleCommand(cmd,option,msg.d).catch(e=>console.error('[Discord] cmd error:',e.message));
        }
        if(msg.t==='MESSAGE_CREATE'&&!msg.d.author.bot){
          const content=(msg.d.content||'').trim();
          const m=content.match(/^\$?([A-Z]{1,5})$/);
          if(m){
            buildTickerEmbed(m[1]).then(embed=>{
              if(embed)discordRest('POST',`/channels/${msg.d.channel_id}/messages`,embed);
            }).catch(()=>{});
          }
        }
      }
      if(msg.op===7||msg.op===9){setTimeout(connectDiscordGateway,msg.op===9?5000:1000);}
    }catch(e){console.error('[Discord] msg error:',e.message);}
  });
  wsDiscord.on('error',err=>console.error('[Discord] error:',err.message));
  wsDiscord.on('close',code=>{
    if(discordHBInterval)clearInterval(discordHBInterval);
    console.log(`[Discord] closed (${code}), reconnecting...`);
    setTimeout(connectDiscordGateway,5000);
  });
}

async function registerSlashCommands(){
  const cmds=[
    {name:'quote',description:'Full quote: price, volume, RVol, MC, float, SI, news',options:[{type:3,name:'ticker',description:'Ticker symbol',required:true}]},
    {name:'gappers',description:'Current hot gappers list'},
    {name:'news',description:'Latest news headlines (last 30 days)',options:[{type:3,name:'ticker',description:'Ticker symbol',required:true}]},
    {name:'si',description:'Short interest % and float',options:[{type:3,name:'ticker',description:'Ticker symbol',required:true}]},
    {name:'float',description:'Float and short interest',options:[{type:3,name:'ticker',description:'Ticker symbol',required:true}]},
    {name:'halt',description:'Recent trading halts and resumes'},
    {name:'filings',description:'Latest SEC filings',options:[{type:3,name:'ticker',description:'Ticker symbol',required:true}]},
  ];
  try{
    const r=await discordRest('PUT',`/applications/${APP_ID}/commands`,cmds);
    console.log(`[Discord] Registered ${Array.isArray(r)?r.length:0} slash commands`);
  }catch(e){console.error('[Discord] register error:',e.message);}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  if(!POLY_KEY){console.error('FATAL: POLY_KEY missing');process.exit(1);}
  if(!DISCORD_TOKEN){console.error('FATAL: DISCORD_TOKEN missing');process.exit(1);}
  console.log('🤖 AziziBot v6 starting...');
  await refreshEtfList();
  await refreshTopGappers();
  connectPriceWS();
  connectHaltWS();
  if(BZ_KEY)connectBenzingaNewsWS(); else console.warn("[BZ News] No BZ_KEY — using Polygon news poll fallback");
  connectDiscordGateway();
  await registerSlashCommands();

  // Fast loop: refresh gappers every 20s, subscribe new tickers
  setInterval(async()=>{
    const before=new Set(topGappers.map(g=>g.ticker));
    await refreshEtfList();
    await refreshTopGappers();
    const newTickers=topGappers.map(g=>g.ticker).filter(t=>!subscribedTickers.has(t));
    if(newTickers.length)subscribeNewTickers(newTickers);
    await pollNews();
  },20*1000);

  // Slow loop: halts, filings, morning snapshot every 60s
  setInterval(async()=>{
    // Reset daily counters at midnight ET
    const{h,m}=getETInfo();
    if(h===0&&m<1){state.alertedToday.clear();state.dailyAlertCount.clear();}
    await checkMorningSnapshot();
    await checkHalts();
    await checkSECFilings();
  },60*1000);

  console.log('🤖 AziziBot v6 running.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
