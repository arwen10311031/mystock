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
  const callback = e && e.parameter && e.parameter.callback;  // JSONP callback 名稱
  try {
    let out;
    if (action === 'prices') out = doFetchPrices(e);
    else out = doRead();
    return wrapOut(out, callback);
  } catch (err) {
    return wrapOut(jsonOut({ error: err.message }), callback);
  }
}

// 如果有帶 callback（JSONP），把 JSON 包成 callback(...) 並用 JS mimetype 回傳
// 沒帶就回原本的 JSON（給直接打網址 / fetch 用）
function wrapOut(textOutput, callback) {
  if (!callback) return textOutput;
  const json = textOutput.getContent();
  return ContentService
    .createTextOutput(callback + '(' + json + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// 寫入：append (新增列) 或 update (改某列特定欄位)
// 為了避免 CORS preflight，前端用 Content-Type: text/plain 送 JSON
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) throw new Error('沒有 POST body');
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';
    if (action === 'append') return doAppendRow(body);
    if (action === 'update') return doUpdateRow(body);
    if (action === 'delete') return doDeleteRow(body);
    throw new Error('未知 action: ' + action);
  } catch (err) {
    return jsonOut({ error: err.message });
  }
}

function doAppendRow(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('找不到分頁「' + SHEET_NAME + '」');
  const r = body.row || {};
  const rowData = [
    r.who || '',
    r.year != null ? r.year : '',
    r.buy_date || '',
    r.name || '',
    r.code != null ? String(r.code) : '',
    r.buy_price != null ? r.buy_price : '',
    r.units != null ? r.units : '',
    r.buy_total != null ? r.buy_total : '',
    r.sell_date || '',
    r.sell_price != null ? r.sell_price : '',
    r.sell_units != null ? r.sell_units : '',
    r.sell_total != null ? r.sell_total : '',
    r.dividend != null ? r.dividend : '',
    r.ex_date || ''
  ];
  const newRow = sheet.getLastRow() + 1;

  // 先寫整列（代碼欄先留空，避免 setValues 自動偵測把 00919 變 919）
  const rowDataNoCode = rowData.slice();
  rowDataNoCode[4] = '';   // 代碼欄(第5欄)先空著
  sheet.getRange(newRow, 1, 1, rowDataNoCode.length).setValues([rowDataNoCode]);

  // 文字欄位（代碼 + 三個日期）：明確設文字格式 → flush → 單獨寫值
  const codeCell = sheet.getRange(newRow, 5);
  codeCell.setNumberFormat('@');
  sheet.getRange(newRow, 3).setNumberFormat('@');
  sheet.getRange(newRow, 9).setNumberFormat('@');
  sheet.getRange(newRow, 14).setNumberFormat('@');
  SpreadsheetApp.flush();
  // 用 setValue（單格）寫代碼，文字格式下 00919 會原樣保留
  codeCell.setValue(String(r.code != null ? r.code : ''));
  SpreadsheetApp.flush();

  return jsonOut({ ok: true, action: 'append', row: r, row_idx: newRow });
}

function doUpdateRow(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('找不到分頁「' + SHEET_NAME + '」');
  const rowIdx = parseInt(body.row_idx, 10);
  if (!rowIdx || rowIdx < 2) throw new Error('row_idx 無效：' + body.row_idx);
  const fields = body.fields || {};
  // 欄位 → 1-indexed column
  const colMap = {
    who: 1, year: 2, buy_date: 3, name: 4, code: 5,
    buy_price: 6, units: 7, buy_total: 8,
    sell_date: 9, sell_price: 10, sell_units: 11, sell_total: 12,
    dividend: 13, ex_date: 14
  };
  const updated = {};
  for (const key in fields) {
    const col = colMap[key];
    if (!col) continue;
    const v = fields[key];
    sheet.getRange(rowIdx, col).setValue(v == null ? '' : v);
    updated[key] = v;
  }
  return jsonOut({ ok: true, action: 'update', row_idx: rowIdx, updated: updated });
}

function doDeleteRow(body) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('找不到分頁「' + SHEET_NAME + '」');
  const rowIdx = parseInt(body.row_idx, 10);
  if (!rowIdx || rowIdx < 2) throw new Error('row_idx 無效：' + body.row_idx);
  // 防呆：可選 expect_code/expect_name 比對，避免因 row_idx 對不上而刪錯
  if (body.expect_code != null || body.expect_name != null) {
    const cur = sheet.getRange(rowIdx, 1, 1, 5).getValues()[0];
    const curCode = String(cur[4] == null ? '' : cur[4]);
    const curName = String(cur[3] == null ? '' : cur[3]);
    if (body.expect_code != null && curCode !== String(body.expect_code)) {
      throw new Error('防呆失敗：第 ' + rowIdx + ' 列代碼是 ' + curCode + '，跟預期 ' + body.expect_code + ' 不符，已取消刪除');
    }
    if (body.expect_name != null && curName !== String(body.expect_name)) {
      throw new Error('防呆失敗：第 ' + rowIdx + ' 列名稱是 ' + curName + '，跟預期 ' + body.expect_name + ' 不符，已取消刪除');
    }
  }
  sheet.deleteRow(rowIdx);
  return jsonOut({ ok: true, action: 'delete', row_idx: rowIdx });
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
      row_idx: i + 1,    // 該紀錄在 sheet 中的列號（1-indexed，第一列是 header）
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
  const fromCache = new Set();   // 哪些是從 cache 拿的（標出來給前端知道）
  let priceDate = '';
  const errors = [];

  // ── 步驟 1：Yahoo Finance（即時、Google IP 不會被擋，當主力）──────
  const liveUpdates = {};   // 只記這次從即時 API 拿到的，等下才寫 cache（避免 OpenAPI 污染）

  try {
    const r = fetchYahoo(codes);
    Object.assign(updates, r.updates);
    Object.assign(liveUpdates, r.updates);
    r.foundCodes.forEach(c => found.add(c));
    if (r.priceDate && !priceDate) priceDate = r.priceDate;
  } catch (err) { errors.push('yahoo: ' + err.message); }

  // ── 步驟 1.5：TSE / OTC MIS 即時 API（Yahoo 抓不到的、或當補強）
  const missingAfterYahoo = codes.filter(function(c){ return !found.has(c); });
  if (missingAfterYahoo.length > 0) {
    try {
      const tseList = missingAfterYahoo.map(c => `tse_${c}.tw`).join('|');
      const r = parseTWSE(fetchTWSE(tseList), mode);
      Object.assign(updates, r.updates);
      Object.assign(liveUpdates, r.updates);
      r.foundCodes.forEach(c => found.add(c));
      if (r.priceDate && !priceDate) priceDate = r.priceDate;
    } catch (err) { errors.push('tse-mis: ' + err.message); }

    const missingAfterTse = codes.filter(function(c){ return !found.has(c); });
    if (missingAfterTse.length > 0) {
      try {
        const otcList = missingAfterTse.map(c => `otc_${c}.tw`).join('|');
        const r = parseTWSE(fetchTWSE(otcList), mode);
        Object.assign(updates, r.updates);
        Object.assign(liveUpdates, r.updates);
        r.foundCodes.forEach(c => found.add(c));
        if (r.priceDate && !priceDate) priceDate = r.priceDate;
      } catch (err) { errors.push('otc-mis: ' + err.message); }
    }
  }

  // ── 步驟 2：把這次即時 API（TSE/OTC/Yahoo）成功的價格寫進 cache（OpenAPI 不寫）
  try {
    if (Object.keys(liveUpdates).length > 0) {
      savePriceCache(liveUpdates, priceDate || todayStr_());
    }
  } catch (err) { errors.push('cache-save: ' + err.message); }

  // ── 步驟 3：MIS 抓不到的，先查 cache（裡面是過去任何一次 MIS 成功的價）
  // 比 OpenAPI 可信，因為 OpenAPI 可能還沒上傳今天的檔案
  try {
    const stillMissing1 = codes.filter(function(c){ return !found.has(c); });
    if (stillMissing1.length > 0) {
      const cached = loadPriceCache(stillMissing1) || {};
      for (const c of stillMissing1) {
        const entry = cached[c];
        if (entry && typeof entry.price === 'number' && entry.price > 0) {
          updates[c] = entry.price;
          found.add(c);
          fromCache.add(c);
        }
      }
    }
  } catch (err) { errors.push('cache-load: ' + err.message); }

  // ── 步驟 4：cache 也沒有的最後手段：OpenAPI 收盤檔（可能是昨日資料，不寫 cache）
  const stillMissing2 = codes.filter(function(c){ return !found.has(c); });
  if (stillMissing2.length > 0) {
    try {
      const r = fetchOpenAPI(stillMissing2);
      Object.assign(updates, r.updates);
      r.foundCodes.forEach(c => found.add(c));
      if (r.priceDate && !priceDate) priceDate = r.priceDate;
      r.foundCodes.forEach(c => fromCache.add(c));   // 用 fromCache 旗標標示，提醒這是「非即時」來源
    } catch (err) { errors.push('openapi: ' + err.message); }
  }

  if (priceDate && priceDate.length === 8) {
    priceDate = priceDate.substring(0,4) + '-' + priceDate.substring(4,6) + '-' + priceDate.substring(6,8);
  }

  return jsonOut({
    prices: updates,
    price_date: priceDate || new Date().toISOString().slice(0,10),
    from_cache: Array.from(fromCache),
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

// 從 Yahoo Finance 抓即時價（query1.finance.yahoo.com/v8/finance/chart）
// 沒有官方文件保證，但目前免費可用、不需要 API key、Apps Script IP 沒被擋
// 上市用 .TW 後綴、上櫃用 .TWO；先全部試 .TW，沒抓到再試 .TWO
function fetchYahoo(codes) {
  const updates = {};
  const foundCodes = [];
  let priceDate = '';
  const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };

  function batch(symList, suffix) {
    const reqs = symList.map(function(c){
      return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + c + suffix + '?interval=1d&range=2d',
               muteHttpExceptions: true, headers: headers };
    });
    var responses;
    try { responses = UrlFetchApp.fetchAll(reqs); } catch (e) { return []; }
    const stillMissing = [];
    responses.forEach(function(res, i){
      const code = symList[i];
      if (res.getResponseCode() !== 200) { stillMissing.push(code); return; }
      try {
        const obj = JSON.parse(res.getContentText());
        const result = obj && obj.chart && obj.chart.result && obj.chart.result[0];
        if (!result) { stillMissing.push(code); return; }
        const meta = result.meta;
        const p = meta && parseFloat(meta.regularMarketPrice);
        if (!(p > 0)) { stillMissing.push(code); return; }
        updates[code] = p;
        foundCodes.push(code);
        if (meta.regularMarketTime && !priceDate) {
          priceDate = Utilities.formatDate(new Date(meta.regularMarketTime * 1000), _ssTz_(), 'yyyyMMdd');
        }
      } catch (e) { stillMissing.push(code); }
    });
    return stillMissing;
  }

  // 第一輪：.TW（上市）
  const missingAfterTW = batch(codes, '.TW');
  // 第二輪：剩下的用 .TWO（上櫃）
  if (missingAfterTW.length > 0) batch(missingAfterTW, '.TWO');

  return { updates: updates, foundCodes: foundCodes, priceDate: priceDate };
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

// ─── 寫入授權測試 ──────────────────────────────────────
// 新增 doPost（寫入 Sheets）後，第一次要在編輯器手動執行這個函式
// 會跳出授權對話框，要點「進階 → 允許」勾「以您的名義查看及管理試算表」
// 授權通過後，網站的「➕ 新增」才寫得進 Sheets
function testWrite() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('找不到分頁 ' + SHEET_NAME); return; }
  // 寫一列測試資料到最後，再馬上刪掉（只是為了觸發寫入授權）
  const before = sheet.getLastRow();
  sheet.appendRow(['__TEST__', '', '', '寫入測試', '', '', '', '', '', '', '', '', '', '']);
  const after = sheet.getLastRow();
  Logger.log('寫入測試列：' + before + ' → ' + after);
  // 刪掉剛剛那列
  sheet.deleteRow(after);
  Logger.log('已刪除測試列，寫入權限 OK');
}

// ─── helpers ──────────────────────────────────────────
function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─── 價格 cache（PropertiesService 永久保存）──────────────────
// 把每次成功抓到的股價存起來，下次如果某些代碼抓不到就用上次的值
// PropertiesService 每個 property 上限 9KB、整個 script 500KB，存幾百檔股價沒問題
function savePriceCache(updates, priceDate) {
  if (!updates || typeof updates !== 'object') return;
  const props = PropertiesService.getScriptProperties();
  const items = {};
  const keys = Object.keys(updates);
  for (var i = 0; i < keys.length; i++) {
    const code = keys[i];
    const p = updates[code];
    if (p == null || isNaN(p) || p <= 0) continue;
    items['lp_' + code] = JSON.stringify({ price: p, date: priceDate || '', ts: Date.now() });
  }
  if (Object.keys(items).length > 0) props.setProperties(items, false);
}

// 一次性修復：把被吃掉開頭 0 的代碼補回來（在編輯器手動執行一次）
// 原理：用「股票名稱」對照，從有正確代碼（開頭 0 還在）的列建 name→code 表，
//       再把代碼跟正確值不符的列改回來
function repairCodes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  const values = sheet.getDataRange().getValues();

  // 建 name → 正確代碼（優先採用開頭是 0 的文字代碼）
  const nameToCode = {};
  for (var i = 1; i < values.length; i++) {
    const name = values[i][3];   // D 欄 股票名稱
    const code = values[i][4];   // E 欄 代碼
    if (!name || code == null || code === '') continue;
    const codeStr = String(code);
    if (codeStr.length >= 4 && codeStr.charAt(0) === '0') {
      nameToCode[name] = codeStr;   // 像 00919 / 0050 這種完整的
    }
  }

  // 把代碼跟正確值不符的列改回來
  var fixed = 0;
  const detail = [];
  for (var j = 1; j < values.length; j++) {
    const name = values[j][3];
    const code = values[j][4];
    if (!name || code == null || code === '') continue;
    const correct = nameToCode[name];
    if (correct && String(code) !== correct) {
      const cell = sheet.getRange(j + 1, 5);
      cell.setNumberFormat('@');
      cell.setValue(correct);
      fixed++;
      detail.push((j + 1) + ': ' + name + ' ' + code + ' → ' + correct);
    }
  }
  SpreadsheetApp.flush();
  Logger.log('修正了 ' + fixed + ' 列');
  detail.forEach(function(d){ Logger.log('  ' + d); });
  return fixed;
}

// 清掉所有股價 cache（在編輯器手動執行一次即可）
// 上次部署時 OpenAPI 的舊收盤價可能還在 cache 裡污染結果
function clearPriceCache() {
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const toDelete = [];
  for (const k in all) {
    if (k.indexOf('lp_') === 0) toDelete.push(k);
  }
  toDelete.forEach(function(k){ props.deleteProperty(k); });
  Logger.log('cleared cache keys: ' + toDelete.length);
  return toDelete.length;
}

function loadPriceCache(codes) {
  const result = {};
  if (!codes || !codes.length) return result;
  const props = PropertiesService.getScriptProperties();
  for (var i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (!code) continue;
    const v = props.getProperty('lp_' + code);
    if (!v) continue;
    try {
      const obj = JSON.parse(v);
      if (obj && typeof obj.price === 'number' && obj.price > 0) {
        result[code] = obj;
      }
    } catch (e) {}
  }
  return result;
}

// 把試算表裡各種可能的日期格式都正規化成 'YYYY-MM-DD'
//   - Date 物件：用試算表時區格式化（避免時區漂移）
//   - 數字（Excel/Sheets serial number）：例如 45718 → 2025-03-12
//   - 字串：'2026-3-3', '2026/3/3', '2026.3.3', '2026年3月3日' 等都接
//   - 其他：用 Date.parse 試試
function _ssTz_(){
  try { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone() || 'Asia/Taipei'; }
  catch (e) { return 'Asia/Taipei'; }
}
function todayStr_(){
  return Utilities.formatDate(new Date(), _ssTz_(), 'yyyy-MM-dd');
}
function _pad2_(n){ n = String(n); return n.length < 2 ? '0' + n : n; }
function fmtDate(d) {
  if (d == null || d === '') return null;

  // Date 物件
  if (d instanceof Date) {
    if (isNaN(d.getTime())) return null;
    return Utilities.formatDate(d, _ssTz_(), 'yyyy-MM-dd');
  }

  // 數字 → 視為 Sheets serial number（自 1899-12-30 起算）
  if (typeof d === 'number'){
    if (d > 1 && d < 100000){
      // 25569 = 1899-12-30 到 1970-01-01 的天數差
      var ms = (d - 25569) * 86400000;
      var dt = new Date(ms);
      return Utilities.formatDate(dt, _ssTz_(), 'yyyy-MM-dd');
    }
    return null;
  }

  // 字串：抓出年月日
  if (typeof d === 'string'){
    var s = d.trim();
    if (!s) return null;
    // 常見格式：YYYY-M-D / YYYY/M/D / YYYY.M.D / YYYY年M月D日
    var m = s.match(/^(\d{4})\D(\d{1,2})\D(\d{1,2})/);
    if (m) return m[1] + '-' + _pad2_(m[2]) + '-' + _pad2_(m[3]);
    // 民國年：114/03/03 → 2025-03-03
    m = s.match(/^(\d{2,3})\D(\d{1,2})\D(\d{1,2})/);
    if (m){
      var roc = parseInt(m[1], 10);
      if (roc > 0 && roc < 200){
        return (roc + 1911) + '-' + _pad2_(m[2]) + '-' + _pad2_(m[3]);
      }
    }
    // 最後 fallback：交給 Date.parse
    var t = Date.parse(s);
    if (!isNaN(t)){
      return Utilities.formatDate(new Date(t), _ssTz_(), 'yyyy-MM-dd');
    }
    return null;
  }

  return null;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
