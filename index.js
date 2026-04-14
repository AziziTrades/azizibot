// AziziBot v5 — Hot names only: one alert on discovery + PR/news alerts
// Railway.app — Node.js 18+

const https = require('https');
const WebSocket = require('ws');

const POLY_KEY = process.env.POLY_KEY||'';
const BOT_NAME = 'AziziBot';

const WH = {
  TOP_GAPPERS:    'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3',
  PRESS_RELEASES: 'https://discord.com/api/webhooks/1493289596732309657/tuhNqm8r3VB2k1rNcWDq487BNiPdlluNjDBX45IpdshxZv969Uskq1z3jKJ3AtGzkLdb',
  HALT_ALERTS:    'https://discord.com/api/webhooks/1493289994075242538/Jo3kfIzST8pqSAcxUbQ2_nzeWbQACDee4DTydBCZW5WcQjHBAdxA2jNeynkGafte7g5T',
  SEC_FILINGS:    'https://discord.com/api/webhooks/1493290146068697259/VPRB_3eUUyQReJpF_XkqeC324FKTVbARCf15jvOSb33lKguSdlf3eR1euWnsV6gq2enj',
  MAIN_CHAT:      'https://discord.com/api/webhooks/1493201376484786217/Hv4PUUUVCVTa80ukQuR5pUc5wa5ZrXAfGtAdqa2KLoEN3WJ7h79hZiXzEMIzQ9-IfmRW'
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getETInfo() {
  const now = new Date();
  const p = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'numeric',minute:'numeric',second:'numeric',hour12:false}).formatToParts(now);
  const h = parseInt(p.find(x=>x.type==='hour').value);
  const m = parseInt(p.find(x=>x.type==='minute').value);
  const s = parseInt(p.find(x=>x.type==='second').value);
  const hh = h===24?0:h;
  const etMin = hh*60+m;
  const timeStr = `${String(hh).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  const sess = etMin>=240&&etMin<570?'PRE-MARKET':etMin>=570&&etMin<960?'MARKET':etMin>=960&&etMin<1200?'AFTER-HOURS':'CLOSED';
  return {h:hh,m,s,etMin,timeStr,sess};
}
function isActive(){return getETInfo().etMin>=240&&getETInfo().etMin<1200;}
function fmtN(n){if(!n||isNaN(n))return'--';if(n>=1e9)return(n/1e9).toFixed(2)+'B';if(n>=1e6)return(n/1e6).toFixed(2)+'M';if(n>=1e3)return(n/1e3).toFixed(1)+'K';return String(n);}
function fmtRVol(r){if(!r||isNaN(r)||r===0)return'--';if(r>=1000)return Math.round(r).toLocaleString()+'x';if(r>=10)return r.toFixed(0)+'x';return r.toFixed(1)+'x';}
function priceFlag(p){if(p<1)return'<$1';if(p<2)return'<$2';if(p<5)return'<$5';if(p<10)return'<$10';return'<$20';}
function countryFlag(t){if(/^[A-Z]{2,4}(AO|BO|O|Y|YY)$/.test(t))return'🇨🇳';if(/^[A-Z]{2,4}L$/.test(t))return'🇬🇧';return'🇺🇸';}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

function rawGet(url){
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{headers:{'User-Agent':'AziziBot/1.0'}},res=>{
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

// ─── Polygon data helpers ─────────────────────────────────────────────────────
const tickerCache=new Map();
async function getTickerDetails(ticker){
  const c=tickerCache.get(ticker);
  if(c&&Date.now()-c.ts<60*60*1000)return c.data;
  try{
    const r=await polyGet(`/v3/reference/tickers/${ticker}`);
    const data=(r&&r.results)||{};
    tickerCache.set(ticker,{data,ts:Date.now()});
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
    const r=await polyGet(`/v3/reference/splits?ticker=${ticker}&limit=10&order=desc`);
    const splits=(r&&r.results)||[];
    const s=splits.find(s=>{
      const d=(Date.now()-new Date(s.execution_date).getTime())/86400000;
      return d<=90&&s.split_from>s.split_to;
    });
    if(s){const d=new Date(s.execution_date);return `${s.split_to} for ${s.split_from} R/S ${d.toLocaleString('en-US',{month:'short'})}. ${d.getDate()}`;}
  }catch(e){}
  return null;
}

// Yahoo Finance — SI% + Float (free, no key needed)
async function getYahooStats(ticker){
  const r={si:'--',float:'--'};
  try{
    // Finviz free page — no API key needed, has float + SI% for all tickers
    const html=await new Promise((resolve,reject)=>{
      const req=https.get(`https://finviz.com/quote.ashx?t=${ticker}`,{
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':'text/html,application/xhtml+xml',
          'Accept-Language':'en-US,en;q=0.9',
          'Referer':'https://finviz.com/'
        }
      },res=>{
        let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));
      });
      req.on('error',reject);req.setTimeout(6000,()=>{req.destroy();reject(new Error('timeout'));});
    });
    // Finviz table format: <td class="snapshot-td2">VALUE</td>
    // Float row label is "Shs Float", SI% label is "Short Float"
    const floatM=html.match(/Shs Float<\/td><td[^>]*>([^<]+)<\/td>/i)||
                 html.match(/Shs Float[^<]*<\/td>\s*<td[^>]*>([^<]+)<\/td>/i);
    if(floatM)r.float=floatM[1].trim();

    const siM=html.match(/Short Float[^<]*<\/td><td[^>]*>([\d.]+%)<\/td>/i)||
              html.match(/Short Float[^<]*<\/td>\s*<td[^>]*>([\d.]+%)<\/td>/i);
    if(siM)r.si=siM[1].trim();
  }catch(e){console.error(`[Finviz] ${ticker}:`,e.message);}
  return r;
}

async function getTickerDetails(ticker){
  const c=tickerCache.get(ticker);
  if(c&&Date.now()-c.ts<60*60*1000)return c.data;
  try{
    const r=await polyGet(`/v3/reference/tickers/${ticker}`);
    const data=(r&&r.results)||{};
    tickerCache.set(ticker,{data,ts:Date.now()});
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
    const r=await polyGet(`/v3/reference/splits?ticker=${ticker}&limit=10&order=desc`);
    const splits=(r&&r.results)||[];
    const s=splits.find(s=>{
      const d=(Date.now()-new Date(s.execution_date).getTime())/86400000;
      return d<=90&&s.split_from>s.split_to;
    });
    if(s){const d=new Date(s.execution_date);return `${s.split_to} for ${s.split_from} R/S ${d.toLocaleString('en-US',{month:'short'})}. ${d.getDate()}`;}
  }catch(e){}
  return null;
}

// Yahoo Finance — SI% + Float (free, no key needed)
async function getYahooStats(ticker){
  const r={si:'--',float:'--'};
  try{
    // Try both modules for better coverage across all tickers
    const url=`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=defaultKeyStatistics%2CsummaryDetail`;
    const raw=await new Promise((resolve,reject)=>{
      const req=https.get(url,{
        headers:{
          'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept':'application/json',
          'Accept-Language':'en-US,en;q=0.9'
        }
      },res=>{
        let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));
      });
      req.on('error',reject);req.setTimeout(6000,()=>{req.destroy();reject(new Error('timeout'));});
    });
    const j=JSON.parse(raw);
    const result=j?.quoteSummary?.result?.[0];
    const ks=result?.defaultKeyStatistics||{};
    const sd=result?.summaryDetail||{};

    // Float — try multiple field paths
    const floatShares=
      ks.floatShares?.raw||
      ks.impliedSharesOutstanding?.raw||
      sd.floatShares?.raw||0;
    if(floatShares>0)r.float=fmtN(floatShares);

    // Short interest — try multiple fields
    const siPct=
      ks.shortPercentOfFloat?.raw||
      ks.shortPercentOfFloatShares?.raw||0;
    const siShares=ks.sharesShort?.raw||0;
    const sharesOut=ks.sharesOutstanding?.raw||floatShares||0;
    if(siPct>0){
      r.si=`${(siPct*100).toFixed(1)}%`;
    }else if(siShares>0&&sharesOut>0){
      // Calculate SI% from raw shares if percent not available
      r.si=`${((siShares/sharesOut)*100).toFixed(1)}%`;
    }
  }catch(e){console.error(`[Yahoo] ${ticker}:`,e.message);}
  return r;
}

// SEC EDGAR — resolve ticker from CIK (free, no key)
// EDGAR link URLs contain /data/{CIK}/ which maps to ticker via data.sec.gov
const cikTickerCache=new Map();
async function getTickerFromCIK(cik){
  if(!cik)return'';
  if(cikTickerCache.has(cik))return cikTickerCache.get(cik);
  try{
    const padded=String(cik).padStart(10,'0');
    const r=await jsonGet(`https://data.sec.gov/submissions/CIK${padded}.json`);
    const ticker=(r&&r.tickers&&r.tickers[0])||'';
    if(ticker)cikTickerCache.set(cik,ticker);
    return ticker;
  }catch(e){return'';}
}


// ─── ETF filter ───────────────────────────────────────────────────────────────
let etfSet=new Set();
let lastEtfRefresh=0;
async function refreshEtfList(){
  if(Date.now()-lastEtfRefresh<6*60*60*1000)return;
  try{
    let path='/v3/reference/tickers?type=ETF&market=stocks&active=true&limit=1000';
    const newSet=new Set();
    let pages=0;
    while(path&&pages<5){
      const r=await polyGet(path);
      if(!r||!r.results)break;
      r.results.forEach(t=>newSet.add(t.ticker));
      path=r.next_url?r.next_url.replace('https://api.polygon.io',''):null;
      pages++;
    }
    if(newSet.size>0){etfSet=newSet;lastEtfRefresh=Date.now();console.log(`[ETF] Loaded ${etfSet.size} tickers`);}
  }catch(e){console.error('refreshEtfList:',e.message);}
}
function isEtf(ticker){
  if(etfSet.has(ticker))return true;
  if(/^(SPY|QQQ|IWM|DIA|GLD|SLV|TLT|HYG|VXX|UVXY|SQQQ|TQQQ|SPXU|SPXL|SOXL|SOXS|TECL|TECS|LABD|LABU|NUGT|DUST|FAS|FAZ|TNA|TZA|UPRO|SDOW|UDOW|GUSH|DRIP|ERX|ERY|BOIL|KOLD|ARKK|ARKG|ARKW|ARKF|GDX|GDXJ|XLF|XLE|XLK|XLV|XLI|XLP|XLU|VTI|VOO|IVV|IJR|IJH)$/.test(ticker))return true;
  return false;
}

// ─── State ────────────────────────────────────────────────────────────────────
const state={
  alertedGappers:new Set(),  // tickers alerted today
  recentMovers:new Set(),     // tickers alerted this week
  sentHalts:new Set(),sentResumes:new Set(),
  sentFilings:new Set(),sentPRSpike:new Set(),sentPRDrop:new Set(),
  sentNews:new Set(),morningPosted:new Set(),
  recentNewsCache:new Map()
};
let topGappers=[];
let lastFilingCheck=0;
let lastHaltCheck=0;
let lastNewsPoll=0;

// ─── Hot Gapper Quality Bar ───────────────────────────────────────────────────
// Strict thresholds — only genuinely hot names get through
const MIN_RVOL   = 5;     // time-normalized RVol
const MIN_VOL    = 100000; // absolute volume
const MIN_CHG    = 10;    // minimum % gain
const MAX_PRICE  = 20;
const MIN_PRICE  = 0.10;

async function refreshTopGappers(){
  try{
    const [pg,pc,pv]=await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers&sort=changePercent&direction=desc&limit=100'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers&sort=volume&direction=desc&limit=100')
    ]);
    const build=t=>{
      const lp=(t.lastTrade&&t.lastTrade.p)||(t.day&&t.day.c)||0;
      const prev=(t.prevDay&&t.prevDay.c)||0;
      const chg=lp>0&&prev>0?((lp-prev)/prev)*100:(t.todaysChangePerc||0);
      const vol=(t.day&&t.day.v)||(t.min&&t.min.av)||0;
      const pv2=(t.prevDay&&t.prevDay.v)||0;
      const minutesActive=Math.max(getETInfo().etMin-240,1);
      const timeScale=Math.min(780/minutesActive,30);
      const rvol=pv2>0?(vol*timeScale)/pv2:0;
      const exchange=t.primaryExchange||t.primary_exchange||'';
      const isOTC=!exchange||/OTC|GREY|PINK|EXPERT/i.test(exchange)||exchange==='OTC';
      return{ticker:t.ticker,price:lp,prev,chgPct:chg,volume:vol,prevVol:pv2,rvol,high:(t.day&&t.day.h)||lp,isOTC};
    };
    const merge=new Map();
    for(const src of[pg,pc,pv])for(const t of((src&&src.tickers)||[]))if(!merge.has(t.ticker))merge.set(t.ticker,build(t));
    topGappers=[...merge.values()]
      .filter(t=>
        t.chgPct>=MIN_CHG &&
        t.price>=MIN_PRICE &&
        t.price<=MAX_PRICE &&
        t.volume>=MIN_VOL &&
        t.rvol>=MIN_RVOL &&
        !isEtf(t.ticker) &&
        !t.isOTC
      )
      .sort((a,b)=>b.chgPct-a.chgPct)
      .slice(0,20); // top 20 only
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} hot gappers`);
  }catch(e){console.error('refreshTopGappers:',e.message);}
}

// ─── Hot Gapper Discovery Alert — fires ONCE per ticker per session ───────────
async function fireGapperAlert(g){
  if(state.alertedGappers.has(g.ticker))return;
  state.alertedGappers.add(g.ticker);
  state.recentMovers.add(g.ticker);
  const etInfo=getETInfo();
  console.log(`[${etInfo.timeStr}] HOT GAPPER: ${g.ticker} +${g.chgPct.toFixed(1)}% RVol:${fmtRVol(g.rvol)}`);

  const[newsUrl,rs,details,yahoo]=await Promise.all([
    getLatestNewsUrl(g.ticker),
    getRecentSplit(g.ticker),
    getTickerDetails(g.ticker),
    getYahooStats(g.ticker)
  ]);

  const mc=details.market_cap||0;
  const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
  const siStr=yahoo.si!=='--'?` | SI: ${yahoo.si}`:''
  const floatStr=yahoo.float!=='--'?` | Float: ${yahoo.float}`:'';
  const rsStr=rs?` | ${rs}`:'';
  const sess=etInfo.sess;
  const sessLabel=sess==='PRE-MARKET'?'PM':sess==='AFTER-HOURS'?'AH':'';
  const tLink=newsUrl?`[${g.ticker}](<${newsUrl}>)`:`**${g.ticker}**`;
  const flag=countryFlag(g.ticker);

  // Check if there's a recent PR driving it
  const cached=state.recentNewsCache.get(g.ticker);
  const prStr=cached&&(Date.now()-cached.ts)<60*60*1000?` | [PR+](<${cached.url}>)`:'';

  const line=`\`${etInfo.timeStr}\` 🔥 ${tLink} \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\`${sessLabel?' `'+sessLabel+'`':''} ~ ${flag}${mcStr} | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)}${floatStr}${siStr}${rsStr}${prStr}`;
  await post(WH.MAIN_CHAT,{content:line});
}

// ─── Halts ────────────────────────────────────────────────────────────────────
async function checkHalts(){
  if(!isActive())return;
  if(Date.now()-lastHaltCheck<60*1000)return;
  lastHaltCheck=Date.now();
  const etInfo=getETInfo();
  const reasonMap={'T1':'News Pending','T2':'News Released','T3':'News/Resume','T5':'Single Stock Circuit Breaker','T6':'Extraordinary Market Activity','T8':'ETF Halt','H4':'Non-Compliance','H9':'Not Current','H10':'SEC Suspension','H11':'Regulatory Concern','O1':'Operations Halt','IPO1':'IPO Not Yet Trading','M1':'Corporate Action','M2':'Quotation Unavailable','LUDP':'Volatility Pause','LUDS':'Volatility Pause - Straddle','MWC1':'Market Wide Circuit Breaker'};
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
      const isResumed=resumeTime&&resumeTime.length>0;
      const reasonText=reasonMap[reason]||reason||'Trading Halt';
      const gapper=topGappers.find(g=>g.ticker===ticker);
      const priceStr=gapper?` → $${gapper.price.toFixed(2)}`:'';
      const volStr=gapper?` ~ ${fmtN(gapper.volume)} vol`:'';
      const newsUrl=await getLatestNewsUrl(ticker);
      const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
      const timeLabel=haltTime||etInfo.timeStr;
      if(isResumed){
        const rid=`resume_${id}`;
        if(state.sentResumes.has(rid))continue;
        state.sentResumes.add(rid);
        const line=`\`${resumeTime||etInfo.timeStr}\` ▶️ **RESUMED** ${tLink} | ${reasonText}${priceStr}${volStr}`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);
        await post(WH.HALT_ALERTS,{content:line});
      }else{
        const line=`\`${timeLabel}\` **${ticker}** | **Halted** | ${reasonText}${priceStr}${volStr}`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);
        await post(WH.HALT_ALERTS,{content:line});
        console.log(`[${etInfo.timeStr}] HALT: ${ticker} - ${reasonText}`);
      }
      await sleep(400);
    }
  }catch(e){
    console.error('NASDAQ halt RSS:',e.message);
    for(const g of topGappers){
      try{
        const id=`snap_${g.ticker}`;if(state.sentHalts.has(id))continue;
        const snap=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${g.ticker}`);
        const td=snap&&snap.ticker;if(!td)continue;
        const ltMs=(td.lastTrade&&td.lastTrade.t)||0;
        const now=Date.now();
        if((now-ltMs)/1000<120)continue;
        state.sentHalts.add(id);
        const minAgo=Math.floor((now-ltMs)/60000);
        const newsUrl=await getLatestNewsUrl(g.ticker);
        const tLink=newsUrl?`[${g.ticker}](<${newsUrl}>)`:`**${g.ticker}**`;
        const line=`\`${etInfo.timeStr}\` **${g.ticker}** | **Halted** | Trading Pause → $${g.price.toFixed(2)} ~ ${fmtN(g.volume)} vol | ~${minAgo}m ago`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);
        await post(WH.HALT_ALERTS,{content:line});
      }catch(e2){}
    }
  }
}

// EDGAR RSS — monitors S-1, S-3, 424B filings directly from SEC source
// Faster and more complete than Polygon's filing endpoint
let lastEdgarCheck=0;
const EDGAR_FORMS=['8-K','8-K/A','S-1','S-3','424B3','424B4','424B5'];
async function checkEDGARFilings(){
  if(!isActive())return;
  if(Date.now()-lastEdgarCheck<2*60*1000)return;
  lastEdgarCheck=Date.now();
  const etInfo=getETInfo();
  try{
    for(const form of EDGAR_FORMS){
      const xml=await new Promise((resolve,reject)=>{
        const url=`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${form}&dateb=&owner=include&count=20&output=atom`;
        const req=https.get(url,{headers:{'User-Agent':'AziziBot contact@azizibot.com','Accept':'application/xml'}},res=>{
          let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));
        });
        req.on('error',reject);req.setTimeout(8000,()=>{req.destroy();reject(new Error('timeout'));});
      });
      const entries=xml.match(/<entry>[\s\S]*?<\/entry>/g)||[];
      for(const entry of entries){
        const title=((entry.match(/<title>(.*?)<\/title>/)||[])[1]||'').trim();
        const link=((entry.match(/<link[^>]*href="([^"]+)"/)||[])[1]||'').trim();
        const updated=((entry.match(/<updated>(.*?)<\/updated>/)||[])[1]||'').trim();
        const id=(link||title).slice(0,100);
        if(!title||state.sentFilings.has(id))continue;
        // Check if filed recently (within last 15 min)
        if(updated&&(Date.now()-new Date(updated).getTime())>15*60*1000)continue;
        // Extract CIK from link URL: /Archives/edgar/data/{CIK}/
        // Then resolve to ticker via SEC's free company API
        const cikMatch=link.match(/\/data\/(\d+)\//);
        const cik=cikMatch?cikMatch[1]:'';
        const ticker=cik?await getTickerFromCIK(cik):'';
        // 8-K: always alert if we have a ticker (can be catalyst BEFORE it gaps)
        // All other forms: only alert for current hot gappers or today's runners
        const is8K=/^8-K/.test(form);
        const isKnownMover=ticker&&(topGappers.some(g=>g.ticker===ticker)||state.alertedGappers.has(ticker)||state.recentMovers.has(ticker));
        if(!isKnownMover){state.sentFilings.add(id);continue;}
        const snapF=await polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`);
        const tdF=snapF&&snapF.ticker;
        const priceF=(tdF&&tdF.lastTrade&&tdF.lastTrade.p)||(tdF&&tdF.day&&tdF.day.c)||0;
        if(priceF>20){state.sentFilings.add(id);continue;}
        state.sentFilings.add(id);
        const isDil=/S-3|S-1|424B/.test(form);
        const gapper=topGappers.find(g=>g.ticker===ticker);
        const priceStr=priceF>0?` | $${priceF.toFixed(2)}`+(gapper?` \`+${gapper.chgPct.toFixed(1)}%\``:``):``;
        const line=`\`${etInfo.timeStr}\` **SEC/EDGAR** **${ticker}** ${isDil?'⚠️':''} — Form ${form}${link?` — [Link](<${link}>)`:''}${priceStr}`;
        await post(WH.SEC_FILINGS,{content:line});await sleep(300);
        await post(WH.MAIN_CHAT,{content:line});
        console.log(`[${etInfo.timeStr}] EDGAR: ${form} ${ticker}`);
        await sleep(300);
      }
      await sleep(500); // be polite to SEC servers
    }
  }catch(e){console.error('checkEDGARFilings:',e.message);}
}

// ─── SEC Filings (Polygon backup) ──────────────────────────────────────────────────────────────
async function checkSECFilings(){
  if(!isActive()||!topGappers.length)return;
  if(Date.now()-lastFilingCheck<2*60*1000)return;
  lastFilingCheck=Date.now();
  const etInfo=getETInfo();
  const cutoff=Date.now()-15*60*1000;
  for(const g of topGappers){
    try{
      const r=await polyGet(`/vX/reference/filings?ticker=${g.ticker}&limit=5&order=desc&sort=filed_at`);
      const filings=(r&&r.results)||[];
      for(const f of filings){
        const filed=new Date(f.filed_at||0).getTime();
        const id=(f.filing_url||f.accession_number||'').slice(0,80);
        if(filed<=cutoff||state.sentFilings.has(id))continue;
        // Only alert for under $20 tickers we know about
        if(g.price>20)continue;
        state.sentFilings.add(id);
        const ft=(f.form_type||'SEC').toUpperCase();
        const lnk=f.filing_url||'';
        const isDil=/S-3|S-1|424B|ATM|DEFA14/.test(ft);
        const line=`\`${etInfo.timeStr}\` **SEC** **${g.ticker}**${isDil?' ⚠️':''} — Form ${ft}${lnk?` — [Link](<${lnk}>)`:''}`;
        await post(WH.SEC_FILINGS,{content:line});await sleep(300);
        await post(WH.MAIN_CHAT,{content:`${line} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``});await sleep(300);
        console.log(`[${etInfo.timeStr}] SEC: ${g.ticker} ${ft}`);
      }
      await sleep(100);
    }catch(e){}
  }
}

// ─── Morning Snapshot ─────────────────────────────────────────────────────────
async function checkMorningSnapshot(){
  const etInfo=getETInfo();
  if((etInfo.h!==6&&etInfo.h!==7)||etInfo.m!==0)return;
  const key=`${new Date().toISOString().slice(0,10)}_${etInfo.h}`;
  if(state.morningPosted.has(key))return;
  state.morningPosted.add(key);
  if(!topGappers.length)return;
  let rows='';
  topGappers.forEach(g=>{
    const dot=g.chgPct>=200?'🔴':g.chgPct>=100?'🟠':g.chgPct>=50?'🟡':'🟢';
    rows+=`${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}\n`;
  });
  await post(WH.TOP_GAPPERS,{embeds:[{title:`📊 ${etInfo.h===6?'🌅 6AM':'☀️ 7AM'} Hot Gappers`,description:rows||'No data',color:0x00d4ff,footer:{text:`AziziBot · ${etInfo.timeStr} ET`},timestamp:new Date().toISOString()}]});
  console.log(`[${etInfo.timeStr}] Morning snapshot posted`);
}

// ─── News polling — PR Spike + PR Drop ───────────────────────────────────────
const DROP_RE=/offering|public offering|convertible|shelf registration|ATM offering|at-the-market|direct offering|registered direct|dilut|warrant|prospectus|424B|S-1|S-3|secondary offering|note offering|senior notes|subordinated notes|debenture|equity financ/i;
const SPIKE_RE=/collaboration|agreement|partnership|FDA|approval|cleared|grant|award|contract|trial|data|results|positive|breakthrough|milestone|license|acqui|merger|acquisition|joint venture|phase|cohort|study|efficacy|safety/i;

async function pollNews(){
  if(!isActive())return;
  if(Date.now()-lastNewsPoll<30*1000)return;
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
      const id=(url||title).slice(0,100);
      if(state.sentNews.has(id))continue;
      state.sentNews.add(id);

      // Cache for gapper discovery alerts
      for(const t of tickers){if(url)state.recentNewsCache.set(t,{url,ts:Date.now()});}

      const isDrop=DROP_RE.test(title);
      const isSpike=!isDrop&&SPIKE_RE.test(title);
      if(!isDrop&&!isSpike)continue;

      const etInfo=getETInfo();
      for(const ticker of tickers.slice(0,3)){
        if(isEtf(ticker))continue;
        if(isDrop){
          const dropId=`prdrop_${id}_${ticker}`;
          if(state.sentPRDrop.has(dropId))continue;
          state.sentPRDrop.add(dropId);
          const[snap,details]=await Promise.all([
            polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
            getTickerDetails(ticker)
          ]);
          const td=snap&&snap.ticker;
          const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
          const mc=details.market_cap||0;
          const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
          const pStr=price>0?` \`${priceFlag(price)}\``:'';
          const link=url?` - [Link](<${url}>)`:'';
          const line=`**${ticker}**${pStr} - ${title.slice(0,200)}${link} ~ ${countryFlag(ticker)}${mcStr}`;
          await post(WH.PRESS_RELEASES,{content:`📉 **PR ↓ DROP** ${line}`});await sleep(300);
          await post(WH.MAIN_CHAT,{content:`\`${etInfo.timeStr}\` 📉 **PR ↓ DROP** ${line}`});await sleep(300);
          console.log(`[${etInfo.timeStr}] PR-DROP: ${ticker}`);
        }else{
          const spikeId=`prspike_${id}_${ticker}`;
          if(state.sentPRSpike.has(spikeId))continue;
          state.sentPRSpike.add(spikeId);
          const[snap,details]=await Promise.all([
            polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
            getTickerDetails(ticker)
          ]);
          const td=snap&&snap.ticker;
          const price=(td&&td.lastTrade&&td.lastTrade.p)||(td&&td.day&&td.day.c)||0;
          const mc=details.market_cap||0;
          const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
          const pStr=price>0?` \`${priceFlag(price)}\``:'';
          const link=url?` - [Link](<${url}>)`:'';
          const line=`**${ticker}**${pStr} - ${title.slice(0,200)}${link} ~ ${countryFlag(ticker)}${mcStr}`;
          await post(WH.PRESS_RELEASES,{content:`📈 **PR - Spike** ${line}`});await sleep(300);
          await post(WH.MAIN_CHAT,{content:`\`${etInfo.timeStr}\` 📈 **PR - Spike** ${line}`});await sleep(300);
          console.log(`[${etInfo.timeStr}] PR-SPIKE: ${ticker}`);
        }
      }
    }
    if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(x=>state.sentNews.add(x));}
    if(state.sentPRDrop.size>500){const a=[...state.sentPRDrop];state.sentPRDrop.clear();a.slice(-200).forEach(x=>state.sentPRDrop.add(x));}
    if(state.sentPRSpike.size>500){const a=[...state.sentPRSpike];state.sentPRSpike.clear();a.slice(-200).forEach(x=>state.sentPRSpike.add(x));}
  }catch(e){console.error('pollNews:',e.message);}
}


// Polygon LULD/Halt WebSocket — real-time halts & resumes (included in Stocks Advanced)
let wsHalt=null;
function connectHaltWS(){
  if(wsHalt){try{wsHalt.terminate();}catch(e){}}
  console.log('Connecting to Polygon halt WebSocket...');
  wsHalt=new WebSocket('wss://socket.polygon.io/stocks');
  wsHalt.on('open',()=>wsHalt.send(JSON.stringify({action:'auth',params:POLY_KEY})));
  wsHalt.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'&&msg.status==='auth_success'){
          // Subscribe to LULD events for all tickers
          wsHalt.send(JSON.stringify({action:'subscribe',params:'LULD.*'}));
          console.log('[Halt WS] Subscribed to LULD.*');
        }
        // LULD event — real-time halt/resume
        if(msg.ev==='LULD'){
          handleHaltEvent(msg).catch(()=>{});
        }
      }
    }catch(e){}
  });
  wsHalt.on('error',err=>{
    // If LULD not available on plan, fail silently — NASDAQ RSS still covers it
    if(err.message&&err.message.includes('404')){
      console.log('[Halt WS] LULD not available on this plan — using NASDAQ RSS fallback');
      return;
    }
    console.error('Halt WS error:',err.message);
  });
  wsHalt.on('close',()=>{
    console.log('Halt WS closed, reconnecting in 10s...');
    setTimeout(connectHaltWS,10000);
  });
}

async function handleHaltEvent(msg){
  const etInfo=getETInfo();
  const ticker=msg.T||msg.sym||'';
  if(!ticker)return;
  // msg.e = high limit, msg.f = low limit, msg.i = indicator
  // indicator: 'D' = halt, 'U' = resume, 'A' = allowed
  const indicator=msg.i||'';
  const isResume=indicator==='U'||indicator==='A';
  const isHalt=indicator==='D';
  if(!isResume&&!isHalt)return;

  const id=`luld_${ticker}_${msg.e||''}_${msg.s||Date.now()}`;
  if(state.sentHalts.has(id))return;
  state.sentHalts.add(id);

  const gapper=topGappers.find(g=>g.ticker===ticker);
  const priceStr=gapper?` → $${gapper.price.toFixed(2)}`:'';
  const volStr=gapper?` ~ ${fmtN(gapper.volume)} vol`:'';
  const newsUrl=await getLatestNewsUrl(ticker);
  const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;

  if(isResume){
    const line=`\`${etInfo.timeStr}\` ▶️ **RESUMED** ${tLink}${priceStr}${volStr}`;
    await post(WH.MAIN_CHAT,{content:line});await sleep(300);
    await post(WH.HALT_ALERTS,{content:line});
    console.log(`[${etInfo.timeStr}] RESUME: ${ticker}`);
  }else{
    const line=`\`${etInfo.timeStr}\` ⏸️ **HALTED** ${tLink} | Volatility Pause${priceStr}${volStr}`;
    await post(WH.MAIN_CHAT,{content:line});await sleep(300);
    await post(WH.HALT_ALERTS,{content:line});
    console.log(`[${etInfo.timeStr}] HALT: ${ticker}`);
  }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
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
          const subs=topGappers.map(g=>`T.${g.ticker}`).join(',');
          if(subs){ws.send(JSON.stringify({action:'subscribe',params:subs}));topGappers.forEach(g=>subscribedTickers.add(g.ticker));}
          console.log(`[Price WS] Subscribed to ${topGappers.length} tickers`);
        }
        // Price WS now only used to keep topGappers data fresh — no per-tick alerts
      }
    }catch(e){}
  });
  ws.on('error',err=>console.error('Price WS error:',err.message));
  ws.on('close',()=>{console.log('Price WS closed, reconnecting in 5s...');setTimeout(connectPriceWS,5000);});
}

function subscribeNewTickers(newTickers){
  if(!ws||ws.readyState!==WebSocket.OPEN||!newTickers.length)return;
  ws.send(JSON.stringify({action:'subscribe',params:newTickers.map(t=>`T.${t}`).join(',')}));
  newTickers.forEach(t=>subscribedTickers.add(t));
}


// ─── Discord Bot (slash commands + ticker lookup) ────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN||'';
const APP_ID        = process.env.DISCORD_APP_ID||'1493671812247322624';
const DISCORD_API   = 'https://discord.com/api/v10';

// Discord REST helper
function discordRest(method, path, body=null){
  return new Promise((resolve,reject)=>{
    const data=body?JSON.stringify(body):null;
    const u=new URL(`${DISCORD_API}${path}`);
    const req=https.request({
      hostname:u.hostname, path:u.pathname+u.search, method,
      headers:{'Authorization':`Bot ${DISCORD_TOKEN}`,'Content-Type':'application/json',...(data?{'Content-Length':Buffer.byteLength(data)}:{})}
    },res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>{try{resolve(JSON.parse(d));}catch(e){resolve({});} });});
    req.on('error',reject);
    if(data)req.write(data);
    req.end();
  });
}

// Reply to an interaction
async function replyInteraction(id, token, data){
  await discordRest('POST',`/interactions/${id}/${token}/callback`,{type:4,data});
}

// Deferred reply (for slower commands)
async function deferInteraction(id, token){
  await discordRest('POST',`/interactions/${id}/${token}/callback`,{type:5});
}
async function editInteractionReply(token, data){
  await discordRest('PATCH',`/webhooks/${APP_ID}/${token}/messages/@original`,data);
}

// ─── Command handlers ─────────────────────────────────────────────────────────

async function buildTickerEmbed(ticker){
  ticker=ticker.toUpperCase().trim();
  const[snap,details,yahoo,rs,newsItems]=await Promise.all([
    polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),
    getTickerDetails(ticker),
    getYahooStats(ticker),
    getRecentSplit(ticker),
    polyGet(`/v2/reference/news?ticker=${ticker}&limit=5&order=desc&sort=published_utc`)
  ]);
  const td=snap&&snap.ticker;
  if(!td)return null;
  const price=(td.lastTrade&&td.lastTrade.p)||(td.day&&td.day.c)||0;
  const prev=(td.prevDay&&td.prevDay.c)||0;
  const chgPct=price>0&&prev>0?((price-prev)/prev)*100:0;
  const vol=(td.day&&td.day.v)||0;
  const pv2=(td.prevDay&&td.prevDay.v)||0;
  const minutesActive=Math.max(getETInfo().etMin-240,1);
  const timeScale=Math.min(780/minutesActive,30);
  const rvol=pv2>0?(vol*timeScale)/pv2:0;
  const mc=details.market_cap||0;
  const high52=(td.day&&td.day.h)||0;
  const low52=(td.day&&td.day.l)||0;
  const gapper=topGappers.find(g=>g.ticker===ticker);
  const color=chgPct>=0?0x26a641:0xe03e3e;
  const arrow=chgPct>=0?'▲':'▼';

  // News headlines
  const news=(newsItems&&newsItems.results)||[];
  const newsStr=news.slice(0,5).map(n=>`• [${(n.title||'').slice(0,80)}](<${n.article_url||''}>)`).join('\n')||'No recent news';

  const fields=[
    {name:'Price',value:`$${price.toFixed(4)}  ${arrow} \`${chgPct>=0?'+':''}${chgPct.toFixed(2)}%\``,inline:true},
    {name:'Volume',value:fmtN(vol),inline:true},
    {name:'RVol',value:fmtRVol(rvol),inline:true},
    {name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true},
    {name:'Float',value:yahoo.float!=='--'?yahoo.float:'--',inline:true},
    {name:'SI%',value:yahoo.si!=='--'?yahoo.si:'--',inline:true},
    {name:'Day High / Low',value:`$${high52.toFixed(4)} / $${low52.toFixed(4)}`,inline:true},
    {name:'Prev Close',value:`$${prev.toFixed(4)}`,inline:true},
  ];
  if(rs)fields.push({name:'Recent Split',value:rs,inline:false});
  if(gapper)fields.push({name:'Status',value:`🔥 Hot Gapper  \`+${gapper.chgPct.toFixed(1)}%\``,inline:false});
  fields.push({name:'Latest News',value:newsStr,inline:false});

  return{
    embeds:[{
      title:`${ticker} — ${details.name||ticker}`,
      color,
      fields,
      footer:{text:`AziziBot · ${getETInfo().timeStr} ET`},
      timestamp:new Date().toISOString()
    }]
  };
}

async function cmdQuote(ticker){
  return await buildTickerEmbed(ticker)||{content:`No data found for **${ticker.toUpperCase()}**`};
}

async function cmdGappers(){
  if(!topGappers.length)return{content:'No hot gappers right now.'};
  const rows=topGappers.map(g=>`**${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)}`).join('\n');
  return{embeds:[{title:`🔥 Hot Gappers (${topGappers.length})`,description:rows,color:0x00d4ff,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`},timestamp:new Date().toISOString()}]};
}

async function cmdNews(ticker){
  ticker=ticker.toUpperCase().trim();
  const r=await polyGet(`/v2/reference/news?ticker=${ticker}&limit=8&order=desc&sort=published_utc`);
  const items=(r&&r.results)||[];
  if(!items.length)return{content:`No recent news for **${ticker}**`};
  const rows=items.map(n=>{
    const age=Math.round((Date.now()-new Date(n.published_utc).getTime())/60000);
    const ageStr=age<60?`${age}m ago`:`${Math.floor(age/60)}h ago`;
    return `• [${(n.title||'').slice(0,90)}](<${n.article_url||''}>) — *${ageStr}*`;
  }).join('\n');
  return{embeds:[{title:`📰 ${ticker} — Latest News`,description:rows,color:0x5865f2,footer:{text:`AziziBot · ${getETInfo().timeStr} ET`}}]};
}

async function cmdSI(ticker){
  ticker=ticker.toUpperCase().trim();
  const[yahoo,details]=await Promise.all([getYahooStats(ticker),getTickerDetails(ticker)]);
  const mc=details.market_cap||0;
  const fields=[
    {name:'Short Interest %',value:yahoo.si!=='--'?yahoo.si:'--',inline:true},
    {name:'Float',value:yahoo.float!=='--'?yahoo.float:'--',inline:true},
    {name:'Market Cap',value:mc>0?fmtN(mc):'--',inline:true},
  ];
  return{embeds:[{title:`📊 ${ticker} — Short Interest & Float`,color:0xf0a500,fields,footer:{text:`AziziBot · Yahoo Finance · ${getETInfo().timeStr} ET`}}]};
}

async function cmdHalts(){
  // Pull last 10 halts from NASDAQ RSS
  try{
    const xml=await rawGet('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts');
    const items=xml.match(/<item>[\s\S]*?<\/item>/g)||[];
    const halts=[];
    for(const item of items.slice(0,10)){
      const ticker=((item.match(/<IssueSymbol>(.*?)<\/IssueSymbol>/)||[])[1]||'').trim();
      const reason=((item.match(/<ReasonCode>(.*?)<\/ReasonCode>/)||[])[1]||'').trim();
      const haltTime=((item.match(/<HaltTime>(.*?)<\/HaltTime>/)||[])[1]||'').trim();
      const resumeTime=((item.match(/<ResumptionTime>(.*?)<\/ResumptionTime>/)||[])[1]||'').trim();
      if(!ticker)continue;
      const status=resumeTime?`▶️ Resumed ${resumeTime}`:`⏸️ Halted ${haltTime}`;
      halts.push(`**${ticker}** — ${status} | ${reason}`);
    }
    if(!halts.length)return{content:'No active halts found.'};
    return{embeds:[{title:'⏸️ Recent Trading Halts',description:halts.join('\n'),color:0xe03e3e,footer:{text:`AziziBot · NASDAQ · ${getETInfo().timeStr} ET`}}]};
  }catch(e){return{content:'Could not fetch halt data right now.'};}
}

async function cmdFilings(ticker){
  ticker=ticker.toUpperCase().trim();
  const r=await polyGet(`/vX/reference/filings?ticker=${ticker}&limit=8&order=desc&sort=filed_at`);
  const filings=(r&&r.results)||[];
  if(!filings.length)return{content:`No recent filings found for **${ticker}**`};
  const rows=filings.map(f=>{
    const ft=(f.form_type||'SEC').toUpperCase();
    const isDil=/S-3|S-1|424B|8-K/.test(ft);
    const filed=f.filed_at?new Date(f.filed_at).toLocaleDateString('en-US',{month:'short',day:'numeric'}):'';
    return `${isDil?'⚠️':'📋'} **${ft}** ${filed?`· ${filed}`:''}${f.filing_url?` · [Link](<${f.filing_url}>)`:''}`;
  }).join('\n');
  return{embeds:[{title:`📋 ${ticker} — SEC Filings`,description:rows,color:0x7289da,footer:{text:`AziziBot · Polygon.io · ${getETInfo().timeStr} ET`}}]};
}

async function cmdFloat(ticker){
  return await cmdSI(ticker); // same data source
}

// ─── Discord Gateway (receives slash commands + messages) ─────────────────────
let wsDiscord=null;
let discordHeartbeatInterval=null;
let discordSessionId=null;
let discordSeq=null;

function connectDiscordGateway(){
  if(wsDiscord){try{wsDiscord.terminate();}catch(e){}}
  console.log('Connecting to Discord gateway...');
  wsDiscord=new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

  wsDiscord.on('open',()=>console.log('[Discord] Gateway connected'));

  wsDiscord.on('message',async data=>{
    try{
      const msg=JSON.parse(data.toString());
      if(msg.s)discordSeq=msg.s;

      // op 10 = Hello — start heartbeat + identify
      if(msg.op===10){
        const interval=msg.d.heartbeat_interval;
        if(discordHeartbeatInterval)clearInterval(discordHeartbeatInterval);
        discordHeartbeatInterval=setInterval(()=>{
          wsDiscord.send(JSON.stringify({op:1,d:discordSeq}));
        },interval);
        // Identify
        wsDiscord.send(JSON.stringify({op:2,d:{
          token:DISCORD_TOKEN,
          intents:(1<<9)|(1<<15), // GUILD_MESSAGES + MESSAGE_CONTENT
          properties:{os:'linux',browser:'azizibot',device:'azizibot'}
        }}));
      }

      // op 0 = Dispatch
      if(msg.op===0){
        if(msg.t==='READY'){
          discordSessionId=msg.d.session_id;
          console.log(`[Discord] Ready as ${msg.d.user.username}`);
        }

        // Slash command interaction
        if(msg.t==='INTERACTION_CREATE'&&msg.d.type===2){
          const interaction=msg.d;
          const cmd=interaction.data.name;
          const option=(interaction.data.options&&interaction.data.options[0]&&interaction.data.options[0].value)||'';
          await deferInteraction(interaction.id,interaction.token);
          let reply={content:'Unknown command'};
          try{
            if(cmd==='quote')reply=await cmdQuote(option);
            else if(cmd==='gappers')reply=await cmdGappers();
            else if(cmd==='news')reply=await cmdNews(option);
            else if(cmd==='si')reply=await cmdSI(option);
            else if(cmd==='halt')reply=await cmdHalts();
            else if(cmd==='filings')reply=await cmdFilings(option);
            else if(cmd==='float')reply=await cmdFloat(option);
          }catch(e){reply={content:`Error: ${e.message}`};}
          await editInteractionReply(interaction.token,reply);
        }

        // Message — if just a ticker e.g. "WGRX" or "$WGRX" respond with full card
        if(msg.t==='MESSAGE_CREATE'&&!msg.d.author.bot){
          const content=(msg.d.content||'').trim();
          const tickerMatch=content.match(/^\$?([A-Z]{1,5})$/);
          if(tickerMatch){
            const ticker=tickerMatch[1];
            const embed=await buildTickerEmbed(ticker);
            if(embed){
              await discordRest('POST',`/channels/${msg.d.channel_id}/messages`,embed);
            }
          }
        }
      }

      // op 7 = Reconnect
      if(msg.op===7){
        console.log('[Discord] Reconnect requested');
        wsDiscord.terminate();
        setTimeout(connectDiscordGateway,1000);
      }

      // op 9 = Invalid session
      if(msg.op===9){
        console.log('[Discord] Invalid session, re-identifying in 5s');
        setTimeout(connectDiscordGateway,5000);
      }
    }catch(e){console.error('[Discord] Message error:',e.message);}
  });

  wsDiscord.on('error',err=>console.error('[Discord] Gateway error:',err.message));
  wsDiscord.on('close',(code)=>{
    console.log(`[Discord] Gateway closed (${code}), reconnecting in 5s...`);
    if(discordHeartbeatInterval)clearInterval(discordHeartbeatInterval);
    setTimeout(connectDiscordGateway,5000);
  });
}

// Register slash commands on startup
async function registerSlashCommands(){
  const commands=[
    {name:'quote',description:'Live price, volume, RVol, MC, float, SI for a ticker',options:[{type:3,name:'ticker',description:'Stock ticker (e.g. TSLA)',required:true}]},
    {name:'gappers',description:'Current hot gappers list'},
    {name:'news',description:'Latest news headlines for a ticker',options:[{type:3,name:'ticker',description:'Stock ticker',required:true}]},
    {name:'si',description:'Short interest % and float',options:[{type:3,name:'ticker',description:'Stock ticker',required:true}]},
    {name:'halt',description:'Recent trading halts and resumes'},
    {name:'filings',description:'Latest SEC filings for a ticker',options:[{type:3,name:'ticker',description:'Stock ticker',required:true}]},
    {name:'float',description:'Float and short interest for a ticker',options:[{type:3,name:'ticker',description:'Stock ticker',required:true}]},
  ];
  try{
    const r=await discordRest('PUT',`/applications/${APP_ID}/commands`,commands);
    console.log(`[Discord] Registered ${Array.isArray(r)?r.length:0} slash commands`);
  }catch(e){console.error('[Discord] Command registration error:',e.message);}
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(){
  if(!POLY_KEY)  {console.error('FATAL: POLY_KEY env var missing');process.exit(1);}
  if(!DISCORD_TOKEN){console.error('FATAL: DISCORD_TOKEN env var missing');process.exit(1);}
  console.log('🤖 AziziBot v5 starting — hot names + news only...');
  await refreshEtfList();
  await refreshTopGappers();
  connectPriceWS();
  connectHaltWS(); // Real-time halts & resumes

  // Fast loop every 20s — discover new hot gappers, fire once on entry
  setInterval(async()=>{
    const before=new Set(topGappers.map(g=>g.ticker));
    await refreshEtfList();
    await refreshTopGappers();

    // Fire ONE alert per newly discovered hot gapper
    const newlyHot=topGappers.filter(g=>!before.has(g.ticker));
    const unsubbed=newlyHot.map(g=>g.ticker).filter(t=>!subscribedTickers.has(t));
    if(unsubbed.length)subscribeNewTickers(unsubbed);
    for(const g of newlyHot){
      await fireGapperAlert(g);
      await sleep(500);
    }

    // Poll news every 30s
    await pollNews();
  },20*1000);

  // Slow loop every 60s — halts, SEC filings, morning snapshot
  setInterval(async()=>{
    await checkMorningSnapshot();
    await checkHalts();
    await checkEDGARFilings();
    await checkSECFilings();
  },60*1000);

  await registerSlashCommands();
  connectDiscordGateway();
  console.log('🤖 AziziBot v5 running. Hot names + news alerts + Discord commands active.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
