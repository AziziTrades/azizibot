// AziziBot v4 — Polygon-only, real-time news WebSocket
// Railway.app — Node.js 18+

const https = require('https');
const WebSocket = require('ws');

const POLY_KEY = '5jLrhuNS7DQZCp3eZpKHiuCBxuTddlLc';
const BOT_NAME = 'AziziBot';

const WH = {
  TOP_GAPPERS:    'https://discord.com/api/webhooks/1493250562689597623/57UTSPu2KfLmYNBRVPvPQIa4cSfCQA8wVcqB5d0J8cWYaJf5hlsm1EuRkQ3lolChTNh3',
  PRESS_RELEASES: 'https://discord.com/api/webhooks/1493289596732309657/tuhNqm8r3VB2k1rNcWDq487BNiPdlluNjDBX45IpdshxZv969Uskq1z3jKJ3AtGzkLdb',
  HALT_ALERTS:    'https://discord.com/api/webhooks/1493289994075242538/Jo3kfIzST8pqSAcxUbQ2_nzeWbQACDee4DTydBCZW5WcQjHBAdxA2jNeynkGafte7g5T',
  SEC_FILINGS:    'https://discord.com/api/webhooks/1493290146068697259/VPRB_3eUUyQReJpF_XkqeC324FKTVbARCf15jvOSb33lKguSdlf3eR1euWnsV6gq2enj',
  MAIN_CHAT:      'https://discord.com/api/webhooks/1493201376484786217/Hv4PUUUVCVTa80ukQuR5pUc5wa5ZrXAfGtAdqa2KLoEN3WJ7h79hZiXzEMIzQ9-IfmRW'
};

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

// Ticker details cache (market cap, type) — 1 hour TTL
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

async function getShortInterest(ticker){
  try{
    const r=await polyGet(`/v2/reference/short_interest/${ticker}`);
    const results=(r&&r.results)||[];
    if(results.length){
      const pct=results[0].percent_of_float||results[0].short_percent||0;
      if(pct>0)return `${(pct*100).toFixed(1)}%`;
    }
  }catch(e){}
  return '--';
}

// ETF filter — Polygon ticker type
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

const state={
  tickers:new Map(),sentHalts:new Set(),sentResumes:new Set(),
  sentFilings:new Set(),sentPRSpike:new Set(),sentPRDrop:new Set(),
  sentNews:new Set(),sentGreenBar:new Map(),morningPosted:new Set(),
  lastTrade:new Map(),priceHistory:new Map(),recentNewsCache:new Map(),
  nhodCooldown:new Map(),lastAlertedPrice:new Map(),alertWindow:new Map()
};
let topGappers=[];
let lastFilingCheck=0;
let lastHaltCheck=0;

async function refreshTopGappers(){
  try{
    const [pg,pc,pv]=await Promise.all([
      polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=true&sort=changePercent&direction=desc&limit=100'),
      polyGet('/v2/snapshot/locale/us/markets/stocks/tickers?include_otc=true&sort=volume&direction=desc&limit=100')
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
      return{ticker:t.ticker,price:lp,prev,chgPct:chg,volume:vol,prevVol:pv2,rvol,high:(t.day&&t.day.h)||lp};
    };
    const merge=new Map();
    for(const src of[pg,pc,pv])for(const t of((src&&src.tickers)||[]))if(!merge.has(t.ticker))merge.set(t.ticker,build(t));
    topGappers=[...merge.values()].filter(t=>t.chgPct>=5&&t.price>=0.1&&t.price<=20&&t.volume>=50000&&t.rvol>=1.5&&!isEtf(t.ticker)).sort((a,b)=>b.chgPct-a.chgPct).slice(0,50);
    for(const g of topGappers){const ex=state.tickers.get(g.ticker)||{high:0,nhod:0};state.tickers.set(g.ticker,{...ex,...g,high:Math.max(g.high,ex.high)});}
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} gappers`);
  }catch(e){console.error('refreshTopGappers:',e.message);}
}

async function fireNHOD(ticker,price){
  if(!isActive())return;
  const etInfo=getETInfo();
  const gapper=topGappers.find(g=>g.ticker===ticker);if(!gapper)return;
  const s=state.tickers.get(ticker);if(!s||price<=s.high+0.001)return;
  if(gapper.rvol<3)return;
  if(gapper.volume<25000)return;
  const lastAlerted=state.lastAlertedPrice.get(ticker)||0;
  if(lastAlerted>0&&price<lastAlerted*1.10)return;
  const nhod=(s.nhod||0)+1;
  state.tickers.set(ticker,{...s,high:price,nhod});
  const last=state.nhodCooldown.get(ticker)||0;
  if(Date.now()-last<15*60*1000)return;
  state.nhodCooldown.set(ticker,Date.now());
  const now15=Date.now();
  const times=(state.alertWindow.get(ticker)||[]).filter(t=>now15-t<15*60*1000);
  if(times.length>=3)return;
  times.push(now15);
  state.alertWindow.set(ticker,times);
  state.lastAlertedPrice.set(ticker,price);
  console.log(`[${etInfo.timeStr}] NHOD ${ticker} $${price.toFixed(2)} x${nhod}`);
  const[newsUrl,rs,details,si]=await Promise.all([getLatestNewsUrl(ticker),getRecentSplit(ticker),getTickerDetails(ticker),getShortInterest(ticker)]);
  const mc=details.market_cap||0;
  const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
  const siStr=si!=='--'?` | SI: ${si}`:'';
  const rsStr=rs?` | ${rs}`:'';
  let afterLull='';
  const hist=state.priceHistory.get(ticker)||[];
  if(hist.length>=10){
    const old=hist.filter(h=>h.time<Date.now()-10*60*1000);
    if(old.length>=3){const oH=Math.max(...old.map(h=>h.price)),oL=Math.min(...old.map(h=>h.price));if((oH-oL)/oL<0.02&&price>oH*1.03)afterLull=' · `after-lull`';}
  }
  let prInline='';
  const recentNews=state.recentNewsCache.get(ticker);
  if(recentNews&&(Date.now()-recentNews.ts)<60*60*1000)prInline=` | [PR+](<${recentNews.url}>)`;
  const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
  const sess=etInfo.sess;
  const label=nhod===1?(sess==='AFTER-HOURS'?'AHs':sess==='PRE-MARKET'?'PMH':'NSH'):`${nhod} NHOD`;
  const flag=countryFlag(ticker);
  const line=`\`${etInfo.timeStr}\` ↑ ${tLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${label}${afterLull} ~ ${flag}${mcStr} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${siStr}${rsStr}${prInline}`;
  await post(WH.MAIN_CHAT,{content:line});
}

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

async function checkGreenBars(){
  if(!isActive()||!topGappers.length)return;
  const etInfo=getETInfo();
  for(const g of topGappers.slice(0,20)){
    try{
      const last=state.sentGreenBar.get(g.ticker)||0;
      if(Date.now()-last<15*60*1000)continue;
      if(g.rvol<3||g.volume<25000)continue;
      const now=new Date();
      const from=new Date(now-60*60*1000).toISOString().slice(0,10);
      const to=now.toISOString().slice(0,10);
      const aggs=await polyGet(`/v2/aggs/ticker/${g.ticker}/range/5/minute/${from}/${to}?adjusted=true&sort=desc&limit=10`);
      if(!aggs||!aggs.results||aggs.results.length<3)continue;
      let gc=0;for(const b of aggs.results){if(b.c>b.o)gc++;else break;}
      if(gc<3)continue;
      state.sentGreenBar.set(g.ticker,Date.now());
      const newsUrl=await getLatestNewsUrl(g.ticker);
      const tLink=newsUrl?`[${g.ticker}](<${newsUrl}>)`:`**${g.ticker}**`;
      const line=`\`${etInfo.timeStr}\` ↗ ${tLink} \`${priceFlag(g.price)}\` · ${gc}${gc>=5?' 🔥':''} green bars 5m ~ ${countryFlag(g.ticker)} | RVol: ${fmtRVol(g.rvol)} | Vol: ${fmtN(g.volume)} | $${g.price.toFixed(2)} \`+${g.chgPct.toFixed(1)}%\``;
      await post(WH.MAIN_CHAT,{content:line});
      console.log(`[${etInfo.timeStr}] GREEN BARS: ${g.ticker} ${gc}x`);
    }catch(e){}
  }
}

async function checkSECFilings(){
  if(!isActive()||!topGappers.length)return;
  if(Date.now()-lastFilingCheck<2*60*1000)return;
  lastFilingCheck=Date.now();
  const etInfo=getETInfo();
  const cutoff=Date.now()-15*60*1000;
  for(const g of topGappers.slice(0,20)){
    try{
      const r=await polyGet(`/vX/reference/filings?ticker=${g.ticker}&limit=5&order=desc&sort=filed_at`);
      const filings=(r&&r.results)||[];
      for(const f of filings){
        const filed=new Date(f.filed_at||f.period_of_report_date||0).getTime();
        const id=(f.filing_url||f.accession_number||'').slice(0,80);
        if(filed<=cutoff||state.sentFilings.has(id))continue;
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

async function checkMorningSnapshot(){
  const etInfo=getETInfo();
  if((etInfo.h!==6&&etInfo.h!==7)||etInfo.m!==0)return;
  const key=`${new Date().toISOString().slice(0,10)}_${etInfo.h}`;
  if(state.morningPosted.has(key))return;
  state.morningPosted.add(key);
  if(!topGappers.length)return;
  let adv='--',dec='--',unch='--';
  try{const snap=await polyGet('/v2/snapshot/locale/us/markets/stocks/gainers?include_otc=true');const tks=(snap&&snap.tickers)||[];const a=tks.filter(t=>(t.todaysChangePerc||0)>0.1).length;const d=tks.filter(t=>(t.todaysChangePerc||0)<-0.1).length;adv=a;dec=d;unch=tks.length-a-d;}catch(e){}
  let rows='';
  topGappers.forEach(g=>{const dot=g.chgPct>=200?'🔴':g.chgPct>=100?'🟠':g.chgPct>=50?'🟡':'🟢';rows+=`${dot} **${g.ticker}** \`${priceFlag(g.price)}\` \`+${g.chgPct.toFixed(1)}%\` | $${g.price.toFixed(2)} | Vol: ${fmtN(g.volume)} | RVol: ${fmtRVol(g.rvol)}\n`;});
  await post(WH.TOP_GAPPERS,{content:`# ${etInfo.h===6?'🌅 6AM':'☀️ 7AM'} Pre-Market Scan`,embeds:[{title:`📊 Top ${topGappers.length} Gappers ($0.10–$20)`,description:rows||'No data',color:0x00d4ff,fields:[{name:'Market Breadth',value:`🟢 ADV: ${adv}  🔴 DEC: ${dec}  ⚪ UNCH: ${unch}`,inline:false}],footer:{text:`AziziBot · ${etInfo.timeStr} ET · Polygon.io`},timestamp:new Date().toISOString()}]});
  console.log(`[${etInfo.timeStr}] Morning snapshot posted`);
}

// News constants — used by both REST polling and any future WS upgrade
const DROP_RE=/offering|public offering|convertible|shelf registration|ATM offering|at-the-market|direct offering|registered direct|dilut|warrant|prospectus|424B|S-1|S-3|secondary offering|note offering|senior notes|subordinated notes|debenture|equity financ/i;
const SPIKE_RE=/collaboration|agreement|partnership|FDA|approval|cleared|grant|award|contract|trial|data|results|positive|breakthrough|milestone|license|acqui|merger|acquisition|joint venture|phase|cohort|study|efficacy|safety/i;

// Poll Polygon REST news every 30s — fallback since news WS requires Business plan
let lastNewsPoll=0;
async function pollNews(){
  if(!isActive())return;
  if(Date.now()-lastNewsPoll<30*1000)return;
  lastNewsPoll=Date.now();
  try{
    const r=await polyGet('/v2/reference/news?limit=50&order=desc&sort=published_utc');
    const items=(r&&r.results)||[];
    const cutoff=Date.now()-3*60*1000; // only process news from last 3 min
    for(const n of items){
      if(!n.published_utc||new Date(n.published_utc).getTime()<cutoff)continue;
      await handleNewsEvent({
        title:n.title,
        tickers:n.tickers||[],
        article_url:n.article_url||'',
        published_utc:n.published_utc
      });
    }
  }catch(e){console.error('pollNews:',e.message);}
}

async function handleNewsEvent(n){
  if(!isActive())return;
  const etInfo=getETInfo();
  const title=n.title||n.headline||'';
  if(!title)return;
  const tickers=(n.tickers||[n.sym||n.ticker||'']).filter(Boolean).map(t=>t.toUpperCase());
  if(!tickers.length)return;
  const url=n.article_url||n.url||'';
  const id=(url||title).slice(0,100);
  if(state.sentNews.has(id))return;
  state.sentNews.add(id);
  for(const t of tickers){if(url)state.recentNewsCache.set(t,{url,ts:Date.now()});}
  const isDrop=DROP_RE.test(title);
  const isSpike=!isDrop&&SPIKE_RE.test(title);
  if(!isDrop&&!isSpike)return;
  for(const ticker of tickers.slice(0,3)){
    if(isEtf(ticker))continue;
    if(isDrop){
      const dropId=`prdrop_${id}_${ticker}`;
      if(state.sentPRDrop.has(dropId))continue;
      state.sentPRDrop.add(dropId);
      const[snap,details]=await Promise.all([polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),getTickerDetails(ticker)]);
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
      const[snap,details]=await Promise.all([polyGet(`/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}`),getTickerDetails(ticker)]);
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
  if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(x=>state.sentNews.add(x));}
  if(state.sentPRDrop.size>500){const a=[...state.sentPRDrop];state.sentPRDrop.clear();a.slice(-200).forEach(x=>state.sentPRDrop.add(x));}
  if(state.sentPRSpike.size>500){const a=[...state.sentPRSpike];state.sentPRSpike.clear();a.slice(-200).forEach(x=>state.sentPRSpike.add(x));}
}

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
          const ts=msg.ev==='T'?(msg.t||Date.now()):(msg.e||Date.now());
          if(!price)continue;
          state.lastTrade.set(ticker,ts);
          if(!state.priceHistory.has(ticker))state.priceHistory.set(ticker,[]);
          const hist=state.priceHistory.get(ticker);
          hist.push({price,time:Date.now()});
          if(hist.length>60)hist.shift();
          const s=state.tickers.get(ticker);
          if(s&&price>s.high+0.001)fireNHOD(ticker,price).catch(()=>{});
        }
      }
    }catch(e){}
  });
  ws.on('error',err=>console.error('Price WS error:',err.message));
  ws.on('close',()=>{console.log('Price WS closed, reconnecting in 5s...');setTimeout(connectPriceWS,5000);});
}


function subscribeNewTickers(newTickers){
  if(!ws||ws.readyState!==WebSocket.OPEN||!newTickers.length)return;
  ws.send(JSON.stringify({action:'subscribe',params:newTickers.map(t=>`T.${t},A.${t}`).join(',')}));
  newTickers.forEach(t=>subscribedTickers.add(t));
  console.log(`[Price WS] New tickers: ${newTickers.join(', ')}`);
}

function resubscribeWS(){
  if(ws&&ws.readyState===WebSocket.OPEN&&topGappers.length){
    const subs=topGappers.map(g=>`T.${g.ticker},A.${g.ticker}`).join(',');
    ws.send(JSON.stringify({action:'subscribe',params:subs}));
    topGappers.forEach(g=>subscribedTickers.add(g.ticker));
  }
}

async function main(){
  console.log('🤖 AziziBot v4 starting — Polygon-only...');
  await refreshEtfList();
  await refreshTopGappers();
  connectPriceWS();

  setInterval(async()=>{
    const before=new Set(topGappers.map(g=>g.ticker));
    await refreshEtfList();
    await refreshTopGappers();
    const newlyDiscovered=topGappers.filter(g=>!before.has(g.ticker));
    const unsubbed=newlyDiscovered.map(g=>g.ticker).filter(t=>!subscribedTickers.has(t));
    if(unsubbed.length)subscribeNewTickers(unsubbed);
    await pollNews();
    for(const g of newlyDiscovered){
      const s=state.tickers.get(g.ticker);
      if(s&&g.price>=s.high*0.999)fireNHOD(g.ticker,g.price).catch(()=>{});
    }
  },20*1000);

  setInterval(async()=>{
    await checkMorningSnapshot();
    await checkHalts();
    await pollNews();
    await checkGreenBars();
    await checkSECFilings();
  },60*1000);

  console.log('🤖 AziziBot v4 running. Price + News WebSockets active.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
