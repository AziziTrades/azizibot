'use strict';
const https    = require('https');
const WebSocket = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────
const POLY_KEY      = process.env.POLY_KEY      || '';
const BZ_KEY        = process.env.BZ_KEY        || '';
const DISCORD_TOKEN = process.env.DISCORD_TOKEN || '';
const APP_ID        = '1493671812247322624';

const TOP_GAPPERS_WH = 'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3';
const MAIN_CHAT_WH   = 'https://discord.com/api/webhooks/1493985046074491060/PVM3ow3kgoSTHV9JGcNppy_eAjcTf-l7Wdf91YOV1VPDtoMIbvrGWPoP4_-I_53ejziZ';

// ─── Session tiers ────────────────────────────────────────────────────────────
// EARLY-PRE  4:00–7:00 AM  ≥10% chg  prevDay.v ≥100K  (today vol is tiny at 7AM)
// LATE-PRE   7:00–9:30 AM  ≥30% chg  day.v     ≥1M
// MKT        9:30–4:00 PM  ≥20% chg  day.v     ≥10M
// AH         4:00–8:00 PM  ≥10% chg  prevDay.v ≥100K
//
// dayWatchlist: 4AM–4PM lock-in. Stays active all day for NHOD bounces,
// PRs, and filings. Watchlist tickers skip session gates entirely.

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getET() {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone:'America/New_York', hour:'numeric', minute:'numeric',
    second:'numeric', hour12:false
  }).formatToParts(new Date());
  const h  = parseInt(p.find(x=>x.type==='hour').value);
  const m  = parseInt(p.find(x=>x.type==='minute').value);
  const s  = parseInt(p.find(x=>x.type==='second').value);
  const hh = h === 24 ? 0 : h;
  const etMin   = hh*60 + m;
  const timeStr = `${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const sess    = etMin>=240&&etMin<570?'PRE':etMin>=570&&etMin<960?'MKT':etMin>=960&&etMin<1200?'AH':'CLOSED';
  return { hh, m, s, etMin, timeStr, sess };
}

function isActive() { const {etMin}=getET(); return etMin>=240&&etMin<1200; }
function sleep(ms)  { return new Promise(r=>setTimeout(r,ms)); }
function fmtN(n)    { if(!n||isNaN(n))return'--'; if(n>=1e9)return(n/1e9).toFixed(2)+'B'; if(n>=1e6)return(n/1e6).toFixed(2)+'M'; if(n>=1e3)return(n/1e3).toFixed(1)+'K'; return String(n); }
function fmtRVol(r) { if(!r||isNaN(r)||r===0)return'--'; if(r>=1000)return Math.round(r).toLocaleString()+'x'; if(r>=10)return r.toFixed(0)+'x'; return r.toFixed(1)+'x'; }
function priceFlag(p){ if(p<0.50)return'<$.50c'; if(p<1)return'<$1'; if(p<2)return'<$2'; if(p<5)return'<$5'; return'<$10'; }
function flag(ticker){
  const c=countryMap.get(ticker);
  if(c==='IL')return'🇮🇱'; if(c==='CN')return'🇨🇳'; if(c==='GB')return'🇬🇧'; if(c==='CA')return'🇨🇦';
  return'🇺🇸';
}
function isBadTicker(t) {
  if(!t||t.length<2)return true;
  if(t.includes('.'))return true;
  if(/^[A-Z]{5}$/.test(t)&&/[FQEX]$/.test(t))return true;
  if(/WS?$/.test(t)&&t.length>=5)return true;
  if(/^[A-Z]{4,5}R$/.test(t))return true;
  if(/^[A-Z]{4,5}U$/.test(t))return true;
  return false;
}

// ─── HTTP / API ───────────────────────────────────────────────────────────────
function rawGet(url, hdrs={}) {
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'AziziBot/1.0',...hdrs}},res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(8000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
async function jsonGet(url){try{return JSON.parse(await rawGet(url));}catch(e){return null;}}
function polyGet(path){
  const sep=path.includes('?')?'&':'?';
  return jsonGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`);
}
async function postToWebhook(url,payload){
  return new Promise(resolve=>{
    const body=JSON.stringify(payload);
    const u=new URL(url);
    const req=https.request({
      hostname:u.hostname,path:u.pathname+u.search,method:'POST',
      headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}
    },res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        if(res.statusCode!==204&&res.statusCode!==200)
          console.error(`[Webhook] HTTP ${res.statusCode}: ${d.slice(0,200)}`);
        resolve(res.statusCode);
      });
    });
    req.on('error',e=>{console.error('[Webhook] error:',e.message);resolve(0);});
    req.setTimeout(5000,()=>{req.destroy();resolve(0);});
    req.write(body); req.end();
  });
}
async function post(payload){
  payload.username='AziziBot';
  await postToWebhook(MAIN_CHAT_WH,payload);
}
function discordRest(method,path,body=null){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const req=https.request({
      hostname:'discord.com',path:`/api/v10${path}`,method,
      headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});}});});
    req.on('error',reject);
    if(data) req.write(data);
    req.end();
  });
}

// ─── ETF list ─────────────────────────────────────────────────────────────────
const ETF_FALLBACK=new Set(['SPY','QQQ','IWM','DIA','GLD','SLV','TLT','HYG','VXX','UVXY',
  'SQQQ','TQQQ','SPXU','SPXL','SOXL','SOXS','TECL','TECS','LABD','LABU','NUGT','DUST',
  'FAS','FAZ','TNA','TZA','UPRO','SDOW','UDOW','GUSH','DRIP','ERX','ERY','BOIL','KOLD',
  'ARKK','ARKG','ARKW','ARKF','GDX','GDXJ','XLF','XLE','XLK','XLV','XLI','XLP','XLU',
  'VTI','VOO','IVV','IJR','IJH']);
let etfSet=new Set(ETF_FALLBACK);
let lastEtfRefresh=0;
async function refreshEtfList(){
  if(Date.now()-lastEtfRefresh<6*60*60*1000) return;
  try{
    let path='/v3/reference/tickers?type=ETF&market=stocks&active=true&limit=1000';
    const s=new Set(ETF_FALLBACK);
    let pages=0;
    while(path&&pages<5){
      const r=await polyGet(path);
      if(!r||!r.results) break;
      r.results.forEach(t=>s.add(t.ticker));
      path=r.next_url?r.next_url.replace('https://api.polygon.io',''):null;
      pages++;
    }
    if(s.size>100){etfSet=s;lastEtfRefresh=Date.now();console.log(`[ETF] ${s.size} tickers loaded`);}
  }catch(e){console.error('[ETF] refresh failed:',e.message);}
}
function isEtf(t){return etfSet.has(t);}

// ─── Caches ───────────────────────────────────────────────────────────────────
const countryMap =new Map();
const tickerCache=new Map();
const newsCache  =new Map();

async function getTickerDetails(ticker){
  const c=tickerCache.get(ticker);
  if(c&&Date.now()-c.ts<4*60*60*1000) return c.data;
  try{
    const r=await polyGet(`/v3/reference/tickers/${ticker}`);
    const data=(r&&r.results)||{};
    tickerCache.set(ticker,{data,ts:Date.now()});
    if(data.locale) countryMap.set(ticker,data.locale.toUpperCase());
    return data;
  }catch(e){return {};}
}
async function getNewsUrl(ticker){
  const c=newsCache.get(ticker);
  if(c&&Date.now()-c.ts<15*60*1000) return c.url;
  try{
    const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=1&order=desc&sort=published_utc`);
    const item=r&&r.results&&r.results[0];
    if(!item) return null;
    if(new Date(item.published_utc||0).getTime()<new Date().setHours(0,0,0,0)) return null;
    const url=item.article_url||null;
    if(url) newsCache.set(ticker,{url,ts:Date.now()});
    return url;
  }catch(e){return null;}
}
async function getRecentSplit(ticker){
  try{
    const r=await polyGet(`/v3/reference/splits?ticker=${ticker}&limit=5&order=desc`);
    const s=(r&&r.results||[]).find(s=>{
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
      if(fm&&fm[1]&&fm[1]!=='-') r.float=fm[1].trim();
      const sm=html.match(/Short Float[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i)||html.match(/Short Float[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
      if(sm&&sm[1]&&sm[1]!=='-') r.si=sm[1].includes('%')?sm[1].trim():sm[1].trim()+'%';
      const im=html.match(/Inst Own[^<]*<\/b><\/td>\s*<td[^>]*>([\d.]+%?)<\/td>/i)||html.match(/Inst Own[^<]*<\/td>[^<]*<td[^>]*>([\d.]+%?)<\/td>/i);
      if(im&&im[1]&&im[1]!=='-') r.io=im[1].includes('%')?im[1].trim():im[1].trim()+'%';
    }
  }catch(e){}
  if(r.float==='--'){
    try{
      const det=await getTickerDetails(ticker);
      const sh=det.share_class_shares_outstanding||det.weighted_shares_outstanding||0;
      if(sh>0) r.float=fmtN(sh)+' (out)';
    }catch(e){}
  }
  return r;
}
async function getGreenBars(ticker){
  try{
    const today=new Date().toISOString().slice(0,10);
    const r=await polyGet(`/v2/aggs/ticker/${ticker}/range/1/minute/${today}/${today}?adjusted=true&sort=desc&limit=10`);
    const bars=(r&&r.results)||[];
    let count=0;
    for(const bar of bars){if(bar.c>bar.o)count++;else break;}
    return count;
  }catch(e){return 0;}
}

// ─── State ────────────────────────────────────────────────────────────────────
let topGappers=[];
const dayWatchlist=new Map(); // ticker → {ticker,chgPct,volume,rvol,price,high,lockedAt}
const state={
  tickers:     new Map(),
  dailyCounts: new Map(),
  sentNews:    new Set(),
  sentFilings: new Set(),
  sentPR:      new Set(),
  morningPosted:new Set(),
};
const wsDebounce=new Map();

// ─── Gapper refresh ───────────────────────────────────────────────────────────
async function refreshGappers(){
  try{
    const {etMin,timeStr}=getET();
    if(!isActive()) return;

    const [g1,g2,g3]=await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=changePercent&direction=desc&limit=250'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?sort=volume&direction=desc&limit=250'),
    ]);

    const c1=g1?.tickers?.length||0,c2=g2?.tickers?.length||0,c3=g3?.tickers?.length||0;
    console.log(`[Poly] gainers:${c1} pct:${c2} vol:${c3}`);
    if(c1===0&&c2===0&&c3===0){console.error('[Poly] ALL EMPTY — check POLY_KEY');return;}

    const build=t=>{
      const price =(t.lastTrade&&t.lastTrade.p)||(t.day&&t.day.c)||0;
      const prev  =(t.prevDay&&t.prevDay.c)||0;
      const chgPct=price&&prev?((price-prev)/prev)*100:(t.todaysChangePerc||0);
      const vol   =(t.day&&t.day.v)||0;       // today's accumulated volume
      const pv2   =(t.prevDay&&t.prevDay.v)||0; // yesterday's full-day volume
      const mins  =Math.max(etMin-240,1);
      const rvol  =pv2>0?(vol*390)/(mins*pv2):0;
      const exch  =t.primaryExchange||'';
      const isOTC =/OTC|GREY|PINK|EXPERT/i.test(exch);
      return {ticker:t.ticker,price,prev,chgPct,volume:vol,prevVol:pv2,rvol,
              high:(t.day&&t.day.h)||price,isOTC,exch};
    };

    const merge=new Map();
    for(const src of [g1,g2,g3])
      for(const t of ((src&&src.tickers)||[]))
        if(t.ticker&&!merge.has(t.ticker)) merge.set(t.ticker,build(t));

    // ── Session-aware filter ──────────────────────────────────────────────
    // EARLY-PRE / AH: use prevDay.v for vol check.
    //   At 7AM, day.v is near zero even for big movers. prevDay.v ≥ 100K
    //   confirms the stock is real and liquid.
    // LATE-PRE / MKT: use day.v (enough time has passed for volume to build).
    //
    let label,minChg,volCheck;
    if(etMin>=240&&etMin<420){
      // 4AM–7AM EARLY-PRE
      label='EARLY-PRE'; minChg=10;
      volCheck=t=>t.prevVol>=100_000;
    } else if(etMin>=420&&etMin<570){
      // 7AM–9:30AM LATE-PRE
      label='LATE-PRE'; minChg=30;
      volCheck=t=>t.volume>=1_000_000;
    } else if(etMin>=570&&etMin<960){
      // 9:30AM–4PM MKT
      label='MKT'; minChg=20;
      volCheck=t=>t.volume>=10_000_000;
    } else {
      // 4PM–8PM AH
      label='AH'; minChg=10;
      volCheck=t=>t.prevVol>=100_000;
    }

    const rejected={pct:0,price_low:0,price_high:0,vol:0,otc:0,etf:0,bad:0};
    const newGappers=[...merge.values()].filter(t=>{
      if(t.chgPct <minChg)       {rejected.pct++;       return false;}
      if(t.price  <0.10)         {rejected.price_low++; return false;}
      if(t.price  >10)           {rejected.price_high++;return false;}
      if(!volCheck(t))           {rejected.vol++;        return false;}
      if(t.isOTC)                {rejected.otc++;        return false;}
      if(isEtf(t.ticker))        {rejected.etf++;        return false;}
      if(isBadTicker(t.ticker))  {rejected.bad++;        return false;}
      return true;
    }).sort((a,b)=>b.chgPct-a.chgPct).slice(0,50);

    const volDesc=label==='EARLY-PRE'||label==='AH'?'prevVol≥100K':'dayVol≥'+(label==='LATE-PRE'?'1M':'10M');
    console.log(`[${label}] from ${merge.size}: passed=${newGappers.length} | chg<${minChg}%:${rejected.pct} p<0.10:${rejected.price_low} p>10:${rejected.price_high} ${volDesc}:${rejected.vol} OTC:${rejected.otc} ETF:${rejected.etf}`);
    if(newGappers.length>0)
      console.log(`[Gappers] ${newGappers.slice(0,5).map(g=>`${g.ticker}(${g.chgPct.toFixed(0)}%,dayV:${fmtN(g.volume)},prevV:${fmtN(g.prevVol)})`).join(' ')}`);
    // ─────────────────────────────────────────────────────────────────────

    topGappers=newGappers;

    // Lock into dayWatchlist during 4AM–4PM only
    const lockWindow=etMin>=240&&etMin<960;
    if(lockWindow){
      for(const g of topGappers){
        if(!dayWatchlist.has(g.ticker)){
          dayWatchlist.set(g.ticker,{ticker:g.ticker,chgPct:g.chgPct,volume:g.volume,
            rvol:g.rvol,price:g.price,high:g.high,lockedAt:label});
          console.log(`[Watch] +${g.ticker} +${g.chgPct.toFixed(1)}% dayV:${fmtN(g.volume)} prevV:${fmtN(g.prevVol)} [${label}]`);
        }
      }
    }

    // Sync state.tickers
    for(const g of topGappers){
      const ex=state.tickers.get(g.ticker)||{high:0,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]};
      state.tickers.set(g.ticker,{...ex,...g,high:Math.max(g.high,ex.high)});
    }
    for(const [ticker,g] of dayWatchlist){
      if(!state.tickers.has(ticker))
        state.tickers.set(ticker,{high:g.high,nhod:0,lastAlertPrice:0,lastAlertTime:0,priceHistory:[]});
    }

    console.log(`[${timeStr}] ${topGappers.length} live | ${dayWatchlist.size} watchlist | ${label}`);
  }catch(e){console.error('[refreshGappers] CRASH:',e.message,e.stack);}
}

// ─── NHOD Alert ───────────────────────────────────────────────────────────────
async function fireNHOD(ticker,price){
  if(!isActive()) return;

  const liveGapper =topGappers.find(g=>g.ticker===ticker);
  const watchGapper=dayWatchlist.get(ticker);
  const gapper     =liveGapper||watchGapper;
  const isWatchOnly=!liveGapper&&!!watchGapper;
  if(!gapper) return;

  const s=state.tickers.get(ticker);
  if(!s)                   {console.log(`[NHOD] ${ticker} skip: no state`);return;}
  if(price<=s.high+0.001)  {console.log(`[NHOD] ${ticker} skip: $${price.toFixed(4)} not above high $${s.high.toFixed(4)}`);return;}

  const {etMin,timeStr}=getET();

  if(price>10)   {console.log(`[NHOD] ${ticker} skip: price>$10`);return;}
  if(price<0.10) {console.log(`[NHOD] ${ticker} skip: price<$0.10`);return;}

  // Session gates — only for live tickers, not watchlist-only
  if(!isWatchOnly){
    if(etMin>=240&&etMin<420){
      // EARLY-PRE: gain gate; vol already checked via prevDay at admission
      if(gapper.chgPct<10){console.log(`[NHOD] ${ticker} skip: EARLY-PRE chg ${gapper.chgPct.toFixed(1)}%<10%`);return;}
    } else if(etMin>=420&&etMin<570){
      if(gapper.chgPct<30)       {console.log(`[NHOD] ${ticker} skip: LATE-PRE chg ${gapper.chgPct.toFixed(1)}%<30%`);return;}
      if(gapper.volume<1_000_000){console.log(`[NHOD] ${ticker} skip: LATE-PRE vol ${fmtN(gapper.volume)}<1M`);return;}
    } else if(etMin>=570&&etMin<960){
      if(gapper.chgPct<20)        {console.log(`[NHOD] ${ticker} skip: MKT chg ${gapper.chgPct.toFixed(1)}%<20%`);return;}
      if(gapper.volume<10_000_000){console.log(`[NHOD] ${ticker} skip: MKT vol ${fmtN(gapper.volume)}<10M`);return;}
    } else {
      // AH
      if(gapper.chgPct<10){console.log(`[NHOD] ${ticker} skip: AH chg ${gapper.chgPct.toFixed(1)}%<10%`);return;}
    }
  }

  if(s.lastAlertPrice>0&&price<s.lastAlertPrice*1.075){
    console.log(`[NHOD] ${ticker} skip: need 7.5% above last $${s.lastAlertPrice.toFixed(4)}`);return;
  }
  if(s.lastAlertTime>0&&Date.now()-s.lastAlertTime<5*60*1000){
    console.log(`[NHOD] ${ticker} skip: 5-min cooldown`);return;
  }
  if((state.dailyCounts.get(ticker)||0)>=3){
    console.log(`[NHOD] ${ticker} skip: max 3/day`);return;
  }

  const nhod=(s.nhod||0)+1;
  state.tickers.set(ticker,{...s,high:price,nhod,lastAlertPrice:price,lastAlertTime:Date.now(),priceHistory:s.priceHistory||[]});
  state.dailyCounts.set(ticker,(state.dailyCounts.get(ticker)||0)+1);
  console.log(`[ALERT] ↗ ${ticker} $${price.toFixed(4)} x${nhod}${isWatchOnly?' [watch]':''}`);

  const [newsUrl,rs,det,fv,greenBars]=await Promise.all([
    getNewsUrl(ticker),getRecentSplit(ticker),getTickerDetails(ticker),
    getFinvizStats(ticker),getGreenBars(ticker),
  ]);

  const mc      =det.market_cap||0;
  const rsStr   =rs?` | ${rs}`:'';
  const regSHO  =fv.si!=='--'&&parseFloat(fv.si)>50?' | 🔴 Reg SHO':'';
  const greenStr=greenBars>=2?` · **${greenBars} green bars 1m**`:'';

  const hist=(state.tickers.get(ticker)||{}).priceHistory||[];
  let afterLull='';
  if(hist.length>=10){
    const old=hist.filter(h=>h.time<Date.now()-10*60*1000);
    if(old.length>=3){
      const oH=Math.max(...old.map(h=>h.price)),oL=Math.min(...old.map(h=>h.price));
      if((oH-oL)/oL<0.02&&price>oH*1.03) afterLull=' · `after-lull`';
    }
  }

  const prData  =newsCache.get(ticker);
  const prStr   =prData&&(Date.now()-prData.ts)<15*60*1000?` | [PR+](<${prData.url}>)`:'';
  const {sess}  =getET();
  const sessLabel=nhod===1?(sess==='PRE'?'PMH':sess==='AH'?'AHs':'NSH'):`${nhod} NHOD`;
  const tLink   =newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
  const pctStr  =`+${gapper.chgPct.toFixed(1)}%`;
  const mcLine  =mc>0?` | MC: ${fmtN(mc)}`:'';
  const extraLine=[
    fv.float!=='--'?`Float: ${fv.float}`:'',
    fv.si!=='--'?`SI: ${fv.si}`:'',
    fv.io!=='--'?`IO: ${fv.io}`:'',
  ].filter(Boolean).join(' | ');
  const extraStr=extraLine?`\n> ${extraLine}`:'';
  const line=`\`${timeStr}\` ↗ ${tLink} \`${priceFlag(price)}\` **${pctStr}** · ${sessLabel}${afterLull}${greenStr} ~ ${flag(ticker)}${mcLine} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${regSHO}${rsStr}${prStr}${extraStr}`;
  await post({content:line});
  console.log(`[ALERT] posted OK`);
}

// ─── News / PR alerts ─────────────────────────────────────────────────────────
const DROP_RE =/offering|public offering|convertible|shelf|ATM offering|at-the-market|direct offering|registered direct|dilut|warrant|prospectus|424B|S-1|S-3|secondary offering|note offering|senior notes|debenture|equity financ/i;
const SPIKE_RE=/collaboration|agreement|partnership|FDA|approval|cleared|grant|award|contract|trial|data|results|positive|breakthrough|milestone|license|acqui|merger|acquisition|joint venture|phase|cohort|study|efficacy|safety/i;

async function handleNewsItem(title,tickers,url,published_utc){
  if(!title||!tickers.length) return;
  const id=(url||title).slice(0,100);
  if(state.sentNews.has(id)) return;
  state.sentNews.add(id);
  for(const t of tickers) if(url) newsCache.set(t,{url,ts:Date.now()});

  const isDrop =DROP_RE.test(title);
  const isSpike=!isDrop&&SPIKE_RE.test(title);
  if(!isDrop&&!isSpike) return;

  const {timeStr,etMin}=getET();

  // PR vol floor: same logic — EARLY-PRE/AH use 0 (can't check prevVol here easily),
  // LATE-PRE uses 1M, MKT uses 10M. Keep it simple.
  let prVolMin=0;
  if(etMin>=420&&etMin<570)      prVolMin=1_000_000;
  else if(etMin>=570&&etMin<960) prVolMin=10_000_000;

  for(const ticker of tickers.slice(0,3)){
    if(isBadTicker(ticker)||isEtf(ticker)) continue;
    const prId=`${isDrop?'drop':'spike'}_${id}_${ticker}`;
    if(state.sentPR.has(prId)) continue;
    state.sentPR.add(prId);

    const snap =await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
    const td   =snap&&snap.ticker;
    const vol  =(td&&td.day&&td.day.v)||0;
    const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
    if(!td||vol<prVolMin||price<0.10||price>10) continue;

    const [det,fv]=await Promise.all([getTickerDetails(ticker),getFinvizStats(ticker)]);
    const mc   =det.market_cap||0;
    const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
    const ioStr=fv.io!=='--'?` | IO: ${fv.io}`:'';
    const siStr=fv.si!=='--'?` | SI: ${fv.si}`:'';
    const ageMs=Date.now()-new Date(published_utc||Date.now()).getTime();
    const ageStr=ageMs<60000?`${Math.round(ageMs/1000)}s ago`:ageMs<3600000?`${Math.round(ageMs/60000)} min ago`:`${Math.round(ageMs/3600000)}h ago`;
    const prTag=isDrop?'PR ↓':'PR';
    const tLink=url?`[${ticker}](<${url}>)`:`**${ticker}**`;
    const line1=`\`${timeStr}\` ${isDrop?'↓':'↑'} ${tLink} \`${priceFlag(price)}\` ~ ${flag(ticker)}${mcStr}${ioStr}${siStr}`;
    const line2=`• ${ageStr} [${prTag}] ${title.slice(0,200)}${url?` — [Link](<${url}>)`:''}`;
    await post({content:`${line1}\n${line2}`});
    console.log(`[${timeStr}] ${isDrop?'PR-DROP':'PR-SPIKE'}: ${ticker}`);
  }

  if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(x=>state.sentNews.add(x));}
  if(state.sentPR.size>500){const a=[...state.sentPR];state.sentPR.clear();a.slice(-200).forEach(x=>state.sentPR.add(x));}
}

// ─── Benzinga WS (disabled) ───────────────────────────────────────────────────
let wsBZ=null;
function connectBZ(){
  if(wsBZ){try{wsBZ.terminate();}catch(e){}}
  wsBZ=new WebSocket(`wss://api.benzinga.com/api/v1/news/stream?token=${BZ_KEY}`);
  wsBZ.on('open',()=>{console.log('[BZ] Connected');wsBZ._ping=setInterval(()=>{if(wsBZ.readyState===WebSocket.OPEN)wsBZ.send(JSON.stringify({action:'ping'}));},30000);});
  wsBZ.on('message',data=>{try{const msg=JSON.parse(data.toString());if(msg.kind==='news'&&msg.data&&msg.data.content){const n=msg.data.content;const tickers=(n.stocks||[]).map(s=>s.name||'').filter(Boolean).map(t=>t.toUpperCase());if(tickers.length)handleNewsItem(n.title||'',tickers,n.url||'',n.created||'').catch(()=>{});}}catch(e){}});
  wsBZ.on('error',err=>console.error('[BZ] Error:',err.message));
  wsBZ.on('close',()=>{if(wsBZ._ping)clearInterval(wsBZ._ping);setTimeout(connectBZ,10000);});
}

let lastNewsPoll=0;
async function pollNews(){
  if(!isActive()) return;
  if(Date.now()-lastNewsPoll<5000) return;
  lastNewsPoll=Date.now();
  try{
    const r=await polyGet('/v2/reference/news?limit=50&order=desc&sort=published_utc');
    const items=(r&&r.results)||[];
    const cutoff=Date.now()-3*60*1000;
    for(const n of items){
      if(!n.published_utc||new Date(n.published_utc).getTime()<cutoff) continue;
      const tickers=(n.tickers||[]).filter(Boolean).map(t=>t.toUpperCase());
      await handleNewsItem(n.title||'',tickers,n.article_url||'',n.published_utc);
    }
  }catch(e){}
}

// ─── SEC/EDGAR filings ────────────────────────────────────────────────────────
let lastFilingCheck=0;
async function checkFilings(){
  if(!isActive()) return;
  if(Date.now()-lastFilingCheck<2*60*1000) return;
  lastFilingCheck=Date.now();
  const knownTickers=new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys()]);
  if(!knownTickers.size) return;
  const {timeStr}=getET();
  for(const ticker of knownTickers){
    try{
      const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=5&order=desc&sort=filed_at`);
      for(const f of (r&&r.results||[])){
        const filed=new Date(f.filed_at||0).getTime();
        const id=(f.filing_url||f.accession_number||'').slice(0,80);
        if(filed<=Date.now()-15*60*1000||state.sentFilings.has(id)) continue;
        state.sentFilings.add(id);
        const ft=(f.form_type||'SEC').toUpperCase();
        const isDil=/S-3|S-1|424B/.test(ft);
        const g=topGappers.find(x=>x.ticker===ticker)||dayWatchlist.get(ticker);
        const pStr=g?` | $${g.price.toFixed(4)} \`+${g.chgPct.toFixed(1)}%\``:'';
        await post({content:`\`${timeStr}\` **SEC** **${ticker}**${isDil?' ⚠️':''} — Form ${ft}${f.filing_url?` — [Link](<${f.filing_url}>)`:''}${pStr}`});
        console.log(`[${timeStr}] FILING: ${ticker} ${ft}`);
      }
    }catch(e){}
    await sleep(200);
  }
}

// ─── Morning Snapshot ─────────────────────────────────────────────────────────
async function checkMorningSnapshot(){
  const {hh,m}=getET();
  if((hh!==6&&hh!==7)||m!==0) return;
  const key=`${new Date().toISOString().slice(0,10)}_${hh}`;
  if(state.morningPosted.has(key)||!topGappers.length) return;
  state.morningPosted.add(key);
  const rows=topGappers.map(g=>{
    const dot=g.chgPct>=200?'🔴':g.chgPct>=100?'🟠':g.chgPct>=50?'🟡':'🟢';
    return`${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(4)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}`;
  }).join('\n');
  await post({embeds:[{title:`${hh===6?'🌅 6AM':'☀️ 7AM'} Pre-Market Hot Gappers`,description:rows||'No data',color:0x00d4ff,footer:{text:`AziziBot · ${getET().timeStr} ET`},timestamp:new Date().toISOString()}]});
  console.log(`[${getET().timeStr}] Morning snapshot posted`);
}

// ─── Price WebSocket ──────────────────────────────────────────────────────────
let ws=null;
const subscribedTickers=new Set();

function connectPriceWS(){
  if(ws){try{ws.terminate();}catch(e){}}
  console.log('[PriceWS] Connecting...');
  ws=new WebSocket('wss://socket.polygon.io/stocks');
  ws.on('open',()=>{console.log('[PriceWS] Open — sending auth');ws.send(JSON.stringify({action:'auth',params:POLY_KEY}));});
  ws.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'){
          console.log(`[PriceWS] ${msg.status}: ${msg.message||''}`);
          if(msg.status==='auth_success'){
            subscribedTickers.clear();
            const allKeys=new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys()]);
            const subs=[...allKeys].map(t=>`T.${t},A.${t}`).join(',');
            if(subs){ws.send(JSON.stringify({action:'subscribe',params:subs}));allKeys.forEach(t=>subscribedTickers.add(t));}
            console.log(`[PriceWS] Subscribed ${allKeys.size} tickers (${topGappers.length} live + ${dayWatchlist.size} watch)`);
          }
          if(msg.status==='auth_failed') console.error('[PriceWS] AUTH FAILED — check POLY_KEY');
        }
        if(msg.ev==='T'||msg.ev==='A'){
          const ticker=msg.sym;
          const price =msg.ev==='T'?msg.p:(msg.c||msg.h||0);
          if(!price||!ticker) continue;

          const liveG =topGappers.find(x=>x.ticker===ticker);
          const watchG=dayWatchlist.get(ticker);
          if(!liveG&&!watchG) continue;
          if(liveG&&(liveG.price>10||liveG.chgPct<5)) continue;

          const s=state.tickers.get(ticker);
          if(!s) continue;

          if(!s.priceHistory) s.priceHistory=[];
          s.priceHistory.push({price,time:Date.now()});
          if(s.priceHistory.length>60) s.priceHistory.shift();

          if(price>s.high+0.001){
            const last=wsDebounce.get(ticker)||0;
            if(Date.now()-last>10000){
              console.log(`[PriceWS] ${ticker} NEW HIGH $${price.toFixed(4)} (was $${s.high.toFixed(4)})`);
              wsDebounce.set(ticker,Date.now());
              fireNHOD(ticker,price).catch(e=>console.error(`[fireNHOD] ${ticker}:`,e.message));
            }
          }
        }
      }
    }catch(e){console.error('[PriceWS] parse error:',e.message);}
  });
  ws.on('error',err=>console.error('[PriceWS] error:',err.message));
  ws.on('close',code=>{console.log(`[PriceWS] closed (${code}), reconnecting...`);setTimeout(connectPriceWS,5000);});
}

function subscribeNewTickers(tickers){
  if(!ws||ws.readyState!==WebSocket.OPEN||!tickers.length) return;
  ws.send(JSON.stringify({action:'subscribe',params:tickers.map(t=>`T.${t},A.${t}`).join(',')}));
  tickers.forEach(t=>subscribedTickers.add(t));
  console.log(`[PriceWS] +subscribed: ${tickers.join(', ')}`);
}

// ─── Discord slash commands ───────────────────────────────────────────────────
async function buildQuoteEmbed(ticker){
  ticker=ticker.toUpperCase().trim();
  const [snap,det,fv,rs,newsR]=await Promise.all([
    polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
    getTickerDetails(ticker),getFinvizStats(ticker),getRecentSplit(ticker),
    polyGet(`/v2/reference/news?ticker=${ticker}&limit=10&order=desc&sort=published_utc`),
  ]);
  const td=snap&&snap.ticker;
  if(!td) return{content:`No data for **${ticker}**`};
  const price=(td.lastTrade&&td.lastTrade.p)||(td.day&&td.day.c)||0;
  const prev=(td.prevDay&&td.prevDay.c)||0;
  const chgPct=price&&prev?((price-prev)/prev)*100:0;
  const vol=(td.day&&td.day.v)||0;
  const pv2=(td.prevDay&&td.prevDay.v)||0;
  const {etMin}=getET();
  const rvol=pv2>0?(vol*390)/(Math.max(etMin-240,1)*pv2):0;
  const mc=det.market_cap||0;
  const cutoff=Date.now()-30*24*60*60*1000;
  const news=((newsR&&newsR.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,5);
  const newsStr=news.map(n=>{const age=Date.now()-new Date(n.published_utc).getTime();const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;return`• [${(n.title||'').slice(0,80)}](<${n.article_url||''}>) — *${a} ago*`;}).join('\n')||'No recent news';
  const fields=[
    {name:'Price',value:`$${price.toFixed(4)} ${chgPct>=0?'▲':'▼'} \`${chgPct>=0?'+':''}${chgPct.toFixed(2)}%\``,inline:true},
    {name:'Volume',value:fmtN(vol),inline:true},{name:'RVol',value:fmtRVol(rvol),inline:true},
    {name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true},{name:'Float',value:fv.float,inline:true},
    {name:'SI%',value:fv.si,inline:true},{name:'IO%',value:fv.io,inline:true},
    {name:'Prev Close',value:`$${prev.toFixed(4)}`,inline:true},
    {name:'Day High',value:`$${((td.day&&td.day.h)||0).toFixed(4)}`,inline:true},
  ];
  if(rs) fields.push({name:'Recent Split',value:rs,inline:false});
  fields.push({name:'Latest News (30d)',value:newsStr,inline:false});
  return{embeds:[{title:`${ticker} — ${det.name||ticker}`,color:chgPct>=0?0x26a641:0xe03e3e,fields,footer:{text:`AziziBot · ${getET().timeStr} ET`},timestamp:new Date().toISOString()}]};
}

async function handleCmd(cmd,option,interaction){
  await discordRest('POST',`/interactions/${interaction.id}/${interaction.token}/callback`,{type:5});
  let reply={content:'Unknown command'};
  try{
    if(cmd==='quote'||cmd==='q') reply=await buildQuoteEmbed(option);
    else if(cmd==='gappers'){
      const allTracked=[...topGappers,...[...dayWatchlist.values()].filter(w=>!topGappers.find(g=>g.ticker===w.ticker))];
      if(!allTracked.length) reply={content:'No tracked names right now.'};
      else{
        const rows=allTracked.map(g=>{
          const isWatch=!topGappers.find(x=>x.ticker===g.ticker);
          return`${isWatch?'👁':'🔥'} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | Vol: ${fmtN(g.volume)}${g.lockedAt?` [${g.lockedAt}]`:''}`;
        }).join('\n');
        reply={embeds:[{title:`🔥 Live: ${topGappers.length} | 👁 Watch: ${dayWatchlist.size}`,description:rows.slice(0,3900),color:0x00d4ff,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};
      }
    }
    else if(cmd==='news'){const ticker=option.toUpperCase();const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=10&order=desc&sort=published_utc`);const cutoff=Date.now()-30*24*60*60*1000;const items=((r&&r.results)||[]).filter(n=>n.published_utc&&new Date(n.published_utc).getTime()>cutoff).slice(0,8);if(!items.length)reply={content:`No recent news for **${ticker}**.`};else{const rows=items.map(n=>{const age=Date.now()-new Date(n.published_utc).getTime();const a=age<3600000?`${Math.round(age/60000)}m`:age<86400000?`${Math.round(age/3600000)}h`:`${Math.round(age/86400000)}d`;return`• [${(n.title||'').slice(0,90)}](<${n.article_url||''}>) — *${a} ago*`;}).join('\n');reply={embeds:[{title:`📰 ${ticker} — Latest News`,description:rows,color:0x5865f2,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};}}
    else if(cmd==='si'||cmd==='float'){const ticker=option.toUpperCase();const [fv,det]=await Promise.all([getFinvizStats(ticker),getTickerDetails(ticker)]);const mc=det.market_cap||0;reply={embeds:[{title:`📊 ${ticker} — Short Interest & Float`,color:0xf0a500,fields:[{name:'Short Interest %',value:fv.si,inline:true},{name:'Float',value:fv.float,inline:true},{name:'IO%',value:fv.io,inline:true},{name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true}],footer:{text:`AziziBot · Finviz · ${getET().timeStr} ET`}}]};}
    else if(cmd==='filings'){const ticker=option.toUpperCase();const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=8&order=desc&sort=filed_at`);const filings=(r&&r.results)||[];if(!filings.length)reply={content:`No filings found for **${ticker}**`};else{const rows=filings.map(f=>{const ft=(f.form_type||'').toUpperCase();const d=f.filed_at?new Date(f.filed_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';return`${/S-3|S-1|424B|8-K/.test(ft)?'⚠️':'📋'} **${ft}** ${d}${f.filing_url?` · [Link](<${f.filing_url}>)`:''}`}).join('\n');reply={embeds:[{title:`📋 ${ticker} — SEC Filings`,description:rows,color:0x7289da,footer:{text:`AziziBot · ${getET().timeStr} ET`}}]};}}
  }catch(e){reply={content:`Error: ${e.message}`};}
  await discordRest('PATCH',`/webhooks/${APP_ID}/${interaction.token}/messages/@original`,reply);
}

// ─── Discord Gateway ──────────────────────────────────────────────────────────
let wsDiscord=null,discordHB=null,discordSeq=null;
function connectDiscord(){
  if(wsDiscord){try{wsDiscord.terminate();}catch(e){}}
  wsDiscord=new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');
  wsDiscord.on('open',()=>console.log('[Discord] Connected'));
  wsDiscord.on('message',async data=>{
    try{
      const msg=JSON.parse(data.toString());
      if(msg.s) discordSeq=msg.s;
      if(msg.op===10){if(discordHB)clearInterval(discordHB);discordHB=setInterval(()=>wsDiscord.send(JSON.stringify({op:1,d:discordSeq})),msg.d.heartbeat_interval);wsDiscord.send(JSON.stringify({op:2,d:{token:DISCORD_TOKEN,intents:(1<<9)|(1<<15),properties:{os:'linux',browser:'azizibot',device:'azizibot'}}}));}
      if(msg.op===0){
        if(msg.t==='READY') console.log(`[Discord] Ready as ${msg.d.user.username}`);
        if(msg.t==='INTERACTION_CREATE'&&msg.d.type===2){const cmd=msg.d.data.name;const option=(msg.d.data.options&&msg.d.data.options[0]&&msg.d.data.options[0].value)||'';handleCmd(cmd,option,msg.d).catch(e=>console.error('[Discord] cmd:',e.message));}
        if(msg.t==='MESSAGE_CREATE'&&!msg.d.author.bot){const m=(msg.d.content||'').trim().match(/^\$?([A-Z]{1,5})$/);if(m)buildQuoteEmbed(m[1]).then(embed=>discordRest('POST',`/channels/${msg.d.channel_id}/messages`,embed)).catch(()=>{});}
      }
      if(msg.op===7||msg.op===9) setTimeout(connectDiscord,msg.op===9?5000:1000);
    }catch(e){}
  });
  wsDiscord.on('error',err=>console.error('[Discord] error:',err.message));
  wsDiscord.on('close',code=>{if(discordHB)clearInterval(discordHB);console.log(`[Discord] closed (${code}), reconnecting...`);setTimeout(connectDiscord,5000);});
}

async function registerCommands(){
  const cmds=[
    {name:'quote',description:'Full quote card',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'gappers',description:'Live gappers + full day watchlist'},
    {name:'news',description:'Latest news',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'si',description:'Short interest & float',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'float',description:'Float & short interest',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
    {name:'filings',description:'SEC filings',options:[{type:3,name:'ticker',description:'Ticker',required:true}]},
  ];
  try{const r=await discordRest('PUT',`/applications/${APP_ID}/commands`,cmds);console.log(`[Discord] ${Array.isArray(r)?r.length:0} commands registered`);}
  catch(e){console.error('[Discord] register:',e.message);}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  if(!POLY_KEY)      {console.error('FATAL: POLY_KEY missing');process.exit(1);}
  if(!DISCORD_TOKEN) {console.error('FATAL: DISCORD_TOKEN missing');process.exit(1);}
  console.log('🤖 AziziBot v8 starting...');
  console.log('[Tiers] EARLY-PRE 4-7AM ≥10%+prevVol100K | LATE-PRE 7-9:30AM ≥30%+1M | MKT ≥20%+10M | AH ≥10%+prevVol100K');
  console.log('[Watch] 4AM-4PM lock-in | stays active all day for bounces/PRs/filings');

  await refreshEtfList();
  await refreshGappers();
  connectPriceWS();
  connectDiscord();
  // if(BZ_KEY) connectBZ();
  await registerCommands();

  setInterval(async()=>{
    await refreshEtfList();
    await refreshGappers();
    const newTickers=[...new Set([...topGappers.map(g=>g.ticker),...dayWatchlist.keys()])].filter(t=>!subscribedTickers.has(t));
    if(newTickers.length) subscribeNewTickers(newTickers);
    await pollNews();
  },20*1000);

  setInterval(async()=>{
    const {hh,m}=getET();
    if(hh===0&&m<1){
      state.dailyCounts.clear();state.tickers.clear();state.sentFilings.clear();
      dayWatchlist.clear();
      console.log('[Daily] Reset');
    }
    await checkMorningSnapshot();
    await checkFilings();
  },60*1000);

  console.log('🤖 AziziBot v8 running.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
