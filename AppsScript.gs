/**
 * Google Apps Script Web App for mystock-tracker
 * 把這整段貼到 Apps Script 編輯器 (擴充功能 → Apps Script)，存檔後部署為 Web App
 *
 * 提供兩種功能：
 *   1. 讀 Google Sheets 資料        (預設 / ?action=read)
 *   2. 從 TWSE 抓最新股價           (?action=prices&codes=2330,2002,0050)
 *
 * 部署設定：
 *   - 執行身分：我（Execute as me）
 *   - 存取權限：任何人（Anyone）
 *   - 取得的 URL：填到網站「設定 → Google Sheets URL」
 */

const SHEET_NAME = '股票';

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'read';
  try {
    if (action === 'prices') return doFetchPrices(e);
    return doRead();
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

// ─── 讀 Google Sheets ──────────────────────────────────
function doRead() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`找不到分頁「${SHEET_NAME}」`);

  const values = sheet.getDataRange().getValues();
  const records = [];

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue;

    const [who, year, buyDate, name, code, buyPrice, units, buyTotal,
           sellDate, sellPrice, sellUnits, sellTotal, dividend, exDate] = row;

    let unitsRound = units;
    if (who === '配股' && typeof units === 'number') unitsRound = Math.round(units);

    records.push({
      who: who,
      year: typeof year === 'number' ? year : null,
      buy_date: fmtDate(buyDate),
      name: name || null,
      code: code != null ? String(code) : null,
      buy_price: numOrNull(buyPrice),
      units: numOrNull(unitsRound),
      buy_total: numOrNull(buyTotal),
      sell_date: fmtDate(sellDate),
      sell_price: numOrNull(sellPrice),
      sell_units: numOrNull(sellUnits),
      sell_total: numOrNull(sellTotal),
      dividend: numOrNull(dividend),
      ex_date: fmtDate(exDate)
    });
  }

  const codeToName = {};
  records.forEach(r => { if (r.code && r.name) codeToName[r.code] = r.name; });

  return jsonOut({
    records: records,
    code_to_name: codeToName,
    etf_codes: ['0050','0056','00713','00878','00881','00919','00929','00937B'],
    latest_prices: {},
    updated_at: new Date().toISOString().slice(0,16).replace('T',' ')
  });
}

// ─── 從 TWSE 抓股價 ────────────────────────────────────
function doFetchPrices(e) {
  const codesStr = (e && e.parameter && e.parameter.codes) || '';
  const mode = (e && e.parameter && e.parameter.mode) || 'auto'; // live / yesterday / auto
  if (!codesStr) throw new Error('缺少 codes 參數');
  const codes = codesStr.split(',').map(c => c.trim()).filter(Boolean);

  const updates = {};
  const found = new Set();
  let priceDate = '';
  const errors = [];

  // 先試 mis.twse 即時 (上市)
  try {
    const tseList = codes.map(c => `tse_${c}.tw`).join('|');
    const r = parseTWSE(fetchTWSE(tseList), mode);
    Object.assign(updates, r.updates);
    r.foundCodes.forEach(c => found.add(c));
    if (r.priceDate && !priceDate) priceDate = r.priceDate;
  } catch (err) { errors.push('tse-mis: ' + err.message); }

  // 試上櫃
  const missing1 = codes.filter(c => !found.has(c));
  if (missing1.length > 0) {
    try {
      const otcList = missing1.map(c => `otc_${c}.tw`).join('|');
      const r = parseTWSE(fetchTWSE(otcList), mode);
      Object.assign(updates, r.updates);
      r.foundCodes.forEach(c => found.add(c));
      if (r.priceDate && !priceDate) priceDate = r.priceDate;
    } catch (err) { errors.push('otc-mis: ' + err.message); }
  }

  // 還是沒抓到的話走 OpenAPI 收盤備援
  const missing2 = codes.filter(c => !found.has(c));
  if (missing2.length > 0) {
    try {
      const r = fetchOpenAPI(missing2);
      Object.assign(updates, r.updates);
      r.foundCodes.forEach(c => found.add(c));
      if (r.priceDate && !priceDate) priceDate = r.priceDate;
    } catch (err) { errors.push('openapi: ' + err.message); }
  }

  if (priceDate && priceDate.length === 8) {
    priceDate = priceDate.substring(0,4) + '-' + priceDate.substring(4,6) + '-' + priceDate.substring(6,8);
  }

  return jsonOut({
    prices: updates,
    price_date: priceDate || new Date().toISOString().slice(0,10),
    found_count: Object.keys(updates).length,
    total: codes.length,
    missing: codes.filter(c => !found.has(c)),
    errors: errors
  });
}

function fetchTWSE(chList) {
  // Apps Script 的 UrlFetchApp 不接受未編碼的 |，要 encode 成 %7C
  const encChList = chList.replace(/\|/g, '%7C');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encChList}&json=1&delay=0&_=${Date.now()}`;
  // retry 3 次（TWSE 偶爾擋 Google IP）
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
          'Accept': 'application/json,*/*'
        },
        muteHttpExceptions: true,
        followRedirects: true
      });
      const code = response.getResponseCode();
      if (code === 200) return JSON.parse(response.getContentText());
      lastErr = new Error('HTTP ' + code);
    } catch (err) { lastErr = err; }
    if (attempt < 2) Utilities.sleep(500);
  }
  throw lastErr || new Error('TWSE 無回應');
}

// 用 TWSE OpenAPI 抓「上市股票每日收盤」，取需要的代碼
// 較穩定但只有日終資料（盤中拿到的是前一日）
function fetchOpenAPI(codes) {
  const url = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
  const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error('HTTP ' + response.getResponseCode());
  const arr = JSON.parse(response.getContentText());
  const updates = {};
  const foundCodes = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    if (codes.indexOf(it.Code) >= 0) {
      const cp = parseFloat(it.ClosingPrice);
      if (cp > 0) {
        updates[it.Code] = cp;
        foundCodes.push(it.Code);
      }
    }
  }
  return { updates, foundCodes, priceDate: new Date().toISOString().slice(0,10).replace(/-/g,'') };
}

function parseTWSE(data, mode) {
  const updates = {};
  const foundCodes = [];
  let priceDate = '';
  if (data && data.msgArray) {
    for (let i = 0; i < data.msgArray.length; i++) {
      const m = data.msgArray[i];
      const z = parseFloat(m.z);
      const y = parseFloat(m.y);
      let price;
      if (mode === 'live') price = z > 0 ? z : (y > 0 ? y : NaN);
      else if (mode === 'yesterday') price = y > 0 ? y : (z > 0 ? z : NaN);
      else price = z > 0 ? z : (y > 0 ? y : NaN);
      if (!isNaN(price)) {
        updates[m.c] = price;
        foundCodes.push(m.c);
        if (m.d && !priceDate) priceDate = m.d;
      }
    }
  }
  return { updates, foundCodes, priceDate };
}

// ─── 授權測試 ──────────────────────────────────────────
// 第一次部署或新增 UrlFetchApp 權限後，在編輯器手動執行這個函式
// 會跳出授權對話框，要點「進階 → 允許」勾選「以您的名義連線到外部服務」
// 授權通過後 doFetchPrices 才能正常工作
function testFetch() {
  const r = UrlFetchApp.fetch('https://www.google.com');
  Logger.log('狀態碼: ' + r.getResponseCode());
  Logger.log('應該看到 200，代表外部 URL 權限已通');
}

// ─── helpers ──────────────────────────────────────────
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// 用「試算表的時區」來格式化日期，避免 Apps Script 預設時區與試算表不同造成日期 -1 天
// （例如試算表是 Asia/Taipei，但 script 是 Etc/GMT 時，4/1 會變成 3/31）
function fmtDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.length >= 10 ? d.substring(0,10) : null;
  if (d instanceof Date) {
    var tz;
    try { tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); } catch (e) { tz = 'Asia/Taipei'; }
    return Utilities.formatDate(d, tz || 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return null;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
