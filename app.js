/* 個人投資紀錄 v1.1
   localStorage：
   - mystock.pwHash       : 密碼 SHA-256
   - mystock.prices       : { code: priceNumber }
   - mystock.priceMeta    : { updatedAt: 'YYYY-MM-DD HH:mm', source: 'twse|manual' }
   - mystock.fee          : { feeRate, feeMin, taxStock, taxEtf }
   - mystock.fc           : { code: { perShare, freq, startMonth, enabled } }
   - mystock.userRecords  : [{ ...record, _id: 'user-xxx' }]
   - mystock.overrides    : { _id: { sell_date, sell_price, ...其他可覆寫欄位 } }
*/

// ---------- 工具 ----------
const fmt = n => (n==null||isNaN(n))?'-':Number(n).toLocaleString('zh-TW',{maximumFractionDigits:0});
const fmt2 = n => (n==null||isNaN(n))?'-':Number(n).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2});
const pct = n => (n==null||isNaN(n))?'-':(n*100).toLocaleString('zh-TW',{minimumFractionDigits:2,maximumFractionDigits:2})+'%';
const cls = n => n>0?'green':(n<0?'red':'sub');
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
async function sha256(str){
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
const todayISO = () => new Date().toISOString().slice(0,10);

// 把股數格式化成「N張+M股」（台股 1張 = 1000股）
function fmtLots(units){
  if (!units || units <= 0) return '0股';
  const u = Math.round(units * 100) / 100;
  const lots = Math.floor(u / 1000);
  const oddRaw = u - lots * 1000;
  const odd = Math.round(oddRaw * 100) / 100;
  const oddStr = Number.isInteger(odd) ? String(odd) : odd.toFixed(2).replace(/\.?0+$/, '');
  if (lots === 0) return `${oddStr}股`;
  if (odd === 0) return `${lots}張`;
  return `${lots}張+${oddStr}股`;
}
// 拆兩部分用於對齊：lots = '85張'，odd = '+472股' 或 ''
function fmtLotsParts(units){
  if (!units || units <= 0) return { lots:'0股', odd:'' };
  const u = Math.round(units * 100) / 100;
  const lots = Math.floor(u / 1000);
  const oddRaw = u - lots * 1000;
  const odd = Math.round(oddRaw * 100) / 100;
  const oddStr = Number.isInteger(odd) ? String(odd) : odd.toFixed(2).replace(/\.?0+$/, '');
  if (lots === 0) return { lots: `${oddStr}股`, odd:'' };
  return { lots: `${lots}張`, odd: odd > 0 ? `+${oddStr}股` : '' };
}

// ---------- 全域 state ----------
const STATE = {
  data: window.STOCK_DATA,
  who: 'all',
  prices: {},
  priceMeta: { updatedAt: '', source: '' },
  fee: { feeRate:0.001425, feeMin:20, taxStock:0.003, taxEtf:0.001 },
  forecast: {},
  userRecords: [],
  overrides: {},
  lastFetchProxy: '',
  sheetsUrl: '',  // Google Apps Script Web App URL
};
const DEFAULT_PASSWORD = 'mystock2026';

// ---------- 初始化 records 加 _id ----------
(function initIds(){
  STATE.data.records.forEach((r, i) => { r._id = `xls-${i}`; });
})();

// ---------- 載入設定 ----------
function loadLocal(){
  try { STATE.prices = JSON.parse(localStorage.getItem('mystock.prices')||'null') || {...STATE.data.latest_prices}; }
  catch(e){ STATE.prices = {...STATE.data.latest_prices}; }
  for (const c of Object.keys(STATE.data.code_to_name)) {
    if (STATE.prices[c]==null) STATE.prices[c] = STATE.data.latest_prices[c] ?? null;
  }
  try { const f = JSON.parse(localStorage.getItem('mystock.fee')||'null'); if(f) Object.assign(STATE.fee, f); } catch(e){}
  try { STATE.forecast = JSON.parse(localStorage.getItem('mystock.fc')||'{}') || {}; } catch(e){ STATE.forecast={}; }
  try { STATE.userRecords = JSON.parse(localStorage.getItem('mystock.userRecords')||'[]') || []; } catch(e){ STATE.userRecords=[]; }
  try { STATE.overrides = JSON.parse(localStorage.getItem('mystock.overrides')||'{}') || {}; } catch(e){ STATE.overrides={}; }
  try { STATE.priceMeta = JSON.parse(localStorage.getItem('mystock.priceMeta')||'null') || {updatedAt:'',source:''}; } catch(e){}
  STATE.lastFetchProxy = localStorage.getItem('mystock.lastFetchProxy') || '';
  STATE.sheetsUrl = localStorage.getItem('mystock.sheetsUrl') || '';
}
function savePrices(meta){ localStorage.setItem('mystock.prices', JSON.stringify(STATE.prices)); if(meta){STATE.priceMeta=meta; localStorage.setItem('mystock.priceMeta', JSON.stringify(meta));} }
function saveFee(){ localStorage.setItem('mystock.fee', JSON.stringify(STATE.fee)); }
function saveForecast(){ localStorage.setItem('mystock.fc', JSON.stringify(STATE.forecast)); }
function saveUserRecords(){ localStorage.setItem('mystock.userRecords', JSON.stringify(STATE.userRecords)); }
function saveOverrides(){ localStorage.setItem('mystock.overrides', JSON.stringify(STATE.overrides)); }

// ---------- 登入 ----------
async function initLogin(){
  if (!localStorage.getItem('mystock.pwHash')){
    localStorage.setItem('mystock.pwHash', await sha256(DEFAULT_PASSWORD));
  }
  $('#pw').focus();
  $('#loginBtn').onclick = tryLogin;
  $('#pw').addEventListener('keydown', e => { if(e.key==='Enter') tryLogin(); });
}
async function tryLogin(){
  const pw = $('#pw').value;
  if(!pw) return;
  const h = await sha256(pw);
  if (h === localStorage.getItem('mystock.pwHash')){
    sessionStorage.setItem('mystock.unlocked','1');
    showApp();
  } else {
    $('#loginErr').textContent = '密碼錯誤';
    $('#pw').value=''; $('#pw').focus();
  }
}
function showApp(){
  $('#login').style.display='none';
  $('#app').style.display='block';
  initApp();
}
function logout(){
  sessionStorage.removeItem('mystock.unlocked');
  location.reload();
}


// 從 Google Apps Script Web App 載入資料（取代 data.js）
async function loadFromSheets(){
  const url = STATE.sheetsUrl;
  if (!url) return false;
  try {
    const r = await fetch(url + '?_=' + Date.now(), {cache:'no-store'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    const json = await r.json();
    if (json.error) throw new Error(json.error);
    // 保留原有的 latest_prices fallback
    json.latest_prices = STATE.data.latest_prices || {};
    STATE.data = json;
    STATE.data.records.forEach((r,i) => { r._id = `xls-${i}`; });
    return true;
  } catch(e){
    console.warn('Sheets 載入失敗，使用 data.js:', e);
    return false;
  }
}

// ---------- 計算 ----------
function isETF(code){ return STATE.data.etf_codes.includes(code); }
function feeOf(amount){
  return Math.max(Math.round(amount * STATE.fee.feeRate), STATE.fee.feeMin);
}
function taxOf(code, amount){
  const r = isETF(code) ? STATE.fee.taxEtf : STATE.fee.taxStock;
  return Math.round(amount * r);
}

// 合併 Excel records + 使用者新增 + 覆寫
function getMergedRecords(){
  const merged = [];
  for (const r of STATE.data.records){
    const ov = STATE.overrides[r._id];
    merged.push(ov ? {...r, ...ov} : r);
  }
  for (const r of STATE.userRecords){
    const ov = STATE.overrides[r._id];
    merged.push(ov ? {...r, ...ov} : r);
  }
  return merged;
}

function buildLots(){
  const records = getMergedRecords();
  const lots = [], dividends = [], stockDivs = [];
  for (const r of records){
    const include = STATE.who==='all' || r.who === STATE.who || (r.who==='配息' && STATE.who==='我') || (r.who==='配股' && STATE.who==='我');
    if(!include) continue;
    if (r.who==='我' || r.who==='Max') lots.push({...r});
    else if (r.who==='配息') dividends.push({...r});
    else if (r.who==='配股') stockDivs.push({...r});
  }
  lots.sort((a,b)=>(a.buy_date||'').localeCompare(b.buy_date||''));
  dividends.sort((a,b)=>(a.buy_date||'').localeCompare(b.buy_date||''));
  stockDivs.sort((a,b)=>(a.buy_date||'').localeCompare(b.buy_date||''));
  return { lots, dividends, stockDivs };
}

function enrichLot(lot){
  const code = lot.code;
  const buyAmt = (lot.buy_price||0) * (lot.units||0);
  const buyFee = feeOf(buyAmt);
  const buyCost = buyAmt + buyFee;
  let result = { ...lot, buyAmt, buyFee, buyCost };
  if (lot.sell_date){
    const sellAmt = (lot.sell_price||0) * (lot.units||0);
    const sellFee = feeOf(sellAmt);
    const sellTax = taxOf(code, sellAmt);
    const sellNet = sellAmt - sellFee - sellTax;
    const profit = sellNet - buyCost;
    const ret = buyCost>0 ? profit/buyCost : 0;
    const days = daysBetween(lot.buy_date, lot.sell_date);
    const annual = days>0 ? Math.pow(1+ret, 365/days)-1 : 0;
    result.status='realized';
    Object.assign(result, {sellAmt, sellFee, sellTax, sellNet, profit, ret, days, annual});
  } else {
    const cur = STATE.prices[code];
    if (cur==null){ result.status='held'; return result; }
    const curVal = cur * (lot.units||0);
    // 未實現損益：市值 − (成交價 × 股數)，與 Excel 對齊不含買進手續費
    const profit = curVal - buyAmt;
    const ret = buyAmt>0 ? profit/buyAmt : 0;
    const days = daysBetween(lot.buy_date, todayISO());
    const annual = days>0 ? Math.pow(1+ret, 365/days)-1 : 0;
    result.status='held';
    Object.assign(result, {curPrice:cur, curVal, profit, ret, days, annual});
  }
  return result;
}

function daysBetween(a, b){ if(!a||!b) return 0; return Math.round((Date.parse(b)-Date.parse(a))/86400000); }

// 回放交易紀錄：算出除息日「前一日」收盤時持有的股數（即可參加除息的張數）
// 規則：必須在 exDate 之前就持有，且 exDate 當日未賣出。
function holdingsAtDate(code, exDate){
  if (!exDate) return 0;
  let units = 0;
  for (const r of getMergedRecords()){
    if (r.code !== code) continue;
    if (r.who === '我' || r.who === 'Max'){
      if (!r.buy_date || r.buy_date >= exDate) continue;
      if (r.sell_date && r.sell_date < exDate) continue;
      units += (r.units || 0);
    } else if (r.who === '配股'){
      if (r.buy_date && r.buy_date < exDate) units += (r.units || 0);
    }
  }
  return units;
}

// 目前實際持有股票（不論 who 過濾），用於股價更新只列現持股
function heldCodes(){
  const tot = {};
  for (const r of getMergedRecords()){
    if (r.who === '我' || r.who === 'Max'){
      if (!r.sell_date && r.units) tot[r.code] = (tot[r.code]||0) + r.units;
    } else if (r.who === '配股'){
      if (r.units) tot[r.code] = (tot[r.code]||0) + r.units;
    }
  }
  return Object.keys(tot).filter(c => (tot[c]||0) > 0).sort();
}

// 取某股票最近 N 筆買進紀錄（依 buy_date 降冪）
function recentBuysForCode(code, n){
  if (!code) return [];
  const all = getMergedRecords()
    .filter(r => r.code === code && (r.who === '我' || r.who === 'Max'))
    .sort((a,b) => (b.buy_date||'').localeCompare(a.buy_date||''));
  return all.slice(0, n||10);
}

function renderBuyReference(){
  const root = $('#buyRef');
  if (!root) return;
  const code = $('#buyStock').value;
  if (!code){ root.innerHTML = ''; return; }
  const recent = recentBuysForCode(code, 10);
  const cur = STATE.prices[code];
  const myPrice = parseFloat($('#buyPrice').value) || 0;
  const map = buildHoldings();
  const avgHold = map[code]?.avg;
  if (recent.length === 0){
    root.innerHTML = `<div class="small sub">尚無買進紀錄${cur?`，目前現價 ${fmt2(cur)}`:''}</div>`;
    return;
  }
  const prices = recent.map(r => r.buy_price).filter(p => p > 0);
  const avg = prices.reduce((a,b)=>a+b, 0) / Math.max(prices.length,1);
  const max = Math.max(...prices), min = Math.min(...prices);
  const lastPrice = recent[0].buy_price;
  const diffFromCur = (cur && cur>0) ? ((myPrice||lastPrice) - cur) / cur * 100 : null;
  const diffFromAvg = avg>0 ? ((myPrice||lastPrice) - avg) / avg * 100 : null;
  const tone = (d) => d==null ? '' : (d > 1 ? 'red' : (d < -1 ? 'green' : 'sub'));
  let html = `<div class="small" style="margin-bottom:6px"><b>近 ${recent.length} 筆買進</b>　均價 <b>${fmt2(avg)}</b>　高 ${fmt2(max)}　低 ${fmt2(min)}${avgHold!=null?`　持有均價 ${fmt2(avgHold)}`:''}</div>`;
  html += `<div class="small" style="margin-bottom:6px">目前現價 <b style="color:var(--accent-2)">${cur?fmt2(cur):'-'}</b>${myPrice>0?`　你打算買 <b>${fmt2(myPrice)}</b>`:''}`;
  if (myPrice>0){
    if (diffFromCur!=null) html += `　vs. 現價 <span class="${tone(diffFromCur)}">${diffFromCur>0?'+':''}${diffFromCur.toFixed(2)}%</span>`;
    if (diffFromAvg!=null) html += `　vs. 近期均價 <span class="${tone(diffFromAvg)}">${diffFromAvg>0?'+':''}${diffFromAvg.toFixed(2)}%</span>`;
  }
  html += `</div>`;
  html += '<table style="font-size:12px;width:100%"><thead><tr><th>日期</th><th class="num">買價</th><th class="num">vs 均</th><th class="num">股數</th><th>帳戶</th></tr></thead><tbody>';
  for (const r of recent){
    const d = avg>0 ? ((r.buy_price - avg) / avg * 100) : 0;
    html += `<tr><td>${r.buy_date}</td><td class="num">${fmt2(r.buy_price)}</td><td class="num ${tone(d)}">${d>0?'+':''}${d.toFixed(2)}%</td><td class="num">${fmt(r.units)}</td><td class="sub">${r.who}${r.sell_date?' (已賣)':''}</td></tr>`;
  }
  html += '</tbody></table>';
  root.innerHTML = html;
}

// 取得配息的「除息日」：優先用 ex_date 欄；否則用 入帳日 (buy_date) − 30 天的近似值
function divExDate(d){
  if (d.ex_date) return d.ex_date;
  if (!d.buy_date) return null;
  const ts = Date.parse(d.buy_date) - 30 * 86400000;
  return new Date(ts).toISOString().slice(0,10);
}
function shiftDate(date, days){
  if (!date) return '';
  const ts = Date.parse(date) + days * 86400000;
  return new Date(ts).toISOString().slice(0,10);
}

// 對「未來配息」自動依除息日持股 × 每股配息推估金額；
// 已過除息日的配息或使用者用 ✏️ 鎖定金額（override.dividend）的紀錄則照原值。
function adjustedDividend(d){
  if (d.who !== '配息' || !d.buy_date) return d.dividend;
  if (d.buy_date <= todayISO()) return d.dividend;
  const ov = STATE.overrides[d._id];
  const locked = ov && Object.prototype.hasOwnProperty.call(ov, 'dividend') && ov.dividend != null;
  if (locked) return d.dividend;
  if (d.buy_price != null && d.code){
    const exDate = divExDate(d);
    const u = holdingsAtDate(d.code, exDate);
    if (u > 0) return Math.round(u * d.buy_price);
  }
  return d.dividend;
}

function buildHoldings(){
  const { lots, dividends, stockDivs } = buildLots();
  const map = {};
  const ensure = (code, name) => {
    if(!map[code]) map[code] = { code, name, units:0, cost:0, divReceived:0, divForecast:0, realized:0, buyUnitsTotal:0, buyCostTotal:0, sellLots:0 };
    return map[code];
  };
  for (const lot of lots){
    const e = enrichLot(lot);
    const a = ensure(e.code, e.name);
    // 用「成交價 × 股數」當成本（跟 Excel 一致，不含買進手續費）
    a.buyCostTotal += e.buyAmt;
    a.buyUnitsTotal += e.units||0;
    if (e.status==='realized'){ a.realized += e.profit||0; a.sellLots += 1; }
    else { a.units += e.units||0; a.cost += e.buyAmt; }
  }
  const today = todayISO();
  for (const sd of stockDivs){
    const a = ensure(sd.code, sd.name);
    // 未來配股（除權日未到）不計入「目前持股」，但記錄供顯示
    const sdDate = sd.ex_date || sd.buy_date;
    if (sdDate && sdDate > today){
      a.futureStockDivUnits = (a.futureStockDivUnits||0) + (sd.units||0);
      continue;
    }
    a.units += sd.units||0;
    a.buyUnitsTotal += sd.units||0;
    a.stockDivUnits = (a.stockDivUnits||0) + (sd.units||0);
  }
  for (const d of dividends){
    const a = ensure(d.code, d.name);
    const amt = adjustedDividend(d) || 0;
    if (d.buy_date && d.buy_date <= today) a.divReceived += amt;
    else a.divForecast += amt;
  }
  for (const code of Object.keys(map)){
    const a = map[code];
    a.avg = a.units>0 ? a.cost / a.units : 0;
    a.cur = STATE.prices[code];
    a.market = a.cur!=null ? a.cur * a.units : null;
    a.unreal = a.market!=null ? a.market - a.cost : null;
    a.unrealPct = (a.unreal!=null && a.cost>0) ? a.unreal/a.cost : null;
    a.profitNoDiv = (a.unreal||0) + a.realized;          // 不含配息：純價差
    a.retNoDiv = a.buyCostTotal>0 ? a.profitNoDiv / a.buyCostTotal : null;
    a.totalProfit = a.profitNoDiv + a.divReceived;          // 含配息
    a.totalRet = a.buyCostTotal>0 ? a.totalProfit / a.buyCostTotal : null;
    a.divYield = a.buyCostTotal>0 ? a.divReceived / a.buyCostTotal : null;
  }
  return map;
}

// ---------- Dashboard ----------
function renderDashboard(){
  const map = buildHoldings();
  let cost=0, value=0, unreal=0, real=0, divR=0, divF=0;
  // 為了讓「總報酬率」分母（持股成本）和分子一致，把「持股」與「已賣光」分開累計
  let divR_held=0, divR_sold=0, real_held=0, real_sold=0;
  for (const c of Object.keys(map)){
    const a = map[c];
    cost += a.cost;
    if (a.market!=null) value += a.market;
    if (a.unreal!=null) unreal += a.unreal;
    real += a.realized;
    divR += a.divReceived;
    divF += a.divForecast;
    if (a.units > 0){
      divR_held += a.divReceived;
      real_held += a.realized;          // 持股期間部分賣出的實現損益（仍持有同檔）
    } else {
      divR_sold += a.divReceived;
      real_sold += a.realized;
    }
  }
  $('#kpi-cost').textContent = fmt(cost);
  $('#kpi-value').textContent = fmt(value);
  $('#kpi-unreal').textContent = fmt(unreal);
  $('#kpi-unreal').className='value '+cls(unreal);
  $('#kpi-unreal-sub').textContent = pct(cost>0?unreal/cost:0);
  $('#kpi-unreal-sub').className='delta '+cls(unreal);
  $('#kpi-real').textContent = fmt(real);
  $('#kpi-real').className='value '+cls(real);
  // 已實現損益 sub：說明已賣光部分
  $('#kpi-real-sub').textContent = real_sold !== 0 ? `含已賣光 ${fmt(real_sold)}` : '';
  $('#kpi-div').textContent = fmt(divR);
  $('#kpi-div-sub').textContent = divR_sold !== 0
    ? `預估未領 ${fmt(divF)}　已賣光 ${fmt(divR_sold)}`
    : `預估未領 ${fmt(divF)}`;
  // 總報酬只計入「目前還持有」這些股票的損益：未實現 + 持股期間實現 + 持股的歷史配息
  // 不再加入「已賣光股票」的實現損益和配息（因為分母 cost 不含它們）
  const total = unreal + real_held + divR_held;
  $('#kpi-total').textContent = fmt(total);
  $('#kpi-total').className='value '+cls(total);
  $('#kpi-total-sub').textContent = pct(cost>0?total/cost:0) + '（持股）';
  $('#kpi-total-sub').className='delta '+cls(total);
  $('#kpi-cost-sub').textContent = `共 ${Object.values(map).filter(a=>a.units>0).length} 檔持股`;
  $('#kpi-value-sub').textContent = (value>cost?'+':'') + fmt(value-cost) + ' vs 成本';
  if (STATE.priceMeta && STATE.priceMeta.updatedAt){
    $('#priceMeta').textContent = `📊 報價 ${STATE.priceMeta.updatedAt} (${({'twse-live':'TWSE 即時','twse-yest':'TWSE 昨收','twse':'TWSE','gas-live':'GAS 即時','gas-yest':'GAS 昨收','gas':'GAS','twse-openapi':'TWSE OpenAPI','paste':'剪貼簿','manual':'手動'})[STATE.priceMeta.source] || STATE.priceMeta.source || '手動'})`;
  } else {
    $('#priceMeta').textContent = '📊 報價：使用 Excel 預設值';
  }

  drawHoldingsChart(map);
  drawMonthlyChart('chartMonthly');
}

function drawHoldingsChart(map){
  const items = Object.values(map).filter(a=>a.market>0).sort((a,b)=>b.market-a.market);
  const ctx = $('#chartHoldings');
  if (window._holdingsChart) window._holdingsChart.destroy();
  const total = items.reduce((s,a)=>s+a.market,0);
  const colors = ['#4f8cff','#3ddc84','#ffc857','#ff6b6b','#a07cff','#ff8c4f','#7fc1ff','#3dc8c8','#dc8c3d','#9adc3d','#dc3d8c','#3dc88c','#5c5cdc','#ffb45a','#7adc5a','#dc5a7a','#5adcdc','#dc5adc'];
  window._holdingsChart = new Chart(ctx, {
    type:'doughnut',
    data:{
      labels: items.map(a=>a.name),
      datasets:[{
        data: items.map(a=>a.market),
        backgroundColor: colors,
        borderColor:'#1a2029', borderWidth:2,
      }]
    },
    options:{
      plugins:{
        legend:{ display:false },
        tooltip:{callbacks:{label: c => {
          const a = items[c.dataIndex];
          return `${a.name} ${fmtLots(a.units)}: ${fmt(c.raw)} (${(c.raw/total*100).toFixed(1)}%)`;
        }}}
      }
    }
  });
  // 自訂 HTML legend，把張數用 accent-2 色
  const lg = $('#holdingsLegend');
  if (lg){
    lg.innerHTML = items.map((a, i) => {
      const p = fmtLotsParts(a.units);
      return `
      <div class="legend-item">
        <span class="legend-dot" style="background:${colors[i % colors.length]}"></span>
        <span class="legend-name">${a.name} <span class="legend-code">${a.code}</span></span>
        <span class="legend-lots">${p.lots}</span>
        <span class="legend-odd">${p.odd}</span>
        <span class="legend-pct">${(a.market/total*100).toFixed(1)}%</span>
      </div>
    `;}).join('');
  }
}

function getMonthlyDividends(){
  const { dividends } = buildLots();
  const today = todayISO();
  const monthly = {};
  for (const d of dividends){
    const ym = (d.buy_date||'').slice(0,7);
    if (!ym) continue;
    if (!monthly[ym]) monthly[ym] = { actual:0, forecast:0, items:[] };
    const amt = adjustedDividend(d) || 0;
    const dadj = {...d, dividend: amt};
    if (d.buy_date <= today) {
      monthly[ym].actual += amt;
      monthly[ym].items.push({...dadj, kind:'actual'});
    } else {
      const fc = STATE.forecast[d.code];
      if (fc && fc.enabled) continue;
      monthly[ym].forecast += amt;
      monthly[ym].items.push({...dadj, kind:'forecast'});
    }
  }
  const map = buildHoldings();
  for (const code of Object.keys(STATE.forecast)){
    const fc = STATE.forecast[code];
    if (!fc.enabled || !fc.perShare || !fc.startMonth) continue;
    const a = map[code]; if (!a || a.units<=0) continue;
    const stepMap = { monthly:1, quarterly:3, semi:6, annual:12 };
    const step = stepMap[fc.freq] || 3;
    const [sy, sm] = fc.startMonth.split('-').map(Number);
    let y=sy, m=sm;
    const endY = new Date().getFullYear()+2;
    while (y < endY+1){
      const ym = `${y}-${String(m).padStart(2,'0')}`;
      const amount = fc.perShare * a.units;
      if (ym >= today.slice(0,7)){
        if (!monthly[ym]) monthly[ym] = { actual:0, forecast:0, items:[] };
        monthly[ym].forecast += amount;
        monthly[ym].items.push({code, name:a.name, dividend:amount, buy_date:`${ym}-15`, kind:'forecast'});
      }
      m += step;
      while (m>12){ m-=12; y+=1; }
    }
  }
  return monthly;
}

function drawMonthlyChart(canvasId){
  const monthly = getMonthlyDividends();
  const keys = Object.keys(monthly).sort();
  const start = keys.find(k=>k>='2022-01') || keys[0];
  const today = todayISO().slice(0,7);
  const filtered = keys.filter(k => k>=start && k<=add12(today));
  const labels = filtered;
  const actuals = filtered.map(k => monthly[k].actual);
  const forecasts = filtered.map(k => monthly[k].forecast);
  const ctx = document.getElementById(canvasId);
  if (window['_chart_'+canvasId]) window['_chart_'+canvasId].destroy();
  window['_chart_'+canvasId] = new Chart(ctx, {
    type:'bar',
    data:{labels, datasets:[
      { label:'已收', data:actuals, backgroundColor:'#3ddc84' },
      { label:'預估', data:forecasts, backgroundColor:'#ffc857' },
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      scales:{
        x:{stacked:true, ticks:{color:'#8b96a5', maxRotation:60, minRotation:60, font:{size:10}}, grid:{color:'#2a3340'}},
        y:{stacked:true, ticks:{color:'#8b96a5', callback:v=>fmt(v)}, grid:{color:'#2a3340'}}
      },
      plugins:{
        legend:{labels:{color:'#e6edf3'}},
        tooltip:{callbacks:{label: c => `${c.dataset.label}: ${fmt(c.raw)}`}}
      }
    }
  });
}
function add12(ym){ const [y,m]=ym.split('-').map(Number); const d=new Date(y, m-1+12, 1); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }

// ---------- 持股 ----------
let _holdingsSort = {key:'market', dir:-1};
let _holdingsWhoOverride = '';   // ''=依頂端, 'all', '我', 'Max'
function renderHoldings(){
  const origWho = STATE.who;
  if (_holdingsWhoOverride) STATE.who = _holdingsWhoOverride;
  const map = buildHoldings();
  STATE.who = origWho;
  const hideEmpty = $('#hideEmpty').checked;
  let rows = Object.values(map);
  if (hideEmpty) rows = rows.filter(a=>a.units>0);
  rows.sort((a,b)=>{
    const k=_holdingsSort.key, d=_holdingsSort.dir;
    const av = a[k] ?? -Infinity, bv = b[k] ?? -Infinity;
    if (typeof av === 'string') return av.localeCompare(bv) * d;
    return (av > bv ? 1 : -1) * d;
  });
  const tb = $('#tblHoldings tbody');
  tb.innerHTML = '';
  // 跟「持有/現值」相關的累計只算可見（filtered）；跟「過去配息/已實現」相關的累計算全部
  const allRows = Object.values(map);
  let totals = { units:0, cost:0, market:0, unreal:0, divR:0, real:0, total:0, costAll:0 };
  // 全部（不論可見）：已收配息、已實現損益、含息損益用全部
  for (const a of allRows){
    totals.divR += a.divReceived;
    totals.real += a.realized;
    totals.total += a.totalProfit;
    totals.costAll += a.buyCostTotal;
  }
  for (const a of rows){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${a.name}</td>
      <td class="sub">${a.code}<span class="badge ${isETF(a.code)?'etf':'stock'}">${isETF(a.code)?'ETF':'股'}</span></td>
      <td class="num">${fmt(a.units)}</td>
      <td class="num ${(a.stockDivUnits||0)>0?'':'sub'}">${(a.stockDivUnits||0)>0?fmt(a.stockDivUnits):'-'}${(a.futureStockDivUnits||0)>0?` <span class="badge etf" title="除權日未到，尚未計入持股">+${fmt(a.futureStockDivUnits)}未到</span>`:''}</td>
      <td class="num">${a.units>0?fmt2(a.avg):'-'}</td>
      <td class="num">${fmt(a.cost)}</td>
      <td class="num">${a.cur!=null?fmt2(a.cur):'-'}</td>
      <td class="num">${a.market!=null?fmt(a.market):'-'}</td>
      <td class="num ${cls(a.unreal||0)}">${a.unreal!=null?fmt(a.unreal):'-'}</td>
      <td class="num ${cls(a.unrealPct||0)}">${a.unrealPct!=null?pct(a.unrealPct):'-'}</td>
      <td class="num">${fmt(a.divReceived)}</td>
      <td class="num ${cls(a.divYield||0)}">${a.divYield!=null?pct(a.divYield):'-'}</td>
      <td class="num ${cls(a.realized)}">${fmt(a.realized)}</td>
      <td class="num ${cls(a.profitNoDiv)}">${fmt(a.profitNoDiv)}</td>
      <td class="num ${cls(a.retNoDiv||0)}">${a.retNoDiv!=null?pct(a.retNoDiv):'-'}</td>
      <td class="num ${cls(a.totalProfit)}">${fmt(a.totalProfit)}</td>
      <td class="num ${cls(a.totalRet||0)}">${a.totalRet!=null?pct(a.totalRet):'-'}</td>`;
    tb.appendChild(tr);
    totals.units += a.units; totals.cost += a.cost; totals.market += a.market||0;
    totals.unreal += a.unreal||0;
  }
  $('#tblHoldings tfoot').innerHTML = `
    <tr style="font-weight:600;background:var(--panel-2)">
      <td colspan="2">總計</td>
      <td class="num">${fmt(totals.units)}</td>
      <td class="num">${fmt(allRows.reduce((s,a)=>s+(a.stockDivUnits||0),0))}</td>
      <td></td>
      <td class="num">${fmt(totals.cost)}</td><td></td>
      <td class="num">${fmt(totals.market)}</td>
      <td class="num ${cls(totals.unreal)}">${fmt(totals.unreal)}</td>
      <td class="num ${cls(totals.cost>0?totals.unreal/totals.cost:0)}">${pct(totals.cost>0?totals.unreal/totals.cost:0)}</td>
      <td class="num">${fmt(totals.divR)}</td>
      <td class="num ${cls(totals.cost>0?totals.divR/totals.cost:0)}">${pct(totals.cost>0?totals.divR/totals.cost:0)}</td>
      <td class="num ${cls(totals.real)}">${fmt(totals.real)}</td>
      <td class="num ${cls(totals.unreal+totals.real)}">${fmt(totals.unreal+totals.real)}</td>
      <td class="num ${cls(totals.costAll>0?(totals.unreal+totals.real)/totals.costAll:0)}">${pct(totals.costAll>0?(totals.unreal+totals.real)/totals.costAll:0)}</td>
      <td class="num ${cls(totals.total)}">${fmt(totals.total)}</td>
      <td class="num ${cls(totals.costAll>0?totals.total/totals.costAll:0)}">${pct(totals.costAll>0?totals.total/totals.costAll:0)}</td>
    </tr>`;
  $$('#tblHoldings thead th').forEach((th, i) => {
    const keys = ['name','code','units','stockDivUnits','avg','cost','cur','market','unreal','unrealPct','divReceived','divYield','realized','profitNoDiv','retNoDiv','totalProfit','totalRet'];
    th.style.cursor='pointer';
    th.onclick = () => {
      const k = keys[i];
      if (_holdingsSort.key === k) _holdingsSort.dir = -_holdingsSort.dir;
      else _holdingsSort = { key:k, dir:-1 };
      renderHoldings();
    };
  });
}

// ---------- 交易 ----------
let _tradesSort = {key:'buy_date', dir:-1};
function renderTrades(){
  const { lots } = buildLots();
  if ($('#tradeStock').options.length<=1){
    const codes = [...new Set(lots.map(l=>l.code))].sort();
    for (const c of codes){
      const o = document.createElement('option');
      o.value = c; o.textContent = `${c} ${STATE.data.code_to_name[c]||''}`;
      $('#tradeStock').appendChild(o);
    }
  }
  const enriched = lots.map(enrichLot);
  let rows = enriched;
  const sel = $('#tradeStock').value, stat = $('#tradeStatus').value;
  if (sel) rows = rows.filter(r=>r.code===sel);
  if (stat) rows = rows.filter(r=>r.status===stat);
  const k=_tradesSort.key, d=_tradesSort.dir;
  rows.sort((a,b)=>{
    const av = a[k], bv = b[k];
    if (av==null && bv==null) return 0;
    if (av==null) return 1; if (bv==null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * d;
    return (av > bv ? 1 : -1) * d;
  });
  const tb = $('#tblTrades tbody');
  tb.innerHTML = '';
  for (const r of rows){
    const isUser = r._id && r._id.startsWith('user-');
    const isOverridden = !!STATE.overrides[r._id];
    const tr = document.createElement('tr');
    const status = r.status==='realized'
      ? `<span class="pill realized">已賣</span>`
      : `<span class="pill held">持有</span>`;
    const sellCells = r.status==='realized'
      ? `<td>${r.sell_date||''}</td><td class="num">${fmt2(r.sell_price)}</td><td class="num">${fmt(r.sellNet)}</td>`
      : `<td class="sub">-</td><td class="num sub">${r.curPrice!=null?fmt2(r.curPrice):'-'}</td><td class="num sub">${r.curVal!=null?fmt(r.curVal):'-'}</td>`;
    const editBtn = `<button class="iconbtn" data-act="edit-lot" data-id="${r._id}" title="編輯/刪除">⋮</button>`;
    tr.innerHTML = `
      <td>${status}${isUser?'<span class="badge etf" style="margin-left:4px">新</span>':''}${isOverridden && !isUser?'<span class="badge etf" style="margin-left:4px">改</span>':''}</td>
      <td>${r.name} <span class="sub">${r.code}</span></td>
      <td>${r.buy_date||''}</td>
      <td class="num">${fmt2(r.buy_price)}</td>
      <td class="num">${fmt(r.units)}</td>
      <td class="num">${fmt(r.buyCost)}</td>
      ${sellCells}
      <td class="num ${cls(r.profit||0)}">${r.profit!=null?fmt(r.profit):'-'}</td>
      <td class="num ${cls(r.ret||0)}">${r.ret!=null?pct(r.ret):'-'}</td>
      <td class="num ${cls(r.annual||0)}">${r.annual!=null?pct(r.annual):'-'}</td>
      <td>${editBtn}</td>`;
    tb.appendChild(tr);
  }
  $('#tradeCount').textContent = `共 ${rows.length} 筆`;
  $('#feeRateDisplay').textContent = (STATE.fee.feeRate*100).toFixed(4)+'%';
  $$('#tblTrades thead th').forEach((th,i) => {
    const keys = ['status','name','buy_date','buy_price','units','buyCost','sell_date','sell_price','sellNet','profit','ret','annual',null];
    if (!keys[i]) { th.style.cursor=''; return; }
    th.style.cursor='pointer';
    if (!th.dataset.basetext) th.dataset.basetext = th.textContent;
    const arrow = (_tradesSort.key === keys[i]) ? (_tradesSort.dir>0?' ▲':' ▼') : '';
    th.textContent = th.dataset.basetext + arrow;
    th.onclick = () => {
      const k = keys[i];
      if (_tradesSort.key === k) _tradesSort.dir = -_tradesSort.dir;
      else _tradesSort = { key:k, dir:-1 };
      renderTrades();
    };
  });
  $$('#tblTrades [data-act="edit-lot"]').forEach(b => {
    b.onclick = () => openLotEditor(b.dataset.id);
  });
}

// ---------- 配息 ----------
function renderDividends(){
  const { dividends } = buildLots();
  if ($('#divStock').options.length<=1){
    const codes = [...new Set(dividends.map(l=>l.code))].sort();
    for (const c of codes){
      const o = document.createElement('option');
      o.value = c; o.textContent = `${c} ${STATE.data.code_to_name[c]||''}`;
      $('#divStock').appendChild(o);
    }
    const years = [...new Set(dividends.map(l=>(l.buy_date||'').slice(0,4)).filter(Boolean))].sort();
    for (const y of years){ const o=document.createElement('option'); o.value=y; o.textContent=y; $('#divYear').appendChild(o); }
  }
  const today = todayISO();
  const codeF = $('#divStock').value, yrF = $('#divYear').value, kindF = $('#divKind').value;
  let rows = dividends.slice();
  if (codeF) rows = rows.filter(r=>r.code===codeF);
  if (yrF) rows = rows.filter(r=>(r.buy_date||'').startsWith(yrF));
  rows = rows.map(r => ({...r, kind: r.buy_date<=today?'actual':'forecast'}));
  if (kindF) rows = rows.filter(r=>r.kind===kindF);
  rows.sort((a,b)=>(b.buy_date||'').localeCompare(a.buy_date||''));
  const tb = $('#tblDiv tbody');
  tb.innerHTML='';
  let sumA=0, sumF=0;
  let prevMonth = null, bandIdx = 0;
  for (const r of rows){
    const ym = (r.buy_date||'').slice(0,7);
    if (ym !== prevMonth){ bandIdx++; prevMonth = ym; }
    const bandClass = bandIdx % 2 === 0 ? 'month-band' : '';
    const a = adjustedDividend(r) || 0;
    if (r.kind==='actual') sumA+=a; else sumF+=a;
    const isUser = r._id && r._id.startsWith('user-');
    const tr = document.createElement('tr');
    if (bandClass) tr.classList.add(bandClass);
    if (STATE._flashId === r._id) tr.classList.add('flash-saved');
    tr.innerHTML = `
      <td>${r.kind==='actual'?'<span class="pill realized">已發</span>':'<span class="pill held">預估</span>'}${isUser?'<span class="badge etf" style="margin-left:4px">新</span>':''}</td>
      <td><input type="date" class="inline-date" data-act="ex-date" data-id="${r._id}" value="${divExDate(r)||''}"></td>
      <td><input type="date" class="inline-date sub" data-act="pay-date" data-id="${r._id}" value="${r.buy_date||''}"></td>
      <td>${r.name} <span class="sub">${r.code}</span></td>
      <td class="num">${fmt2(r.buy_price)}</td>
      <td class="num">${fmt(adjustedDividend(r))}${(r.kind==='forecast' && (!STATE.overrides[r._id] || STATE.overrides[r._id].dividend==null))?'<span class="badge etf" style="margin-left:4px" title="依除息日當下持股自動推估">自動</span>':''}</td>
      <td><button class="iconbtn" data-act="edit-div" data-id="${r._id}" title="編輯金額">✏️</button>${isUser?` <button class="iconbtn" data-act="del-user" data-id="${r._id}">刪</button>`:(STATE.overrides[r._id]?` <button class="iconbtn" data-act="reset-div" data-id="${r._id}" title="還原">↺</button>`:'')}</td>`;
    tb.appendChild(tr);
  }
  $('#divSummary').textContent = `已收 ${fmt(sumA)}　預估 ${fmt(sumF)}　筆數 ${rows.length}`;
  $$('#tblDiv [data-act="del-user"]').forEach(b => b.onclick = () => deleteUserRecord(b.dataset.id));
  $$('#tblDiv [data-act="edit-div"]').forEach(b => b.onclick = () => editDividend(b.dataset.id));
  $$('#tblDiv [data-act="ex-date"]').forEach(inp => {
    inp.onchange = e => updateDivDate(e.target.dataset.id, 'ex_date', e.target.value);
  });
  $$('#tblDiv [data-act="pay-date"]').forEach(inp => {
    inp.onchange = e => updateDivDate(e.target.dataset.id, 'buy_date', e.target.value);
  });
  $$('#tblDiv [data-act="reset-div"]').forEach(b => b.onclick = () => {
    if (!confirm('還原為原始資料？')) return;
    delete STATE.overrides[b.dataset.id]; saveOverrides(); renderAll();
  });
}


// 在配息紀錄表內直接改日期：除息日 / 入帳日
function updateDivDate(id, field, value){
  if (!value) return;
  if (id.startsWith('user-')){
    const ur = STATE.userRecords.find(x => x._id === id);
    if (ur){ ur[field] = value; saveUserRecords(); }
  } else {
    STATE.overrides[id] = { ...(STATE.overrides[id]||{}), [field]: value };
    saveOverrides();
  }
  STATE._flashId = id;
  renderAll();
  setTimeout(() => { STATE._flashId = null; }, 1200);
}

// 編輯配息（含預估轉實際）
function editDividend(id){
  const merged = getMergedRecords();
  const r = merged.find(x => x._id === id);
  if (!r || r.who !== '配息') return;
  const today = todayISO();
  const isFuture = r.buy_date > today;
  const tag = isFuture ? '【預估】' : '【已發】';
  const psStr = prompt(`${tag} ${r.name}\n入帳日 ${r.buy_date}　除息日 ${divExDate(r)}\n\n每股配息：`, r.buy_price ?? '');
  if (psStr === null) return;
  const ps = parseFloat(psStr);
  if (isNaN(ps) || ps < 0){ alert('每股配息格式錯誤'); return; }
  const exDateStr = prompt('除息日（影響推估持股，可留空 = 入帳日 −30 天）：', divExDate(r));
  const exDateNew = exDateStr === null ? divExDate(r) : (exDateStr.trim() || null);
  // 用「除息日當下」的持股推估，回放交易紀錄
  const exDate = divExDate(r);
  const heldUnits = holdingsAtDate(r.code, exDate);
  const suggested = heldUnits > 0 ? Math.round(heldUnits * ps) : (r.dividend || '');
  const totalStr = prompt(`配息總金額（建議 ${suggested.toLocaleString()}，依除息日 ${r.buy_date} 當時持有 ${heldUnits} 股 × ${ps}）：`, suggested);
  if (totalStr === null) return;
  const total = parseFloat(totalStr);
  if (isNaN(total) || total < 0){ alert('配息金額格式錯誤'); return; }
  if (id.startsWith('user-')){
    const ur = STATE.userRecords.find(x => x._id === id);
    if (ur){ ur.buy_price = ps; ur.dividend = total; ur.ex_date = exDateNew; saveUserRecords(); }
  } else {
    STATE.overrides[id] = { ...(STATE.overrides[id]||{}), buy_price: ps, dividend: total, ex_date: exDateNew };
    saveOverrides();
  }
  renderAll();
}

// ---------- 月配息 ----------
function renderMonthly(){
  drawMonthlyChart('chartMonthly2');
  const monthly = getMonthlyDividends();
  const keys = Object.keys(monthly).sort();
  const today = todayISO().slice(0,7);

  // 累計總配息
  let cumReceived = 0, cumForecast = 0;
  for (const k of keys){
    cumReceived += monthly[k].actual;
    cumForecast += monthly[k].forecast;
  }
  $('#kpi-mon-received').textContent = fmt(cumReceived);
  $('#kpi-mon-forecast').textContent = fmt(cumForecast);
  $('#kpi-mon-total').textContent = fmt(cumReceived + cumForecast);
  // 平均（用實際發放的月份來算）
  const monthsWithActual = keys.filter(k => monthly[k].actual > 0).length;
  $('#kpi-mon-avg').textContent = monthsWithActual>0 ? fmt(cumReceived / monthsWithActual) : '-';

  // Yearly table
  const yearly = {};
  for (const k of keys){
    const y = k.slice(0,4);
    if (!yearly[y]) yearly[y] = { actual:0, forecast:0, months:0 };
    yearly[y].actual += monthly[k].actual;
    yearly[y].forecast += monthly[k].forecast;
    yearly[y].months += 1;
  }
  const tbY = $('#tblYearly tbody'); tbY.innerHTML='';
  let cumY = 0;
  for (const y of Object.keys(yearly).sort()){
    const r = yearly[y];
    const total = r.actual + r.forecast;
    cumY += r.actual;
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${y}</td><td class="num">${fmt(r.actual)}</td><td class="num">${fmt(r.forecast)}</td><td class="num"><b>${fmt(total)}</b></td><td class="num">${fmt(total/Math.max(r.months,1))}</td><td class="num sub">${fmt(cumY)}</td>`;
    tbY.appendChild(tr);
  }
  // 反序顯示
  const trsY = Array.from(tbY.children);
  tbY.innerHTML='';
  for (const tr of trsY.reverse()) tbY.appendChild(tr);

  // Monthly table
  const tb = $('#tblMonthly tbody'); tb.innerHTML='';
  const filtered = keys.filter(k => k>='2022-01').sort();
  let cum = 0;
  const rowsArr = [];
  for (const k of filtered){
    const r = monthly[k];
    const total = r.actual+r.forecast;
    if (total<=0) continue;
    cum += r.actual;
    const items = [...r.items].sort((a,b)=>(b.dividend||0)-(a.dividend||0)).slice(0,3);
    const top = items.map(it=>`${it.name} ${fmt(it.dividend)}`).join('、');
    const isFuture = k > today;
    rowsArr.push({k, r, total, top, isFuture, cum});
  }
  rowsArr.reverse();
  for (const x of rowsArr){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${x.k}${x.isFuture?' <span class="pill held">未來</span>':''}</td><td class="num">${fmt(x.r.actual)}</td><td class="num">${fmt(x.r.forecast)}</td><td class="num"><b>${fmt(x.total)}</b></td><td class="num sub">${fmt(x.cum)}</td><td class="sub">${x.top}</td>`;
    tb.appendChild(tr);
  }
}

// ---------- 年度預估 ----------
function renderAnnual(){
  const sel = $('#annualYear');
  // 取所有有配息紀錄的年份 + 當年 + 明年
  const today = todayISO();
  const curYear = parseInt(today.slice(0,4));
  const yearsSet = new Set([curYear, curYear+1]);
  for (const r of getMergedRecords()){
    if (r.who === '配息' && r.buy_date) yearsSet.add(parseInt(r.buy_date.slice(0,4)));
  }
  const years = Array.from(yearsSet).sort((a,b)=>b-a);
  if (sel.options.length <= 1){
    sel.innerHTML = '';
    for (const y of years){
      const o = document.createElement('option');
      o.value = y; o.textContent = y + ' 年';
      sel.appendChild(o);
    }
    sel.value = curYear;
    sel.onchange = renderAnnual;
  }
  const Y = parseInt(sel.value) || curYear;
  const yearStr = String(Y);

  // 收集該年所有配息（用入帳日 buy_date 判斷年份）
  const items = getMergedRecords().filter(r => r.who === '配息' && (r.buy_date||'').startsWith(yearStr));
  // 套用 adjustedDividend
  const enriched = items.map(d => ({...d, _amt: adjustedDividend(d) || 0}));

  let received = 0, forecast = 0;
  const byCode = {};
  for (const r of enriched){
    const past = r.buy_date <= today;
    if (past) received += r._amt;
    else forecast += r._amt;
    if (!byCode[r.code]) byCode[r.code] = { name:r.name, code:r.code, received:0, forecast:0, items:[] };
    if (past) byCode[r.code].received += r._amt;
    else byCode[r.code].forecast += r._amt;
    byCode[r.code].items.push(r);
  }

  // 計算總成本（給殖利率用）
  const map = buildHoldings();
  const total = received + forecast;

  // KPI
  $('#kpiAnYear').textContent = Y;
  $('#kpiAnReceived').textContent = fmt(received);
  $('#kpiAnForecast').textContent = fmt(forecast);
  $('#kpiAnTotal').textContent = fmt(total);
  let totalCost = 0;
  for (const c of Object.keys(byCode)){
    const a = map[c];
    if (a) totalCost += a.cost;
  }
  $('#kpiAnYield').textContent = totalCost > 0 ? (total/totalCost*100).toFixed(2)+'%' : '-';

  // 明細表
  const tb = $('#tblAnnual tbody');
  tb.innerHTML = '';
  const rows = Object.values(byCode).sort((a,b) => (b.received+b.forecast) - (a.received+a.forecast));
  for (const r of rows){
    const a = map[r.code];
    const units = a ? a.units : 0;
    const cost = a ? a.cost : 0;
    const tot = r.received + r.forecast;
    const yld = cost > 0 ? tot/cost : 0;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${r.name} <span class="sub">${r.code}</span></td>
      <td class="num">${fmt(units)}</td>
      <td class="num">${fmt(cost)}</td>
      <td class="num green">${fmt(r.received)}</td>
      <td class="num" style="color:var(--yellow)">${fmt(r.forecast)}</td>
      <td class="num"><b>${fmt(tot)}</b></td>
      <td class="num">${cost>0 ? (yld*100).toFixed(2)+'%' : '-'}</td>`;
    tb.appendChild(tr);
  }
  // tfoot
  $('#tblAnnual tfoot').innerHTML = `
    <tr style="font-weight:600;background:var(--panel-2)">
      <td colspan="2">總計</td>
      <td class="num">${fmt(totalCost)}</td>
      <td class="num green">${fmt(received)}</td>
      <td class="num" style="color:var(--yellow)">${fmt(forecast)}</td>
      <td class="num">${fmt(total)}</td>
      <td class="num">${totalCost > 0 ? (total/totalCost*100).toFixed(2)+'%' : '-'}</td>
    </tr>`;
}

// ---------- 股價 ----------
function renderPrices(){
  // 更新「上次更新時間」（總覽 + 股價更新分頁同步顯示）
  const updateInfo = (STATE.priceMeta && STATE.priceMeta.updatedAt)
    ? `上次更新：${STATE.priceMeta.updatedAt}（${STATE.priceMeta.source && (STATE.priceMeta.source.startsWith('twse')||STATE.priceMeta.source.startsWith('gas'))?'自動抓取':'手動輸入'}）`
    : '';
  if ($('#priceUpdateInfo')) $('#priceUpdateInfo').textContent = updateInfo;
  if ($('#dashPriceUpdateInfo')) $('#dashPriceUpdateInfo').textContent = updateInfo;

  const root = $('#priceGrid');
  if (!root) return;
  root.innerHTML='';
  const codes = heldCodes();
  $('#priceCount').textContent = `共 ${codes.length} 檔現持股`;
  for (const c of codes){
    const name = STATE.data.code_to_name[c];
    const p = STATE.prices[c] ?? '';
    const div = document.createElement('div');
    div.className='row';
    div.innerHTML = `<div><div class="name">${name}</div><div class="code">${c}</div></div>
                     <input type="number" step="0.01" data-code="${c}" value="${p}">`;
    root.appendChild(div);
  }
  root.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('change', e => {
      const c = e.target.dataset.code;
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v>0) STATE.prices[c] = v;
      else delete STATE.prices[c];
      savePrices({updatedAt: new Date().toISOString().slice(0,16).replace('T',' '), source:'manual'});
      renderAll();
    });
  });
  $('#resetPrices').onclick = () => {
    if (!confirm('回復為 Excel 內最後一次的現值？')) return;
    STATE.prices = {...STATE.data.latest_prices};
    savePrices({updatedAt:'', source:''});
    renderPrices();
    renderAll();
  };
  $('#recalc').onclick = () => renderAll();
  if ($('#fetchPrices')) $('#fetchPrices').onclick = () => fetchTwsePrices('yesterday');
  if ($('#fetchPricesLive')) $('#fetchPricesLive').onclick = () => fetchTwsePrices('live');
  if ($('#fetchPricesOpenAPI')) $('#fetchPricesOpenAPI').onclick = fetchTwseOpenAPI;
  if ($('#pastePricesBtn')) $('#pastePricesBtn').onclick = pastePricesJson;
  if ($('#fetchPricesGASLive')) $('#fetchPricesGASLive').onclick = () => fetchPricesViaGAS('live');
  if ($('#fetchPricesGAS')) $('#fetchPricesGAS').onclick = () => fetchPricesViaGAS('yesterday');
  if ($('#dashFetchPricesGASLive')) $('#dashFetchPricesGASLive').onclick = () => fetchPricesViaGAS('live');
}



// 從 TWSE OpenAPI 直接抓（如果有 CORS）— 上市的所有股票收盤
async function fetchTwseOpenAPI(){
  const status = $('#fetchStatus');
  const btn = $('#fetchPricesOpenAPI');
  if (!btn) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '抓取中…';
  status.textContent = '走 TWSE 官方 OpenAPI…';

  const codes = heldCodes();
  const updates = {};
  let priceDate = '';
  try {
    const r1 = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {cache:'no-store'});
    if (r1.ok){
      const arr = await r1.json();
      for (const it of arr){
        if (codes.includes(it.Code)){
          const cp = parseFloat(it.ClosingPrice);
          if (cp > 0) updates[it.Code] = cp;
        }
      }
    }
    // OTC（上櫃）
    const r2 = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {cache:'no-store'});
    if (r2.ok){
      const arr = await r2.json();
      for (const it of arr){
        const code = it.SecuritiesCompanyCode || it.Code;
        if (codes.includes(code)){
          const cp = parseFloat(it.Close || it.ClosingPrice);
          if (cp > 0) updates[code] = cp;
        }
      }
    }
  } catch(e){
    status.innerHTML = `<span class="red">官方 OpenAPI 連線失敗：${e.message}</span> — 改用 CORS proxy`;
    btn.disabled = false; btn.textContent = orig;
    return fetchTwsePrices('yesterday');
  }
  btn.disabled = false; btn.textContent = orig;
  if (Object.keys(updates).length === 0){
    status.innerHTML = '<span class="red">官方 API 沒抓到資料（可能今天是非交易日）</span>';
    return;
  }
  Object.assign(STATE.prices, updates);
  const dateStr = new Date().toISOString().slice(0,10);
  savePrices({updatedAt: dateStr + ' ' + new Date().toTimeString().slice(0,5), source:'twse-openapi'});
  status.innerHTML = `<span class="green">✔ TWSE 官方收盤抓到 ${Object.keys(updates).length}/${codes.length} 檔</span>`;
  renderPrices();
  renderAll();
}

// 從剪貼簿貼 prices.json（user 在本機跑 fetch_prices.py 後 copy 內容過來）
async function pastePricesJson(){
  const status = $('#fetchStatus');
  try {
    const txt = await navigator.clipboard.readText();
    const obj = JSON.parse(txt);
    const prices = obj.prices || obj;
    if (typeof prices !== 'object'){ throw new Error('格式不對'); }
    let n = 0;
    for (const c of Object.keys(prices)){
      const v = parseFloat(prices[c]);
      if (v > 0){ STATE.prices[c] = v; n++; }
    }
    if (n === 0) throw new Error('沒讀到任何有效價格');
    const dateStr = obj.price_date || new Date().toISOString().slice(0,10);
    savePrices({updatedAt: dateStr + ' ' + new Date().toTimeString().slice(0,5), source:'paste'});
    status.innerHTML = `<span class="green">✔ 從剪貼簿貼上 ${n} 檔</span>`;
    renderPrices(); renderAll();
  } catch(e){
    status.innerHTML = `<span class="red">貼上失敗：${e.message}</span> 請先在本機執行 <code>fetch_prices.py</code>，把輸出的 JSON 內容複製後再點此按鈕`;
  }
}


// 透過 Google Apps Script 抓股價（不靠 CORS proxy，最穩）
async function fetchPricesViaGAS(mode){
  if (!STATE.sheetsUrl){ alert('請先到「設定」貼上 Apps Script URL'); return; }
  // 同時鎖兩顆 GAS 按鈕（不論點哪一個都顯示中）
  const btns = [
    mode==='live' ? $('#fetchPricesGASLive') : $('#fetchPricesGAS'),
    $('#dashFetchPricesGASLive'),
  ].filter(Boolean);
  if (btns.length === 0) return;
  const origs = btns.map(b => b.textContent);
  btns.forEach((b,i) => { b.disabled = true; b.textContent = '抓取中…'; });
  const statusEls = [$('#fetchStatus'), $('#dashFetchStatus')].filter(Boolean);
  const setStatus = (html) => statusEls.forEach(s => { s.innerHTML = html; });
  setStatus('走 Apps Script 抓 TWSE…');

  const restore = () => btns.forEach((b,i) => { b.disabled = false; b.textContent = origs[i]; });

  const codes = heldCodes();
  if (codes.length === 0){
    setStatus('<span class="sub">目前沒有持股</span>');
    restore();
    return;
  }

  const url = STATE.sheetsUrl + '?action=prices&codes=' + codes.join(',') + '&mode=' + (mode||'auto');
  try {
    const r = await fetch(url, {cache:'no-store'});
    if (!r.ok) throw new Error('HTTP '+r.status);
    const json = await r.json();
    if (json.error) throw new Error(json.error);

    const got = Object.keys(json.prices || {}).length;
    if (got === 0){
      setStatus(`<span class="red">GAS 抓到 0 檔</span>　錯誤：${(json.errors||[]).join(' / ') || '未知'}`);
      restore();
      return;
    }
    Object.assign(STATE.prices, json.prices);
    const dateStr = json.price_date || new Date().toISOString().slice(0,10);
    savePrices({updatedAt: dateStr + ' ' + new Date().toTimeString().slice(0,5), source: mode==='live'?'gas-live':(mode==='yesterday'?'gas-yest':'gas')});
    setStatus(`<span class="green">✔ GAS 抓到 ${got}/${json.total} 檔 (報價日 ${dateStr})</span>${json.missing && json.missing.length?` 缺：${json.missing.join(', ')}`:''}`);
    renderPrices();
    renderAll();
  } catch(e){
    setStatus(`<span class="red">GAS 抓取失敗：${e.message}</span>　請確認 Apps Script 已部署最新版且設「任何人」可存取`);
  } finally {
    restore();
  }
}

// ---------- 抓股價 ----------
async function fetchTwsePrices(mode){
  // mode: 'live' = 即時最新成交 (z 欄位)；'yesterday' = 昨日收盤 (y 欄位)；其他 = 自動 (z 優先 → y)
  const btn = mode==='live' ? $('#fetchPricesLive') : $('#fetchPrices');
  const status = $('#fetchStatus');
  const others = [$('#fetchPricesLive'), $('#fetchPrices')].filter(Boolean);
  others.forEach(b => b.disabled = true);
  const origText = btn.textContent;
  btn.textContent = '抓取中…';
  status.textContent = '';

  const codes = heldCodes();
  if (codes.length === 0){
    others.forEach(b => b.disabled = false);
    btn.textContent = origText;
    status.innerHTML = '<span class="sub">目前沒有持股，無需更新</span>';
    return;
  }
  const proxies = [
    { name: 'allorigins', fn: u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}` },
    { name: 'codetabs',   fn: u => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}` },
    { name: 'corsproxy',  fn: u => `https://corsproxy.io/?${encodeURIComponent(u)}` },
    { name: 'cors.sh',    fn: u => `https://proxy.cors.sh/${u}` },
    { name: 'thingproxy', fn: u => `https://thingproxy.freeboard.io/fetch/${u}` },
  ];
  const buildUrl = (chList) => `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${chList}&json=1&delay=0&_=${Date.now()}`;

  // 把上次成功的 proxy 排到第一個
  const ordered = [...proxies].sort((a,b) => (b.name===STATE.lastFetchProxy?1:0) - (a.name===STATE.lastFetchProxy?1:0));
  const errors = [];
  let usedProxy = '';
  async function tryFetch(chList){
    for (const p of ordered){
      try {
        status.textContent = `嘗試 ${p.name}${p.name===STATE.lastFetchProxy?' (上次成功)':''}…`;
        const r = await fetch(p.fn(buildUrl(chList)), {cache:'no-store'});
        if (!r.ok){ errors.push(`${p.name}: HTTP ${r.status}`); continue; }
        const txt = await r.text();
        try {
          const json = JSON.parse(txt);
          usedProxy = p.name;
          return json;
        } catch(e){ errors.push(`${p.name}: 解析失敗`); continue; }
      } catch(e){ errors.push(`${p.name}: ${e.message||'失敗'}`); }
    }
    return null;
  }

  const tseList = codes.map(c => `tse_${c}.tw`).join('|');
  status.textContent = '查上市股票…';
  const data1 = await tryFetch(tseList);
  const found = new Set();
  const updates = {};
  let priceDate = '';
  if (data1 && data1.msgArray){
    for (const m of data1.msgArray){
      const z = parseFloat(m.z);
      const y = parseFloat(m.y);
      let price;
      if (mode==='live') price = z>0 ? z : (y>0?y:NaN);          // 即時優先
      else if (mode==='yesterday') price = y>0 ? y : (z>0?z:NaN); // 昨收優先
      else price = z>0 ? z : (y>0?y:NaN);                          // 自動
      if (!isNaN(price)){
        updates[m.c] = price;
        found.add(m.c);
        if (m.d && !priceDate) priceDate = m.d;
      }
    }
  }
  const missing = codes.filter(c => !found.has(c));
  if (missing.length){
    status.textContent = `查上櫃股票… (${missing.length} 檔)`;
    const otcList = missing.map(c => `otc_${c}.tw`).join('|');
    const data2 = await tryFetch(otcList);
    if (data2 && data2.msgArray){
      for (const m of data2.msgArray){
        const z = parseFloat(m.z);
        const y = parseFloat(m.y);
        let price;
        if (mode==='live') price = z>0 ? z : (y>0?y:NaN);
        else if (mode==='yesterday') price = y>0 ? y : (z>0?z:NaN);
        else price = z>0 ? z : (y>0?y:NaN);
        if (!isNaN(price)){
          updates[m.c] = price;
          found.add(m.c);
          if (m.d && !priceDate) priceDate = m.d;
        }
      }
    }
  }

  others.forEach(b => b.disabled = false);
  btn.textContent = origText;

  if (Object.keys(updates).length === 0){
    status.innerHTML = `<span class="red">所有 CORS proxy 都失敗了：</span><br><span class="small sub">${errors.join('　·　')}</span><br>建議：等幾分鐘再試（多半是免費服務臨時被限流），或執行同層的 <code>fetch_prices.py</code> 從本機抓。`;
    return;
  }
  Object.assign(STATE.prices, updates);
  const dateStr = priceDate ? `${priceDate.slice(0,4)}-${priceDate.slice(4,6)}-${priceDate.slice(6,8)}` : new Date().toISOString().slice(0,10);
  if (usedProxy){ STATE.lastFetchProxy = usedProxy; localStorage.setItem('mystock.lastFetchProxy', usedProxy); }
  savePrices({updatedAt: dateStr + ' ' + new Date().toTimeString().slice(0,5), source: mode==='live'?'twse-live':(mode==='yesterday'?'twse-yest':'twse')});
  const got = Object.keys(updates).length;
  const total = codes.length;
  status.innerHTML = `<span class="green">✔ ${usedProxy} 抓到 ${got}/${total} 檔 (報價日 ${dateStr})</span>${got<total?` 缺：${codes.filter(c=>!found.has(c)).join(', ')}`:''}`;
  renderPrices();
  renderAll();
}

// ---------- 新增交易 ----------
function nextUserId(){ return 'user-' + Date.now() + '-' + Math.random().toString(36).slice(2,7); }

function renderAddTab(){
  const codes = Object.keys(STATE.data.code_to_name).sort();
  const fillCodes = (sel) => {
    const cur = sel.value;
    sel.innerHTML = '';
    for (const c of codes){
      const o = document.createElement('option');
      o.value = c; o.textContent = `${c} ${STATE.data.code_to_name[c]||''}`;
      sel.appendChild(o);
    }
    if (cur) sel.value = cur;
  };
  ['#buyStock','#divStockNew','#sdStockNew'].forEach(s => fillCodes($(s)));

  const today = todayISO();
  ['#buyDate','#sellDate'].forEach(s => { if ($(s) && !$(s).value) $(s).value = today; });
  // 配股：除權日今日，入帳日 +30
  const sdExEl = $('#sdExDateNew'), sdPayEl = $('#sdDateNew');
  if (sdExEl && !sdExEl.value) sdExEl.value = today;
  if (sdPayEl && !sdPayEl.value) sdPayEl.value = shiftDate(today, 30);
  const exEl = $('#divExDateNew'), payEl = $('#divDateNew');
  if (exEl && !exEl.value) exEl.value = today;
  if (payEl && !payEl.value) payEl.value = shiftDate(today, 30);

  const recalcBuy = () => {
    const p = parseFloat($('#buyPrice').value)||0;
    const u = parseFloat($('#buyUnits').value)||0;
    const amt = p*u;
    const fee = feeOf(amt);
    $('#buyAmount').textContent = fmt(amt);
    $('#buyFee').textContent = fmt(fee);
    $('#buyTotal').textContent = fmt(amt + fee);
  };
  ['#buyPrice','#buyUnits'].forEach(s => $(s).oninput = () => { recalcBuy(); renderBuyReference(); });
  // 股票切換時更新參考
  $('#buyStock').onchange = renderBuyReference;
  // 進入頁面先渲染一次
  renderBuyReference();

  const recalcDiv = () => {
    const code = $('#divStockNew').value;
    const ps = parseFloat($('#divPerShare').value)||0;
    const exDate = $('#divExDateNew').value;
    const units = exDate ? holdingsAtDate(code, exDate) : 0;
    $('#divHolding').textContent = fmt(units);
    $('#divAmount').textContent = fmt(units * ps);
    $('#divUnitsCalc').value = Math.round(units * ps);
  };
  $('#divStockNew').onchange = recalcDiv;
  $('#divPerShare').oninput = recalcDiv;
  // 除息日改變 → 入帳日自動 +30 天 + 重算
  const onExDateChange = () => {
    const ex = $('#divExDateNew').value;
    if (ex) $('#divDateNew').value = shiftDate(ex, 30);
    recalcDiv();
  };
  if (exEl) {
    exEl.onchange = onExDateChange;
    exEl.oninput = onExDateChange;     // 方向鍵 / picker / 直接打字都觸發
    exEl.addEventListener('blur', onExDateChange);
  }

  const sellStockSel = $('#sellStock');
  const map = buildHoldings();
  const heldCodes = Object.keys(map).filter(c => map[c].units>0).sort();
  const curSel = sellStockSel.value;
  sellStockSel.innerHTML='';
  for (const c of heldCodes){
    const o = document.createElement('option');
    o.value = c; o.textContent = `${c} ${STATE.data.code_to_name[c]||''} (持 ${fmt(map[c].units)})`;
    sellStockSel.appendChild(o);
  }
  if (curSel && heldCodes.includes(curSel)) sellStockSel.value = curSel;

  const refreshOpenLots = () => {
    const code = sellStockSel.value;
    const select = $('#sellLot');
    select.innerHTML='';
    const { lots } = buildLots();
    const open = lots.filter(l => l.code === code && !l.sell_date);
    open.sort((a,b)=>(a.buy_date||'').localeCompare(b.buy_date||''));
    for (const l of open){
      const o = document.createElement('option');
      o.value = l._id;
      o.textContent = `${l.buy_date} | ${fmt2(l.buy_price)} × ${fmt(l.units)}股 (${l.who||'我'})`;
      select.appendChild(o);
    }
    if (open.length===0){
      const o = document.createElement('option');
      o.value=''; o.textContent='—— 沒有可賣的批次 ——';
      select.appendChild(o);
    }
  };
  sellStockSel.onchange = refreshOpenLots;
  refreshOpenLots();

  $('#submitBuy').onclick = () => {
    const code = $('#buyStock').value;
    const r = {
      _id: nextUserId(), who: $('#buyWho').value, year: parseInt($('#buyDate').value.slice(0,4)),
      buy_date: $('#buyDate').value, name: STATE.data.code_to_name[code], code,
      buy_price: parseFloat($('#buyPrice').value), units: parseFloat($('#buyUnits').value),
      buy_total: parseFloat($('#buyPrice').value) * parseFloat($('#buyUnits').value),
      sell_date: null, sell_price: null, sell_units: null, sell_total: null, dividend: null
    };
    if (!r.buy_date || !r.buy_price || !r.units){ alert('請填完整：日期、買價、股數'); return; }
    STATE.userRecords.push(r);
    saveUserRecords();
    flashMsg('#buyMsg', `✔ 已新增買進：${r.name} ${r.units} 股 @ ${r.buy_price}`);
    ['#buyPrice','#buyUnits'].forEach(s => $(s).value='');
    recalcBuy();
    renderAll();
  };

  $('#submitSell').onclick = () => {
    const lotId = $('#sellLot').value;
    const sd = $('#sellDate').value;
    const sp = parseFloat($('#sellPrice').value);
    if (!lotId){ alert('沒有可賣的批次'); return; }
    if (!sd || !sp){ alert('請填完整：日期、賣價'); return; }
    STATE.overrides[lotId] = { ...(STATE.overrides[lotId]||{}), sell_date: sd, sell_price: sp };
    saveOverrides();
    flashMsg('#sellMsg', `✔ 已標記為賣出 @ ${sp}`);
    $('#sellPrice').value='';
    refreshOpenLots();
    renderAll();
  };

  $('#submitDiv').onclick = () => {
    const code = $('#divStockNew').value;
    const ps = parseFloat($('#divPerShare').value);
    const date = $('#divDateNew').value;
    const amount = parseFloat($('#divUnitsCalc').value);
    if (!date || !ps || !amount){ alert('請填完整：日期、每股配息、配息金額'); return; }
    const exDate = $('#divExDateNew').value;
    // 重複檢查：同股票同月份是否已有紀錄
    const month = (exDate || date).slice(0,7);
    const dups = getMergedRecords().filter(x =>
      x.who === '配息' && x.code === code &&
      ((divExDate(x)||'').slice(0,7) === month || (x.buy_date||'').slice(0,7) === month)
    );
    if (dups.length > 0){
      const detail = dups.map(d => `  · 除息 ${divExDate(d)||'?'}，入帳 ${d.buy_date||'?'}，金額 ${(d.dividend||0).toLocaleString()}`).join('\n');
      const ok = confirm(`⚠ 已有 ${STATE.data.code_to_name[code]} 在 ${month} 月的配息紀錄：\n${detail}\n\n確定要新增重複的紀錄嗎？\n（建議直接點該筆的日期欄改日期，不要新增）`);
      if (!ok) return;
    }
    const r = {
      _id: nextUserId(), who: '配息', year: parseInt(date.slice(0,4)),
      buy_date: date, ex_date: exDate || null,
      name: STATE.data.code_to_name[code], code,
      buy_price: ps, units: null, buy_total: null,
      sell_date: null, sell_price: null, sell_units: null, sell_total: null, dividend: amount
    };
    STATE.userRecords.push(r);
    saveUserRecords();
    flashMsg('#divMsg', `✔ 已新增配息：${r.name} ${fmt(amount)} 元`);
    $('#divPerShare').value=''; $('#divUnitsCalc').value='';
    renderAll();
  };

  // 配股自動算：配股率(元) ÷ 10 = 每股獲配股數（面額 10 元）
  const recalcSd = () => {
    const code = $('#sdStockNew').value;
    const ex = $('#sdExDateNew').value;
    const ps = parseFloat($('#sdPerShare').value)||0;
    const units = ex ? holdingsAtDate(code, ex) : 0;
    $('#sdHolding').textContent = fmt(units);
    // 配股率 0.1 元 → 每股獲配 0.01 股 → 1000 股配 10 股
    const calc = Math.floor(units * ps / 10);
    $('#sdAmount').textContent = fmt(calc);
    if (ps > 0) $('#sdUnits').value = calc;
  };
  $('#sdStockNew').onchange = recalcSd;
  $('#sdPerShare').oninput = recalcSd;
  if (sdExEl){
    const onSdExChange = () => {
      const ex = $('#sdExDateNew').value;
      if (ex) $('#sdDateNew').value = shiftDate(ex, 30);
      recalcSd();
    };
    sdExEl.onchange = onSdExChange;
    sdExEl.oninput = onSdExChange;
  }

  $('#submitSd').onclick = () => {
    const code = $('#sdStockNew').value;
    const exDate = $('#sdExDateNew').value;
    const date = $('#sdDateNew').value;
    const ps = parseFloat($('#sdPerShare').value) || 0;
    const u = parseFloat($('#sdUnits').value);
    if (!exDate || !date || !u){ alert('請填完整：除權日、入帳日、配股股數'); return; }
    const r = {
      _id: nextUserId(), who: '配股', year: parseInt(date.slice(0,4)),
      buy_date: date, ex_date: exDate, name: STATE.data.code_to_name[code], code,
      buy_price: ps, units: u, buy_total: 0,
      sell_date: null, sell_price: null, sell_units: null, sell_total: null, dividend: null
    };
    STATE.userRecords.push(r);
    saveUserRecords();
    flashMsg('#sdMsg', `✔ 已新增配股：${r.name} ${fmt(u)} 股`);
    $('#sdUnits').value='';
    renderAll();
  };

  renderUserRecordsList();
}

function flashMsg(sel, text){
  const el = $(sel);
  el.textContent = text;
  el.className = 'small green';
  setTimeout(()=>{ el.textContent=''; }, 4000);
}

function renderUserRecordsList(){
  const tbody = $('#userListBody');
  tbody.innerHTML='';
  const allRows = [];
  for (const r of STATE.userRecords) allRows.push({...r, _kind: 'new'});
  for (const id of Object.keys(STATE.overrides)){
    const ov = STATE.overrides[id];
    const orig = STATE.data.records.find(x => x._id === id);
    if (!orig) continue;
    allRows.push({...orig, ...ov, _kind:'override', _id:id});
  }
  allRows.sort((a,b)=>((b.buy_date||b.sell_date||'')+'').localeCompare(a.buy_date||a.sell_date||''));
  if (allRows.length===0){
    tbody.innerHTML = '<tr><td colspan="4" class="sub" style="text-align:center;padding:16px">— 尚未有手動新增的紀錄 —</td></tr>';
    return;
  }
  for (const r of allRows){
    const tr = document.createElement('tr');
    let kindLabel='';
    if (r._kind==='new') kindLabel = `<span class="badge etf">新增 ${r.who}</span>`;
    else kindLabel = `<span class="badge stock">已標賣出</span>`;
    let detail='';
    if (r.who==='我' || r.who==='Max') detail = `${r.name} 買 @ ${r.buy_price} × ${fmt(r.units)}`;
    else if (r.who==='配息') detail = `${r.name} 配息 ${fmt(r.dividend)}`;
    else if (r.who==='配股') detail = `${r.name} 配股 ${fmt(r.units)}`;
    if (r._kind==='override') detail = `${r.name} 賣 @ ${r.sell_price} (${r.sell_date})`;
    let editBtn = '';
    if (r._kind === 'new'){
      if (r.who === '我' || r.who === 'Max'){
        editBtn = `<button class="iconbtn" data-act="edit-buy-u" data-id="${r._id}">修改</button> `;
      } else if (r.who === '配息'){
        editBtn = `<button class="iconbtn" data-act="edit-div-u" data-id="${r._id}">修改</button> `;
      }
    } else if (r._kind === 'override'){
      editBtn = `<button class="iconbtn" data-act="edit-sell-o" data-id="${r._id}">修改</button> `;
    }
    tr.innerHTML = `<td>${kindLabel}</td><td>${r.buy_date||r.sell_date||''}</td><td>${detail}</td>
      <td>${editBtn}<button class="iconbtn" data-act="del-${r._kind}" data-id="${r._id}">刪除</button></td>`;
    tbody.appendChild(tr);
  }
  $$('[data-act="del-new"]').forEach(b => b.onclick = () => deleteUserRecord(b.dataset.id));
  $$('[data-act="del-override"]').forEach(b => b.onclick = () => {
    if (!confirm('確定移除這筆賣出標記？該批次會回復為持有中')) return;
    delete STATE.overrides[b.dataset.id];
    saveOverrides();
    renderAll();
  });
  $$('[data-act="edit-buy-u"]').forEach(b => b.onclick = () => openLotEditor(b.dataset.id));
  $$('[data-act="edit-div-u"]').forEach(b => b.onclick = () => editDividend(b.dataset.id));
  $$('[data-act="edit-sell-o"]').forEach(b => b.onclick = () => openLotEditor(b.dataset.id));
}

function deleteUserRecord(id){
  if (!confirm('確定刪除這筆紀錄？')) return;
  STATE.userRecords = STATE.userRecords.filter(r => r._id !== id);
  saveUserRecords();
  renderAll();
}

function openLotEditor(id){
  const merged = getMergedRecords();
  const r = merged.find(x => x._id === id);
  if (!r) return;
  const isUser = id.startsWith('user-');
  let msg = `${r.name} ${r.code}\n買進 ${r.buy_date} @ ${r.buy_price} × ${r.units}股 (${r.who||'我'})`;
  if (r.sell_date) msg += `\n已賣出 ${r.sell_date} @ ${r.sell_price}`;
  msg += '\n\n選擇操作：\n1. 標記為已賣出 / 修改賣出資訊\n2. 移除賣出標記 (回復為持有)\n3. 修改買進資料 (僅限自建)\n4. 刪除這筆 (僅限自建)';
  const act = prompt(msg + '\n\n輸入 1 / 2 / 3 / 4：');
  if (act==='1'){
    const sd = prompt('賣出日期 (YYYY-MM-DD)：', r.sell_date || todayISO()); if(!sd) return;
    const sp = parseFloat(prompt('賣價：', r.sell_price || '')); if(!sp) return;
    STATE.overrides[id] = { ...(STATE.overrides[id]||{}), sell_date: sd, sell_price: sp };
    saveOverrides(); renderAll();
  } else if (act==='2'){
    if (STATE.overrides[id]){
      delete STATE.overrides[id];
      saveOverrides(); renderAll();
    } else {
      alert('這筆是 Excel 原始的賣出資料，請改 Excel 後重跑 rebuild_data.py');
    }
  } else if (act==='3'){
    if (!isUser){ alert('Excel 原始紀錄不能在這裡改，請改 Excel 後重跑 rebuild_data.py'); return; }
    const ur = STATE.userRecords.find(x => x._id === id);
    if (!ur) return;
    const bd = prompt('買進日期 (YYYY-MM-DD)：', ur.buy_date); if(!bd) return;
    const bpStr = prompt('買價：', ur.buy_price); if(bpStr===null) return;
    const bp = parseFloat(bpStr); if(isNaN(bp) || bp<=0){ alert('買價無效'); return; }
    const unStr = prompt('股數：', ur.units); if(unStr===null) return;
    const un = parseFloat(unStr); if(isNaN(un) || un<=0){ alert('股數無效'); return; }
    const codeNew = prompt('股票代碼 (留空 = 不改)：', ur.code) || ur.code;
    ur.buy_date = bd; ur.buy_price = bp; ur.units = un; ur.buy_total = bp * un;
    if (codeNew !== ur.code && STATE.data.code_to_name[codeNew]){
      ur.code = codeNew;
      ur.name = STATE.data.code_to_name[codeNew];
    }
    saveUserRecords(); renderAll();
    alert('已更新買進資料');
  } else if (act==='4'){
    if (!isUser){ alert('Excel 原始紀錄不能在這裡刪，請改 Excel 後重跑 rebuild_data.py'); return; }
    deleteUserRecord(id);
  }
}

// ---------- 設定 ----------
function renderSettings(){
  $('#feeRate').value = STATE.fee.feeRate*100;
  $('#feeMin').value = STATE.fee.feeMin;
  $('#taxStock').value = STATE.fee.taxStock*100;
  $('#taxEtf').value = STATE.fee.taxEtf*100;
  $('#saveFee').onclick = () => {
    STATE.fee.feeRate = parseFloat($('#feeRate').value)/100 || 0.001425;
    STATE.fee.feeMin = parseFloat($('#feeMin').value) || 20;
    STATE.fee.taxStock = parseFloat($('#taxStock').value)/100 || 0.003;
    STATE.fee.taxEtf = parseFloat($('#taxEtf').value)/100 || 0.001;
    saveFee();
    renderAll();
    alert('已儲存');
  };
  // Google Sheets URL
  if ($('#sheetsUrl')){
    $('#sheetsUrl').value = STATE.sheetsUrl;
    $('#saveSheetsUrl').onclick = async () => {
      const url = $('#sheetsUrl').value.trim();
      STATE.sheetsUrl = url;
      localStorage.setItem('mystock.sheetsUrl', url);
      $('#sheetsUrlMsg').textContent = '儲存中…';
      if (url){
        const ok = await loadFromSheets();
        $('#sheetsUrlMsg').textContent = ok ? `✔ 從 Sheets 載入 ${STATE.data.records.length} 筆` : '✗ 連不上，請檢查 URL 與部署設定';
        $('#sheetsUrlMsg').className = ok ? 'small green' : 'small red';
        if (ok) renderAll();
      } else {
        $('#sheetsUrlMsg').textContent = '已清除';
      }
    };
    $('#copyShareLink').onclick = async () => {
      if (!STATE.sheetsUrl){ alert('請先填好 URL 並按「儲存並載入」'); return; }
      const baseUrl = window.location.origin + window.location.pathname;
      const shareUrl = baseUrl + '#sheets=' + encodeURIComponent(STATE.sheetsUrl);
      try {
        await navigator.clipboard.writeText(shareUrl);
        $('#sheetsUrlMsg').textContent = '✔ 已複製可分享連結到剪貼簿，到別的裝置貼上開啟即可自動帶入 URL';
        $('#sheetsUrlMsg').className = 'small green';
      } catch(e){
        prompt('手動複製這串網址：', shareUrl);
      }
    };
    $('#reloadSheets').onclick = async () => {
      $('#sheetsUrlMsg').textContent = '重新載入中…';
      const ok = await loadFromSheets();
      $('#sheetsUrlMsg').textContent = ok ? `✔ 已重新載入 (${STATE.data.records.length} 筆)` : '✗ 載入失敗';
      $('#sheetsUrlMsg').className = ok ? 'small green' : 'small red';
      if (ok) renderAll();
    };
  }
  $('#changePw').onclick = async () => {
    const a = $('#newPw').value, b = $('#newPw2').value;
    if (!a){ $('#pwMsg').textContent='請輸入密碼'; return; }
    if (a!==b){ $('#pwMsg').textContent='兩次密碼不同'; return; }
    if (a.length<4){ $('#pwMsg').textContent='密碼太短'; return; }
    localStorage.setItem('mystock.pwHash', await sha256(a));
    $('#newPw').value=''; $('#newPw2').value='';
    $('#pwMsg').textContent='已更新密碼，下次登入生效';
    $('#pwMsg').className='small green';
  };
  $('#exportSettings').onclick = () => {
    const obj = { prices:STATE.prices, fee:STATE.fee, forecast:STATE.forecast, userRecords:STATE.userRecords, overrides:STATE.overrides };
    const blob = new Blob([JSON.stringify(obj,null,2)], {type:'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='mystock-settings.json'; a.click();
  };
  $('#importSettings').onclick = () => $('#importFile').click();
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      if (obj.prices) STATE.prices = obj.prices;
      if (obj.fee) Object.assign(STATE.fee, obj.fee);
      if (obj.forecast) STATE.forecast = obj.forecast;
      if (obj.userRecords) STATE.userRecords = obj.userRecords;
      if (obj.overrides) STATE.overrides = obj.overrides;
      savePrices(STATE.priceMeta); saveFee(); saveForecast(); saveUserRecords(); saveOverrides();
      alert('已匯入');
      renderAll();
    } catch(err){ alert('匯入失敗：'+err.message); }
  };
  $('#clearAll').onclick = () => {
    if (!confirm('將清除：密碼、自訂股價、手續費、預估參數、新增交易、覆寫。要繼續嗎？')) return;
    ['mystock.pwHash','mystock.prices','mystock.priceMeta','mystock.fee','mystock.fc','mystock.userRecords','mystock.overrides'].forEach(k => localStorage.removeItem(k));
    location.reload();
  };
}

// ---------- Tabs ----------
function bindTabs(){
  $$('#nav button').forEach(b => {
    b.onclick = () => {
      $$('#nav button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      const tab = b.dataset.tab;
      $$('main > section').forEach(s => s.hidden = (s.id !== 'tab-'+tab));
      if (tab==='dash') renderDashboard();
      else if (tab==='holdings') renderHoldings();
      else if (tab==='trades') renderTrades();
      else if (tab==='dividends') renderDividends();
      else if (tab==='monthly') renderMonthly();
      else if (tab==='annual') renderAnnual();
      else if (tab==='prices') renderPrices();
      else if (tab==='add') renderAddTab();
      else if (tab==='settings') renderSettings();
    };
  });
  $$('#whoFilter button').forEach(b => {
    b.onclick = () => {
      $$('#whoFilter button').forEach(x=>x.classList.remove('active'));
      b.classList.add('active');
      STATE.who = b.dataset.who;
      $('#tradeStock').innerHTML='<option value="">全部股票</option>';
      $('#divStock').innerHTML='<option value="">全部股票</option>';
      $('#divYear').innerHTML='<option value="">全部年份</option>';
      renderAll();
    };
  });
  $('#hideEmpty').onchange = renderHoldings;
  const hw = $('#holdingsWho'); if (hw) hw.onchange = e => { _holdingsWhoOverride = e.target.value; renderHoldings(); };
  $$('#tradeStock,#tradeStatus').forEach(s => s.onchange = renderTrades);
  $$('#divStock,#divYear,#divKind').forEach(s => s.onchange = renderDividends);
  $('#logoutBtn').onclick = logout;
}

function renderAll(){
  renderDashboard();
  renderHoldings();
  renderTrades();
  renderDividends();
  renderMonthly();
  if (!$('#tab-annual').hidden) renderAnnual();
  if (!$('#tab-add').hidden) renderAddTab();
  $('#footStat').textContent = `Excel ${STATE.data.records.length} 筆 + 自建 ${STATE.userRecords.length} 筆 / ${Object.keys(STATE.data.code_to_name).length} 檔股票`;
}

async function initApp(){
  loadLocal();
  // 從網址 hash 取得 sheets URL（# 後面的 sheets=... 不會送到 server，安全）
  const m = (window.location.hash || '').match(/sheets=([^&]+)/);
  if (m){
    const urlFromHash = decodeURIComponent(m[1]);
    if (urlFromHash && urlFromHash !== STATE.sheetsUrl){
      STATE.sheetsUrl = urlFromHash;
      localStorage.setItem('mystock.sheetsUrl', urlFromHash);
      console.log('已從網址自動載入 Sheets URL');
    }
  }
  if (STATE.sheetsUrl){
    const ok = await loadFromSheets();
    if (ok) console.log('已從 Google Sheets 載入');
  }
  $('#updated').textContent = `資料更新 ${STATE.data.updated_at}`;
  bindTabs();
  renderAll();
}

(async () => {
  if (!localStorage.getItem('mystock.pwHash')){
    localStorage.setItem('mystock.pwHash', await sha256(DEFAULT_PASSWORD));
  }
  if (sessionStorage.getItem('mystock.unlocked')==='1') showApp();
  else initLogin();
})();
