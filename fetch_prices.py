# -*- coding: utf-8 -*-
"""
從本機透過 TWSE 即時資訊 API 抓昨日收盤，輸出成 prices.json
HTML 端不會自動讀這個檔，你要把內容貼進「股價更新」分頁覆蓋。
（之後若要做自動讀檔再說）

用法：
  python fetch_prices.py

依賴：標準函式庫（不需要 pip install）
"""
import os, json, urllib.request, sys, time, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_JS = os.path.join(HERE, 'data.js')
OUT = os.path.join(HERE, 'prices.json')

# 從 data.js 讀代碼
with open(DATA_JS, 'r', encoding='utf-8') as f:
    js = f.read()
m = re.search(r'window\.STOCK_DATA\s*=\s*(\{.*\});', js, re.DOTALL)
data = json.loads(m.group(1))
codes = sorted(data['code_to_name'].keys())

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

def fetch(ch_list):
    url = f"https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch={ch_list}&json=1&delay=0&_={int(time.time()*1000)}"
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp',
        'Accept': 'application/json,*/*',
    })
    try:
        # 先打一下 session
        urllib.request.urlopen(urllib.request.Request('https://mis.twse.com.tw/stock/index.jsp',
            headers={'User-Agent': UA}), timeout=10).read()
    except Exception:
        pass
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def parse_resp(resp, found, updates, price_date_box):
    for m in resp.get('msgArray', []) or []:
        c = m.get('c')
        try: z = float(m.get('z') or 0)
        except: z = 0
        try: y = float(m.get('y') or 0)
        except: y = 0
        price = z if z > 0 else (y if y > 0 else None)
        if price:
            updates[c] = price
            found.add(c)
            d = m.get('d') or ''
            if d and not price_date_box[0]:
                price_date_box[0] = d

found = set()
updates = {}
price_date_box = ['']

print(f'查 {len(codes)} 檔（先試上市）…')
ch1 = '|'.join([f'tse_{c}.tw' for c in codes])
try:
    parse_resp(fetch(ch1), found, updates, price_date_box)
except Exception as e:
    print('上市失敗：', e)

missing = [c for c in codes if c not in found]
if missing:
    print(f'查 {len(missing)} 檔（試上櫃）…')
    ch2 = '|'.join([f'otc_{c}.tw' for c in missing])
    try:
        parse_resp(fetch(ch2), found, updates, price_date_box)
    except Exception as e:
        print('上櫃失敗：', e)

if not updates:
    print('沒抓到任何報價，可能是非交易時間或被擋。')
    sys.exit(1)

date_str = price_date_box[0]
if date_str and len(date_str) == 8:
    date_str = f'{date_str[:4]}-{date_str[4:6]}-{date_str[6:8]}'

out = {
    'updated_at': time.strftime('%Y-%m-%d %H:%M'),
    'price_date': date_str,
    'prices': updates,
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)

print(f"\n抓到 {len(updates)}/{len(codes)} 檔，報價日 {date_str}")
for c in codes:
    name = data['code_to_name'][c]
    p = updates.get(c, '— (沒抓到)')
    print(f'  {c} {name:<14} {p}')
print(f"\n已寫入 {OUT}")
print('打開 prices.json，把裡面的數字貼到網站「股價更新」分頁；或下次更新等網站用 CORS proxy 直接抓。')
