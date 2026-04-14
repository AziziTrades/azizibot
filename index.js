// AziziBot v3 — Real-time Discord alerts matching NuntioBot
// Railway.app — Node.js 18+

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
    const req=https.get(url,{headers:{'User-Agent':'AziziBot/1.0 contact@azizibot.com'}},res=>{
      let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));
    });
    req.on('error',reject);
    req.setTimeout(8000,()=>{req.destroy();reject(new Error('timeout'));});
  });
}
async function jsonGet(url){try{return JSON.parse(await rawGet(url));}catch(e){return null;}}
function polyGet(path){const sep=path.includes('?')?'&':'?';return jsonGet(`https://api.polygon.io${path}${sep}apiKey=${POLY_KEY}`);}
function fmpGet(path){const sep=path.includes('?')?'&':'?';return jsonGet(`https://financialmodelingprep.com${path}${sep}apikey=${FMP_KEY}`);}

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

async function getFinvizData(ticker){
  const r={si:'--',regSho:false,ctb:''};
  try{
    const html=await new Promise((resolve,reject)=>{
      const req=https.get(`https://elite.finviz.com/quote.ashx?t=${ticker}&auth=${FINVIZ_KEY}`,
        {headers:{'User-Agent':'Mozilla/5.0','Cookie':`finvizAuth=${FINVIZ_KEY}`,'Referer':'https://elite.finviz.com/'}},
        res=>{let d='';res.on('data',c=>d+=c);res.on('end',()=>resolve(d));});
      req.on('error',reject);req.setTimeout(3000,()=>{req.destroy();reject(new Error('timeout'));});
    });
    const siM=html.match(/Short Float[^>]*>([\d.]+%)/i);if(siM)r.si=siM[1];
    r.regSho=/Reg SHO.*?Yes/i.test(html);
    const ctbM=html.match(/CTB[^>]*>([^<]{1,15})<\/td>/i);
    if(ctbM){const v=ctbM[1].trim();r.ctb=/high/i.test(v)?'High CTB':/low/i.test(v)?'Low CTB':'';}
  }catch(e){}
  return r;
}
async function getProfile(ticker){try{const p=await fmpGet(`/stable/profile?symbol=${ticker}`);return(Array.isArray(p)?p[0]:p)||{};}catch(e){return{};}}
async function getLatestNewsUrl(ticker){try{const n=await fmpGet(`/stable/news/stock?symbols=${ticker}&limit=1`);if(Array.isArray(n)&&n.length&&n[0].url)return n[0].url;}catch(e){}return null;}
async function getRecentSplit(ticker){
  try{
    const splits=await fmpGet(`/stable/splits?symbol=${ticker}`);
    if(Array.isArray(splits)&&splits.length){
      const s=splits.find(s=>{const d=(Date.now()-new Date(s.date).getTime())/86400000;return d<=90&&s.denominator>s.numerator;});
      if(s){const d=new Date(s.date);return `${s.numerator} for ${s.denominator} R/S ${d.toLocaleString('en-US',{month:'short'})}. ${d.getDate()}`;}
    }
  }catch(e){}
  return null;
}

const state={
  tickers:new Map(),sentNews:new Set(),sentHalts:new Set(),sentResumes:new Set(),
  sentFilings:new Set(),sentPRSpike:new Set(),sentGreenBar:new Map(),
  morningPosted:new Set(),lastTrade:new Map(),priceHistory:new Map(),
  nhodCooldown:new Map()
};
let topGappers=[];
let lastFilingCheck=0;
let lastHaltCheck=0;

// ETF filter — loaded once at startup, refreshed every 6 hours
let etfSet=new Set();
let lastEtfRefresh=0;
async function refreshEtfList(){
  if(Date.now()-lastEtfRefresh<6*60*60*1000)return;
  try{
    const list=await fmpGet('/stable/etf/list');
    if(Array.isArray(list)&&list.length){
      etfSet=new Set(list.map(e=>e.symbol||e.ticker||'').filter(Boolean));
      lastEtfRefresh=Date.now();
      console.log(`[ETF] Loaded ${etfSet.size} ETF tickers`);
    }
  }catch(e){console.error('refreshEtfList:',e.message);}
}
function isEtf(ticker){
  // Primary: FMP list lookup
  if(etfSet.has(ticker))return true;
  // Fallback: common ETF ticker patterns (3-4 letters ending in common suffixes)
  if(/^(SPY|QQQ|IWM|DIA|GLD|SLV|TLT|HYG|LQD|EEM|VXX|UVXY|SQQQ|TQQQ|SPXU|SPXL|LABD|LABU|NUGT|DUST|JNUG|JDST|NAIL|FAS|FAZ|TNA|TZA|UPRO|SDOW|UDOW|SOXL|SOXS|TECL|TECS|DFEN|WEBL|WEBS|FNGU|FNGG|HIBL|HIBS|DPST|DRN|DRV|MIDU|MIDZ|SMLL|BNKU|BNKD|CURE|SICK|WANT|OILU|OILD|GUSH|DRIP|ERX|ERY|KOLD|UGAZ|DGAZ|BOIL|KORU|YINN|YANG|EDC|EDZ|EET|EEV|EWJ|EWZ|XLF|XLE|XLK|XLV|XLI|XLP|XLU|XLB|XLY|XLRE|VTI|VOO|VEA|VWO|BND|AGG|EMB|BNDX|IEMG|ITOT|IEFA|IJR|IJH|IVV|GDX|GDXJ|SIL|SILJ|REMX|LIT|ARKK|ARKG|ARKW|ARKF|ARKX|PRNT|IZRL)$/.test(ticker))return true;
  return false;
}

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
      return{ticker:t.ticker,price:lp,prev,chgPct:chg,volume:vol,prevVol:pv2,rvol:pv2>0?vol/pv2:0,high:(t.day&&t.day.h)||lp};
    };
    const merge=new Map();
    for(const src of[pg,pc,pv])for(const t of((src&&src.tickers)||[]))if(!merge.has(t.ticker))merge.set(t.ticker,build(t));
    topGappers=[...merge.values()].filter(t=>t.chgPct>=5&&t.price>=0.1&&t.price<=20&&!isEtf(t.ticker)).sort((a,b)=>b.chgPct-a.chgPct).slice(0,50);
    for(const g of topGappers){const ex=state.tickers.get(g.ticker)||{high:0,nhod:0};state.tickers.set(g.ticker,{...ex,...g,high:Math.max(g.high,ex.high)});}
    console.log(`[${getETInfo().timeStr}] ${topGappers.length} gappers`);
  }catch(e){console.error('refreshTopGappers:',e.message);}
}

async function fireNHOD(ticker,price){
  if(!isActive())return;
  const etInfo=getETInfo();
  const gapper=topGappers.find(g=>g.ticker===ticker);if(!gapper)return;
  const s=state.tickers.get(ticker);if(!s||price<=s.high+0.001)return;
  const nhod=(s.nhod||0)+1;
  state.tickers.set(ticker,{...s,high:price,nhod});

  // FIX: 5-minute cooldown per ticker (was 10 minutes)
  const last=state.nhodCooldown.get(ticker)||0;
  if(Date.now()-last<5*60*1000)return;
  state.nhodCooldown.set(ticker,Date.now());

  console.log(`[${etInfo.timeStr}] NHOD ${ticker} $${price.toFixed(2)} x${nhod}`);
  const[fv,newsUrl,rs,prof]=await Promise.all([getFinvizData(ticker),getLatestNewsUrl(ticker),getRecentSplit(ticker),getProfile(ticker)]);
  const io=prof.institutionalOwnershipPercentage||prof.institutionalOwnership||0;
  const mc=prof.mktCap||prof.marketCap||0;
  const ioStr=io>0?` | IO: ${(io<1?io*100:io).toFixed(2)}%`:'';
  const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
  let afterLull='';
  const hist=state.priceHistory.get(ticker)||[];
  if(hist.length>=10){
    const old=hist.filter(h=>h.time<Date.now()-10*60*1000);
    if(old.length>=3){const oH=Math.max(...old.map(h=>h.price)),oL=Math.min(...old.map(h=>h.price));if((oH-oL)/oL<0.02&&price>oH*1.03)afterLull=' · `after-lull`';}
  }
  let prInline='';
  try{
    const news=await fmpGet(`/stable/news/stock?symbols=${ticker}&limit=3`);
    if(Array.isArray(news)){const fresh=news.find(n=>n.publishedDate&&(Date.now()-new Date(n.publishedDate).getTime())/60000<60&&n.url);
      if(fresh){prInline=` | [PR+](<${fresh.url}>)`;state.sentNews.add((fresh.url||fresh.title||'').slice(0,100));}}
  }catch(e){}
  const tLink=newsUrl?`[${ticker}](<${newsUrl}>)`:`**${ticker}**`;
  const sess=etInfo.sess;
  const label=nhod===1?(sess==='AFTER-HOURS'?'AHs':sess==='PRE-MARKET'?'PMH':'NSH'):`${nhod} NHOD`;
  const flag=countryFlag(ticker);
  const regSho=fv.regSho?' | **Reg SHO**':'';
  const si=fv.si!=='--'?` | SI: ${fv.si}`:'';
  const ctb=fv.ctb?` | ${fv.ctb}`:'';
  const rsStr=rs?` | ${rs}`:'';
  const line=`\`${etInfo.timeStr}\` ↑ ${tLink} \`${priceFlag(price)}\` \`+${gapper.chgPct.toFixed(1)}%\` · ${label}${afterLull} ~ ${flag}${ioStr}${mcStr} | RVol: ${fmtRVol(gapper.rvol)} | Vol: ${fmtN(gapper.volume)}${regSho}${si}${ctb}${rsStr}${prInline}`;
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
        const ltMs=(td.lastTrade&&td.lastTrade.t)||0;const lqMs=(td.lastQuote&&td.lastQuote.t)||0;
        if(!ltMs||!lqMs)continue;
        const now=Date.now();
        if((now-ltMs)/1000<120||(now-lqMs)/1000<120)continue;
        state.sentHalts.add(id);
        const minAgo=Math.floor((now-ltMs)/60000);
        const newsUrl=await getLatestNewsUrl(g.ticker);
        const tLink=newsUrl?`[${g.ticker}](<${newsUrl}>)`:`**${g.ticker}**`;
        const line=`\`${etInfo.timeStr}\` **${g.ticker}** | **Halted** | Trading Pause → $${g.price.toFixed(2)} ~ ${fmtN(g.volume)} vol | ~${minAgo}m ago`;
        await post(WH.MAIN_CHAT,{content:line});await sleep(300);
        await post(WH.HALT_ALERTS,{content:line});
        console.log(`[${etInfo.timeStr}] HALT(snap): ${g.ticker}`);
      }catch(e2){}
    }
  }
}

async function checkPRSpike(){
  if(!isActive()||!topGappers.length)return;
  const etInfo=getETInfo();
  const tickers=topGappers.map(g=>g.ticker).join(',');
  try{
    const news=await fmpGet(`/stable/news/stock?symbols=${tickers}&limit=50`);
    if(!Array.isArray(news))return;
    const cutoff=Date.now()-10*60*1000;
    for(const n of news){
      if(!n.publishedDate||new Date(n.publishedDate).getTime()<cutoff)continue;
      const ticker=n.symbol||n.symbols||'';if(!ticker)continue;
      const id=`prspike_${(n.url||n.title||'').slice(0,80)}`;
      if(state.sentPRSpike.has(id))continue;
      const gapper=topGappers.find(g=>g.ticker===ticker);
      if(!gapper||gapper.chgPct<10)continue;
      state.sentPRSpike.add(id);
      const prof=await getProfile(ticker);
      const io=prof.institutionalOwnershipPercentage||prof.institutionalOwnership||0;
      const mc=prof.mktCap||prof.marketCap||0;
      const ioStr=io>0?` | IO: ${(io<1?io*100:io).toFixed(2)}%`:'';
      const mcStr=mc>0?` | MC: ${fmtN(mc)}`:'';
      const title=(n.title||'').slice(0,200);
      const link=n.url?` - [Link](<${n.url}>)`:'';
      const flag=countryFlag(ticker);
      const line=`**${ticker}** \`${priceFlag(gapper.price)}\` - ${title}${link} ~ ${flag}${ioStr}${mcStr}`;
      await post(WH.PRESS_RELEASES,{content:line});await sleep(300);
      await post(WH.MAIN_CHAT,{content:`\`${etInfo.timeStr}\` 📰 ${line}`});await sleep(300);
      console.log(`[${etInfo.timeStr}] PR-SPIKE: ${ticker}`);
    }
  }catch(e){console.error('checkPRSpike:',e.message);}
}

async function checkBreakingNews(){
  if(!isActive()||!topGappers.length)return;
  const etInfo=getETInfo();
  const tickers=topGappers.map(g=>g.ticker).join(',');
  try{
    const news=await fmpGet(`/stable/news/stock?symbols=${tickers}&limit=50`);
    if(!Array.isArray(news))return;
    const cutoff=Date.now()-5*60*1000;
    for(const n of news.slice(0,10)){
      if(!n.publishedDate)continue;
      const id=(n.url||n.title||'').slice(0,100);
      if(new Date(n.publishedDate).getTime()<cutoff||state.sentNews.has(id))continue;
      state.sentNews.add(id);
      const ageSec=Math.floor((Date.now()-new Date(n.publishedDate).getTime())/1000);
      const ageStr=ageSec<60?`${ageSec} seconds ago`:`${Math.floor(ageSec/60)} min ago`;
      const ticker=n.symbol||n.symbols||'';
      const title=(n.title||'').slice(0,200);
      const link=n.url||'';
      const isOff=/offering|shelf|ATM|dilut|direct offering|registered direct/i.test(title);
      const color=isOff?0xf0a500:(n.sentiment||'').toLowerCase()==='positive'?0x39d353:(n.sentiment||'').toLowerCase()==='negative'?0xf85149:0x5865f2;
      const gapper=topGappers.find(g=>g.ticker===ticker);
      await post(WH.PRESS_RELEASES,{embeds:[{title:`${ticker} — ${ageStr}`,description:`${title}\n${link?`[Link](<${link}>)`:''}`,color,timestamp:new Date(n.publishedDate).toISOString()}]});
      await sleep(300);
      const px=gapper?` \`${priceFlag(gapper.price)}\` \`+${gapper.chgPct.toFixed(1)}%\``:' ';
      const si2=(n.sentiment||'').toLowerCase()==='positive'?'📈':(n.sentiment||'').toLowerCase()==='negative'?'📉':'📰';
      await post(WH.MAIN_CHAT,{content:`\`${etInfo.timeStr}\` ${si2}${isOff?' ⚠️':''} **${ticker}**${px}${ageStr} — ${title.slice(0,90)}${link?` | [PR →](<${link}>)`:''}`});
      await sleep(300);
    }
    if(state.sentNews.size>500){const a=[...state.sentNews];state.sentNews.clear();a.slice(-200).forEach(id=>state.sentNews.add(id));}
  }catch(e){console.error('checkBreakingNews:',e.message);}
}

async function checkGreenBars(){
  if(!isActive()||!topGappers.length)return;
  const etInfo=getETInfo();
  for(const g of topGappers.slice(0,20)){
    try{
      const last=state.sentGreenBar.get(g.ticker)||0;
      if(Date.now()-last<15*60*1000)continue;
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
      const filings=await fmpGet(`/stable/sec-filings?symbol=${g.ticker}&limit=5`);
      if(!Array.isArray(filings))continue;
      for(const f of filings){
        const filed=new Date(f.date||f.filledDate||f.acceptedDate||0).getTime();
        const id=(f.link||f.url||f.title||'').slice(0,80);
        if(filed<=cutoff||state.sentFilings.has(id))continue;
        state.sentFilings.add(id);
        const ft=(f.formType||f.type||'SEC').toUpperCase();
        const lnk=f.link||f.url||'';
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

let ws=null;
function connectWebSocket(){
  if(ws){try{ws.terminate();}catch(e){}}
  console.log('Connecting to Polygon WebSocket...');
  ws=new WebSocket('wss://socket.polygon.io/stocks');
  ws.on('open',()=>ws.send(JSON.stringify({action:'auth',params:POLY_KEY})));
  ws.on('message',data=>{
    try{
      for(const msg of JSON.parse(data.toString())){
        if(msg.ev==='status'&&msg.status==='auth_success'){
          const subs=topGappers.map(g=>`T.${g.ticker},A.${g.ticker}`).join(',');
          if(subs)ws.send(JSON.stringify({action:'subscribe',params:subs}));
          console.log(`WebSocket subscribed to ${topGappers.length} tickers`);
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
  ws.on('error',err=>console.error('WS error:',err.message));
  ws.on('close',()=>{console.log('WS closed, reconnecting in 5s...');setTimeout(connectWebSocket,5000);});
}
function resubscribeWS(){
  if(ws&&ws.readyState===WebSocket.OPEN&&topGappers.length){
    const subs=topGappers.map(g=>`T.${g.ticker},A.${g.ticker}`).join(',');
    ws.send(JSON.stringify({action:'subscribe',params:subs}));
  }
}

async function main(){
  console.log('🤖 AziziBot v3 starting...');
  await refreshEtfList();
  await refreshTopGappers();
  connectWebSocket();
  setInterval(async()=>{await refreshEtfList();await refreshTopGappers();resubscribeWS();},60*1000);
  setInterval(async()=>{
    await checkMorningSnapshot();
    await checkHalts();
    await checkPRSpike();
    await checkBreakingNews();
    await checkGreenBars();
    await checkSECFilings();
  },60*1000);
  console.log('🤖 AziziBot v3 running. Real-time alerts active.');
}

main().catch(err=>{console.error('Fatal:',err);process.exit(1);});
