/**
 * Google Apps Script Web App for mystock-tracker
 * 把這整段貼到 Apps Script 編輯器 (擴充功能 → Apps Script)，存檔後部署為 Web App
 *
 * 部署設定：
 *   - 執行身分：我（Execute as me）
 *   - 存取權限：任何人（Anyone）── 因為瀏覽器要打 API
 *   - 取得的 URL：填到網站「設定 → Google Sheets URL」
 */

const SHEET_NAME = '股票';

function doGet(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error(`找不到分頁「${SHEET_NAME}」`);

    const values = sheet.getDataRange().getValues();
    const records = [];

    for (let i = 1; i < values.length; i++) {
      const row = values[i];
      if (!row[0]) continue;  // who 欄空就跳過

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

    // 收集所有股票代號
    const codeToName = {};
    records.forEach(r => { if (r.code && r.name) codeToName[r.code] = r.name; });

    const data = {
      records: records,
      code_to_name: codeToName,
      etf_codes: ['0050','0056','00713','00878','00881','00919','00929','00937B'],
      latest_prices: {},
      updated_at: new Date().toISOString().slice(0,16).replace('T',' ')
    };

    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function fmtDate(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.length >= 10 ? d.substring(0,10) : null;
  if (d instanceof Date) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
