#!/usr/bin/env node
/**
 * 皮諾可 UShow 報表自動更新腳本
 *
 * node update_pinoko.js full   → 全量更新（凌晨 1:00）
 * node update_pinoko.js today  → 只更新今日銷售（13:00~01:00 每小時）
 */

const IS_CLOUD = !!process.env.GITHUB_ACTIONS;
const { chromium } = IS_CLOUD
  ? require('playwright')
  : require('/Users/chun/Library/Mobile Documents/com~apple~CloudDocs/下載項目/chun/stock-screener/node_modules/playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASE_DIR = IS_CLOUD ? __dirname : '/Users/chun/Desktop/台南浪漫';
const PINOKO_WEB_DIR = IS_CLOUD ? __dirname : '/Users/chun/Desktop/pinoko-web';
const MODE = process.argv[2] || 'today';

// ── 時間工具 ──────────────────────────────────────────────────────────────────

function getTaipeiNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function dayBeginStr(d) {
  // UShow DayBegin/DayEnd 格式：YYYY-M-D（不補零）
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}
function displayTime(d) {
  const h = d.getHours(), m = String(d.getMinutes()).padStart(2,'0');
  return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${h<12?'上午':'下午'}${h%12||12}:${m}`;
}
function getBusinessDate(now) {
  // 凌晨 6 點前視為前一個業務日
  if (now.getHours() < 6) {
    const prev = new Date(now.getTime());
    prev.setDate(prev.getDate() - 1);
    return prev;
  }
  return now;
}

// ── 路徑工具 ──────────────────────────────────────────────────────────────────

function monthDir(year, month) {
  return path.join(BASE_DIR, String(year), `${month}月`);
}
function ensureDir(year, month) {
  if (IS_CLOUD) return PINOKO_WEB_DIR;
  const d = monthDir(year, month);
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); console.log('建立資料夾:', d); }
  return d;
}

// ── API 工具 ──────────────────────────────────────────────────────────────────

function httpGet(apiPath, token) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.ushowpos.com', path: apiPath, headers: { 'Authorization': `Bearer ${token}` } }, res => {
      let d = ''; res.on('data', c => d+=c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve([]); } });
    }).on('error', reject);
  });
}

function postApi(endpoint, body, token) {
  return new Promise((resolve, reject) => {
    const pd = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.ushowpos.com', path: `/api/reports/${endpoint}`, method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd) }
    }, res => {
      let d = ''; res.on('data', c => d+=c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error(d.substring(0,200))); } });
    });
    req.on('error', reject); req.write(pd); req.end();
  });
}

function postDirect(path, body, token) {
  return new Promise((resolve, reject) => {
    const pd = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.ushowpos.com', path, method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(pd) }
    }, res => {
      let d = ''; res.on('data', c => d+=c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve({}); } });
    });
    req.on('error', reject); req.write(pd); req.end();
  });
}

async function fetchProductCatalog(token) {
  const all = []; let page = 1;
  while (true) {
    const r = await postDirect('/api/foods/pages', { showMainFood: true, IsShowOffSale: true, page, pagesize: 200, sortName: null }, token);
    const datas = r.Datas || r.datas || [];
    if (!datas.length) break;
    all.push(...datas);
    if (!r.Pagination?.HasNext) break;
    page++;
  }
  return all;
}

// DayBegin/DayEnd 格式（品牌、商品、代支）
function dayBody(begin, end, page=1, size=200) {
  return { DayBegin: begin, DayEnd: end, Page: page, PageSize: size, ReportType: null, IsReturn: false, SortName: null, IsDesc: 0 };
}

async function fetchDayPages(endpoint, begin, end, token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await postApi(endpoint, dayBody(begin, end, page, 200), token);
    if (!r.Datas?.length) break;
    all.push(...r.Datas);
    if (all.length >= r.Pagination.Counts) break;
    page++;
  }
  return all;
}

async function fetchTimeStatistic(begin, end, token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await postApi('timestatistic', {
      DayBegin: begin, DayEnd: end, Page: page, PageSize: 25,
      ReportType: 'statistic', IsReturn: false, SortName: null, IsDesc: 0
    }, token);
    if (!r.Datas?.length) break;
    all.push(...r.Datas);
    if (all.length >= r.Pagination.Counts) break;
    page++;
  }
  return all.sort((a, b) => parseInt(a.Time) - parseInt(b.Time));
}

// BeginDate/EndDate 格式（sale 每日彙總）
function saleBody(begin, end, page=1, size=200) {
  return { BeginDate: begin, EndDate: end, PageSize: size, CurrentPage: page };
}

async function fetchSalePages(begin, end, token) {
  const all = [];
  let page = 1;
  while (true) {
    const r = await postApi('sale', saleBody(begin, end, page, 200), token);
    if (!r.Datas?.length) break;
    all.push(...r.Datas);
    if (all.length >= r.Pagination.Counts) break;
    page++;
  }
  return all;
}

// ── 登入 ──────────────────────────────────────────────────────────────────────

async function getToken() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto('https://cloud-v2.ushowpos.com/login');
    await page.waitForLoadState('networkidle');
    await page.fill('input[type="text"]', process.env.USHOW_ACCOUNT || '00427000');
    await page.fill('input[type="password"]', process.env.USHOW_PASSWORD || 'abc00427000');
    await page.click('button:has-text("登入")');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    if (!token) throw new Error('找不到 token');
    return token;
  } finally { await browser.close(); }
}

// ── 商品種類 → 品牌對照表 ─────────────────────────────────────────────────────

const BRAND_MAP_ID = {
  '61bf5fda-b382-4bc6-8385-ded7da326085': '1000',
  'a60ec942-7ddd-4f70-8d92-21e2440f9740': '2000',
  'e8ee982c-3fbb-47f0-917b-98063a721220': '3000',
  'add0e1e4-1e8f-4081-af55-f5fd9aa9d450': '4000',
};

async function buildKindBrandMap(token) {
  const kinds = await httpGet('/api/foodkinds/names', token);
  const map = {};
  (Array.isArray(kinds) ? kinds : []).forEach(k => {
    const brand = BRAND_MAP_ID[k.FoodMajorKindId];
    if (brand) map[k.FoodKindNumber] = brand;
  });
  return map; // FoodKindNumber → brand code (1000/2000/3000/4000)
}

// ── 品牌設定 ──────────────────────────────────────────────────────────────────

const BRANDS = [
  { code: '1000', name: '皮諾可',          color: '#5B8FF9', emoji: '🧋' },
  { code: '2000', name: '台南美好事物放送局', color: '#5AD8A6', emoji: '🛍️' },
  { code: '3000', name: '世界漂亮在台協會',  color: '#F6BD16', emoji: '🌏' },
];
const SKIP_KIND = new Set(['折扣','折讓','招待','貼紙促銷','訂金','自訂商品']);

// ── 今日銷售 HTML ─────────────────────────────────────────────────────────────

function buildTodayHtml(data, updatedAt, dateLabel) {
  const { todayTotal, brandToday, todayExpense, todaySheets, productsByBrand, hourlyToday } = data;
  const net = todayTotal - todayExpense;

  const statsCards = BRANDS.map(b => {
    const v = brandToday[b.code]||0, pct = todayTotal>0?(v/todayTotal*100).toFixed(1):'0.0';
    return `<div class="stat-card"><div class="label">${b.name}</div><div class="value" style="color:${b.color}">$${v.toLocaleString()}</div><div class="sub">${pct}%</div></div>`;
  }).join('');

  const tables = BRANDS.map(b => {
    const prods = productsByBrand[b.code]||[];
    if (!prods.length) return '';
    const rows = prods.map((p,i) => {
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`<span style="color:#aaa">#${i+1}</span>`;
      const pct = todaySheets>0?(p.Times/todaySheets*100).toFixed(1):0;
      const bar = todaySheets>0?Math.min(p.Times/todaySheets*300,100).toFixed(1):0;
      return `<tr><td style="text-align:center;font-size:13px;padding:8px 10px">${medal}</td><td style="padding:8px 10px">${p.FoodName}</td><td style="text-align:right;padding:8px 10px;font-weight:600">${p.Qty}</td><td style="text-align:right;padding:8px 10px">$${(p.Total||0).toLocaleString()}</td><td style="padding:8px 10px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:7px;background:#eee;border-radius:4px;overflow:hidden;min-width:60px"><div style="height:100%;background:${b.color};width:${bar}%;border-radius:4px"></div></div><span style="min-width:40px;font-size:12px;color:${b.color};font-weight:600">${pct}%</span></div></td></tr>`;
    }).join('');
    return `<div class="chart-card"><div class="brand-header"><span style="font-size:20px">${b.emoji}</span><h2 style="margin-bottom:0">${b.name}｜今日商品銷量排名</h2><span class="brand-badge" style="background:${b.color}">${prods.length} 項</span></div><div class="sub-note">點擊率 = 含此商品訂單數 ÷ 今日總筆數（${todaySheets} 筆）</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px"><table class="ranking-table"><thead><tr><th style="width:42px">排名</th><th>商品</th><th style="text-align:right">銷量</th><th style="text-align:right">銷售額</th><th style="min-width:140px">點擊率</th></tr></thead><tbody>${rows}</tbody></table><div><canvas id="chart_today_rank_${b.code}" style="max-height:400px"></canvas></div></div></div>`;
  }).join('');

  const tableCharts = BRANDS.map(b => {
    const prods = productsByBrand[b.code]||[];
    if (!prods.length) return '';
    const top15 = prods.slice(0,15);
    return `new Chart(document.getElementById('chart_today_rank_${b.code}'),{type:'bar',data:{labels:${JSON.stringify(top15.map(p=>p.FoodName))},datasets:[{data:${JSON.stringify(top15.map(p=>p.Qty))},backgroundColor:'${b.color}cc',borderColor:'${b.color}',borderWidth:1,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.parsed.x+' 件'}}},scales:{x:{grid:{color:'#f0f0f0'}},y:{grid:{display:false},ticks:{font:{size:11}}}}}});`;
  }).filter(Boolean).join('\n');

  const catJs = JSON.stringify(BRANDS.map(b=>({label:b.name,value:brandToday[b.code]||0,color:b.color})));

  const hourlyHtml = hourlyToday && hourlyToday.length ? `
  <div class="chart-card">
    <h2>⏱ 今日各時段業績分布</h2>
    <div class="chart-wrap" style="height:200px"><canvas id="chart_hourly"></canvas></div>
  </div>` : '';
  const hourlyJs = hourlyToday && hourlyToday.length ? `
const H_LABELS=${JSON.stringify(hourlyToday.map(h=>h.Time+':00'))};
const H_TOTALS=${JSON.stringify(hourlyToday.map(h=>h.Total))};
const H_COUNTS=${JSON.stringify(hourlyToday.map(h=>h.Count))};
new Chart(document.getElementById('chart_hourly'),{type:'bar',data:{labels:H_LABELS,datasets:[{data:H_TOTALS,backgroundColor:'rgba(240,147,251,0.6)',borderColor:'#f5576c',borderWidth:1,borderRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:i=>i[0].label+' 時段',label:ctx=>' $'+ctx.parsed.y.toLocaleString(),afterLabel:ctx=>H_COUNTS[ctx.dataIndex]+' 筆'}}},scales:{y:{ticks:{callback:v=>'$'+v.toLocaleString()},grid:{color:'#f0f0f0'}},x:{grid:{display:false}}}}});` : '';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>皮諾可 今日銷售狀況 ${dateLabel}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,'Noto Sans TC',sans-serif;background:#f5f6fa;color:#333}
    .header{background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%);color:white;padding:24px 32px}
    .header h1{font-size:22px;font-weight:700;margin-bottom:4px}.header p{font-size:13px;opacity:.8}
    .stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;padding:20px 32px}
    .stat-card{background:white;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .stat-card .label{font-size:12px;color:#888;margin-bottom:6px}.stat-card .value{font-size:22px;font-weight:700}.stat-card .sub{font-size:12px;color:#aaa;margin-top:4px}
    .charts{padding:0 32px 32px;display:grid;gap:24px}.chart-card{background:white;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .chart-card h2{font-size:15px;font-weight:600;color:#555;margin-bottom:16px}.chart-wrap{position:relative}
    .updated{text-align:right;padding:8px 32px;font-size:11px;color:#bbb}.two-col{display:grid;grid-template-columns:1fr 1fr;gap:24px}
    .ranking-table{width:100%;border-collapse:collapse;font-size:13px}
    .ranking-table th{background:#f8f9fa;padding:8px 10px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #eee;font-size:12px}
    .ranking-table td{border-bottom:1px solid #f0f0f0;vertical-align:middle}.ranking-table tr:last-child td{border-bottom:none}
    .brand-header{display:flex;align-items:center;gap:10px;margin-bottom:4px}
    .brand-badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:white}
    .sub-note{font-size:11px;color:#aaa;margin-bottom:16px}
    @media(max-width:900px){.stats-grid{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}}
    @media(max-width:560px){.header{padding:16px}.header h1{font-size:17px}.stats-grid{grid-template-columns:1fr 1fr;padding:12px 16px;gap:10px}.stat-card{padding:14px 12px}.stat-card .value{font-size:18px}.charts{padding:0 16px 24px}.chart-card{padding:16px}.updated{padding:8px 16px}}
    @media(max-width:380px){.stats-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="header">
  <h1>皮諾可泡沫紅茶 台南門市｜今日銷售狀況 ${dateLabel}</h1>
  <p>資料來源：UShow POS｜更新時間：${updatedAt}</p>
</div>
<div class="stats-grid">
  <div class="stat-card"><div class="label">今日總營業額</div><div class="value" style="color:#27ae60">$${todayTotal.toLocaleString()}</div><div class="sub">含折讓</div></div>
  ${statsCards}
  <div class="stat-card"><div class="label">今日代支合計</div><div class="value" style="color:#e67e22">$${todayExpense.toLocaleString()}</div><div class="sub">代收代支記錄</div></div>
  <div class="stat-card"><div class="label">今日淨業績</div><div class="value" style="color:#e74c3c">$${net.toLocaleString()}</div><div class="sub">共 ${todaySheets} 筆</div></div>
</div>
<div class="charts">
  <div class="chart-card">
    <h2>📊 今日各品牌業績拆分</h2>
    <div class="two-col" style="align-items:center">
      <div class="chart-wrap" style="height:220px"><canvas id="chart_pie"></canvas></div>
      <div class="chart-wrap" style="height:160px"><canvas id="chart_bar"></canvas></div>
    </div>
  </div>
  ${hourlyHtml}
  ${tables}
</div>
<div class="updated">此報表由腳本自動生成，顯示前一日業績｜每天 13:00~24:00 每小時更新</div>
<script>
const CATS=${catJs};const total=${todayTotal};
new Chart(document.getElementById('chart_pie'),{type:'doughnut',data:{labels:CATS.map(c=>c.label),datasets:[{data:CATS.map(c=>c.value),backgroundColor:CATS.map(c=>c.color),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:11}}},tooltip:{callbacks:{label:ctx=>' $'+ctx.parsed.toLocaleString()+' ('+(total>0?(ctx.parsed/total*100).toFixed(1):0)+'%)'}}}}});
new Chart(document.getElementById('chart_bar'),{type:'bar',data:{labels:CATS.map(c=>c.label),datasets:[{data:CATS.map(c=>c.value),backgroundColor:CATS.map(c=>c.color+'cc'),borderColor:CATS.map(c=>c.color),borderWidth:1,borderRadius:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' $'+ctx.parsed.y.toLocaleString()}}},scales:{y:{ticks:{callback:v=>'$'+v.toLocaleString()},grid:{color:'#f0f0f0'}},x:{grid:{display:false}}}}});
${tableCharts}
${hourlyJs}
</script>
</body></html>`;
}

// ── 月業績圖表 HTML ───────────────────────────────────────────────────────────

function buildMonthlyHtml(data, updatedAt, year, month) {
  const { dailySales, monthTotal, monthExpense, brandMonth, monthProductsByBrand, hourlyMonth } = data;
  const net = monthTotal - monthExpense;
  const workDays = dailySales.filter(d=>d.Total>0).length;
  const avg = workDays>0 ? Math.round(monthTotal/workDays) : 0;
  const monthSheets = dailySales.reduce((s,d)=>s+(d.Sheets||0), 0);

  const brandRows = BRANDS.map(b => {
    const v=brandMonth[b.code]||0, pct=monthTotal>0?(v/monthTotal*100).toFixed(1):'0.0';
    return `<tr><td style="padding:8px 10px"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${b.color};margin-right:6px"></span>${b.name}</td><td style="text-align:right;padding:8px 10px;font-weight:600">$${v.toLocaleString()}</td><td style="text-align:right;padding:8px 10px;color:#888">${pct}%</td></tr>`;
  }).join('');

  const rankingHtml = BRANDS.map(b => {
    const prods = (monthProductsByBrand && monthProductsByBrand[b.code]) || [];
    if (!prods.length) return '';
    const rows = prods.map((p,i) => {
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`<span style="color:#aaa">#${i+1}</span>`;
      const pct = monthSheets>0?(p.Times/monthSheets*100).toFixed(1):0;
      const bar = prods[0].Times>0?Math.min(p.Times/prods[0].Times*100,100).toFixed(1):0;
      return `<tr><td style="text-align:center;font-size:13px;padding:8px 10px">${medal}</td><td style="padding:8px 10px">${p.FoodName}</td><td style="text-align:right;padding:8px 10px;font-weight:600">${p.Qty}</td><td style="text-align:right;padding:8px 10px">$${(p.Total||0).toLocaleString()}</td><td style="padding:8px 10px"><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:7px;background:#eee;border-radius:4px;overflow:hidden;min-width:60px"><div style="height:100%;background:${b.color};width:${bar}%;border-radius:4px"></div></div><span style="min-width:40px;font-size:12px;color:${b.color};font-weight:600">${pct}%</span></div></td></tr>`;
    }).join('');
    const top15 = prods.slice(0,15);
    return `<div class="chart-card"><div class="brand-header"><span style="font-size:20px">${b.emoji}</span><h2 style="margin-bottom:0">${b.name}｜商品銷量排名</h2><span class="brand-badge" style="background:${b.color}">${prods.length} 項商品</span></div><div class="sub-note">點擊率 = 含此商品訂單數 ÷ 本月總筆數（${monthSheets} 筆）</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px"><table class="ranking-table"><thead><tr><th style="width:42px">排名</th><th>商品</th><th style="text-align:right">銷量</th><th style="text-align:right">銷售額</th><th style="min-width:140px">點擊率</th></tr></thead><tbody>${rows}</tbody></table><div><canvas id="chart_rank_${b.code}" style="max-height:400px"></canvas></div></div></div>`;
  }).join('');

  const rankingCharts = BRANDS.map(b => {
    const prods = (monthProductsByBrand && monthProductsByBrand[b.code]) || [];
    if (!prods.length) return '';
    const top15 = prods.slice(0,15);
    return `new Chart(document.getElementById('chart_rank_${b.code}'),{type:'bar',data:{labels:${JSON.stringify(top15.map(p=>p.FoodName))},datasets:[{data:${JSON.stringify(top15.map(p=>p.Qty))},backgroundColor:'${b.color}cc',borderColor:'${b.color}',borderWidth:1,borderRadius:4}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' '+ctx.parsed.x+' 件'}}},scales:{x:{grid:{color:'#f0f0f0'}},y:{grid:{display:false},ticks:{font:{size:11}}}}}});`;
  }).filter(Boolean).join('\n');

  const hourlyMonthHtml = hourlyMonth && hourlyMonth.length ? `
  <div class="chart-card">
    <h2>⏱ 本月各時段業績累計</h2>
    <div class="chart-wrap" style="height:200px"><canvas id="chart_hourly_month"></canvas></div>
  </div>` : '';
  const hourlyMonthJs = hourlyMonth && hourlyMonth.length ? `
const MH_LABELS=${JSON.stringify(hourlyMonth.map(h=>h.Time+':00'))};
const MH_TOTALS=${JSON.stringify(hourlyMonth.map(h=>h.Total))};
const MH_COUNTS=${JSON.stringify(hourlyMonth.map(h=>h.Count))};
new Chart(document.getElementById('chart_hourly_month'),{type:'bar',data:{labels:MH_LABELS,datasets:[{data:MH_TOTALS,backgroundColor:'rgba(102,126,234,0.65)',borderColor:'#667eea',borderWidth:1,borderRadius:5}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:i=>i[0].label+' 時段',label:ctx=>' $'+ctx.parsed.y.toLocaleString(),afterLabel:ctx=>MH_COUNTS[ctx.dataIndex]+' 筆'}}},scales:{y:{ticks:{callback:v=>'$'+v.toLocaleString()},grid:{color:'#f0f0f0'}},x:{grid:{display:false}}}}});` : '';

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>皮諾可 ${year}年${month}月 業績報表</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,'Noto Sans TC',sans-serif;background:#f5f6fa;color:#333}
    .header{background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);color:white;padding:24px 32px}
    .header h1{font-size:22px;font-weight:700;margin-bottom:4px}.header p{font-size:13px;opacity:.8}
    .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;padding:20px 32px}
    .stat-card{background:white;border-radius:12px;padding:20px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .stat-card .label{font-size:12px;color:#888;margin-bottom:6px}.stat-card .value{font-size:24px;font-weight:700}.stat-card .sub{font-size:12px;color:#aaa;margin-top:4px}
    .charts{padding:0 32px 32px;display:grid;gap:24px}.chart-card{background:white;border-radius:12px;padding:24px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
    .chart-card h2{font-size:15px;font-weight:600;color:#555;margin-bottom:16px}.chart-wrap{position:relative}
    .updated{text-align:right;padding:8px 32px;font-size:11px;color:#bbb}
    .two-col{display:grid;grid-template-columns:2fr 1fr;gap:24px}
    .brand-table{width:100%;border-collapse:collapse;font-size:13px}
    .brand-table th{background:#f8f9fa;padding:8px 10px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #eee;font-size:12px}
    .brand-table td{border-bottom:1px solid #f0f0f0}.brand-table tr:last-child td{border-bottom:none}
    .ranking-table{width:100%;border-collapse:collapse;font-size:13px}
    .ranking-table th{background:#f8f9fa;padding:8px 10px;text-align:left;font-weight:600;color:#555;border-bottom:2px solid #eee;font-size:12px}
    .ranking-table td{border-bottom:1px solid #f0f0f0;vertical-align:middle}.ranking-table tr:last-child td{border-bottom:none}
    .brand-header{display:flex;align-items:center;gap:10px;margin-bottom:4px}
    .brand-badge{display:inline-block;padding:2px 10px;border-radius:20px;font-size:11px;font-weight:700;color:white}
    .sub-note{font-size:11px;color:#aaa;margin-bottom:16px}
    @media(max-width:900px){.stats-grid{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}}
    @media(max-width:560px){.header{padding:16px}.header h1{font-size:17px}.stats-grid{grid-template-columns:1fr 1fr;padding:12px 16px;gap:10px}.stat-card{padding:14px 12px}.stat-card .value{font-size:18px}.charts{padding:0 16px 24px}.chart-card{padding:16px}.updated{padding:8px 16px}}
    @media(max-width:380px){.stats-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<div class="header">
  <h1>皮諾可泡沫紅茶 台南門市｜${year}年${month}月 業績報表</h1>
  <p>資料來源：UShow POS｜更新時間：${updatedAt}</p>
</div>
<div class="stats-grid">
  <div class="stat-card"><div class="label">本月總營業額</div><div class="value" style="color:#27ae60">$${monthTotal.toLocaleString()}</div><div class="sub">共 ${workDays} 個營業日</div></div>
  <div class="stat-card"><div class="label">日均營業額</div><div class="value" style="color:#2980b9">$${avg.toLocaleString()}</div><div class="sub">含折讓在內</div></div>
  <div class="stat-card"><div class="label">本月代支合計</div><div class="value" style="color:#e67e22">$${monthExpense.toLocaleString()}</div><div class="sub">代收代支記錄</div></div>
  <div class="stat-card"><div class="label">本月淨業績</div><div class="value" style="color:#e74c3c">$${net.toLocaleString()}</div><div class="sub">總營業額 - 代支</div></div>
</div>
<div class="charts">
  <div class="chart-card">
    <h2>📈 每日總營業額趨勢</h2>
    <div class="chart-wrap" style="height:280px"><canvas id="chart_daily"></canvas></div>
  </div>
  <div class="chart-card">
    <h2>💰 每日業績 vs 代支比較</h2>
    <div class="chart-wrap" style="height:240px"><canvas id="chart_vs"></canvas></div>
  </div>
  ${hourlyMonthHtml}
  <div class="chart-card">
    <h2>🍩 本月各大類業績佔比</h2>
    <div class="two-col" style="align-items:center">
      <div class="chart-wrap" style="height:220px"><canvas id="chart_brand"></canvas></div>
      <div><table class="brand-table"><thead><tr><th>品牌</th><th style="text-align:right">業績</th><th style="text-align:right">佔比</th></tr></thead><tbody>${brandRows}</tbody></table></div>
    </div>
  </div>
  ${rankingHtml}
</div>
<div class="updated">此報表由腳本自動生成，每日凌晨 1:00 更新</div>
<script>
const LABELS=${JSON.stringify(dailySales.map(d=>d.label))};
const TOTALS=${JSON.stringify(dailySales.map(d=>d.Total))};
const EXPENSES=${JSON.stringify(dailySales.map(d=>d.Expense||0))};
new Chart(document.getElementById('chart_daily'),{type:'line',data:{labels:LABELS,datasets:[{label:'每日業績',data:TOTALS,borderColor:'#667eea',backgroundColor:'rgba(102,126,234,0.08)',borderWidth:2,pointRadius:3,tension:0.3,fill:true}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>' $'+ctx.parsed.y.toLocaleString()}}},scales:{y:{ticks:{callback:v=>'$'+v.toLocaleString()},grid:{color:'#f0f0f0'}},x:{grid:{display:false}}}}});
new Chart(document.getElementById('chart_vs'),{type:'bar',data:{labels:LABELS,datasets:[{label:'總營業額',data:TOTALS,backgroundColor:'rgba(102,126,234,0.7)',borderRadius:4},{label:'代支合計',data:EXPENSES,backgroundColor:'rgba(231,76,60,0.6)',borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:12,font:{size:11}}},tooltip:{callbacks:{label:ctx=>' $'+ctx.parsed.y.toLocaleString()}}},scales:{y:{ticks:{callback:v=>'$'+v.toLocaleString()},grid:{color:'#f0f0f0'}},x:{grid:{display:false}}}}});
const BRANDS_DATA=${JSON.stringify(BRANDS.map(b=>({label:b.name,value:brandMonth[b.code]||0,color:b.color})))};
new Chart(document.getElementById('chart_brand'),{type:'doughnut',data:{labels:BRANDS_DATA.map(b=>b.label),datasets:[{data:BRANDS_DATA.map(b=>b.value),backgroundColor:BRANDS_DATA.map(b=>b.color),borderWidth:0}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:11}}},tooltip:{callbacks:{label:ctx=>' $'+ctx.parsed.toLocaleString()}}}}});
${rankingCharts}
${hourlyMonthJs}
</script>
</body></html>`;
}

// ── 前兩日資料驗證 ────────────────────────────────────────────────────────────

async function verifyPreviousDays(token, year, month, dir, todayIso) {
  const pnlPath = path.join(dir, 'pnl_data.json');
  if (!fs.existsSync(pnlPath)) { console.log('  pnl_data.json 不存在，跳過驗證'); return false; }

  const pnl = JSON.parse(fs.readFileSync(pnlPath, 'utf8'));
  const now = getTaipeiNow();
  let mismatch = false;

  for (let i = 1; i <= 2; i++) {
    const d = new Date(now.getTime());
    d.setDate(d.getDate() - i);
    if (d.getFullYear() !== year || d.getMonth()+1 !== month) continue;

    const dayIso = isoDate(d);
    const dayLabel = `${d.getMonth()+1}/${d.getDate()}`;
    const rows = await fetchSalePages(dayIso, dayIso, token);
    const row = rows.find(r => r.BusinessDay === dayIso);
    const ushowTotal = row?.Total || 0;
    const pnlRow = (pnl.days||[]).find(r => r.date === dayLabel);
    const pnlTotal = pnlRow?.total || 0;

    if (Math.abs(ushowTotal - pnlTotal) > 10) {
      console.log(`  ⚠️ ${dayIso} 不符：記錄 $${pnlTotal} / UShow $${ushowTotal} → 觸發全量更新`);
      mismatch = true;
    } else {
      console.log(`  ✅ ${dayIso} 正確：$${ushowTotal}`);
    }
  }
  return mismatch;
}

// ── 更新 index.html 月份連結 ──────────────────────────────────────────────────

function updateIndexHtml(month) {
  const indexPath = path.join(PINOKO_WEB_DIR, 'index.html');
  if (!fs.existsSync(indexPath)) return;
  let html = fs.readFileSync(indexPath, 'utf8');
  // 替換月業績圖表連結（任何月份 → 當月）
  const updated = html.replace(
    /href="皮諾可_\d+月業績圖表\.html"/,
    `href="皮諾可_${month}月業績圖表.html"`
  );
  if (updated !== html) {
    fs.writeFileSync(indexPath, updated, 'utf8');
    console.log(`✅ index.html 更新為 ${month}月業績圖表`);
  }
}

// ── GitHub Pages 部署 ─────────────────────────────────────────────────────────

async function deployToGitHub() {
  if (IS_CLOUD) { console.log('（雲端環境，由 Actions 負責 commit）'); return; }
  console.log('部署到 GitHub Pages...');
  try {
    execSync(`/Users/chun/.nvm/versions/node/v24.16.0/bin/node "/Users/chun/Desktop/pinoko-web/deploy.js"`, { stdio: 'inherit' });
    console.log('✅ GitHub Pages 更新完成');
  } catch (e) {
    console.error('GitHub Pages 部署失敗:', e.message);
  }
}

// ── 空殼檔案 ──────────────────────────────────────────────────────────────────

function emptyShell(year, month, type) {
  const msg = type==='today'
    ? `${month}月1日起每天 13:00~23:00 每小時自動更新`
    : `${month}月1日起每日凌晨1:00自動更新`;
  const title = type==='today' ? '今日銷售狀況' : `${year}年${month}月 業績報表`;
  return `<!DOCTYPE html><html lang='zh-TW'><head><meta charset='UTF-8'><title>皮諾可 ${title}</title><style>body{font-family:-apple-system,sans-serif;background:#f5f6fa;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.card{background:white;border-radius:16px;padding:48px;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,.08)}.title{font-size:20px;font-weight:700;color:#333;margin-bottom:12px}.sub{font-size:13px;color:#aaa}</style></head><body><div class='card'><div class='title'>皮諾可泡沫紅茶 台南門市<br>${title}</div><div class='sub'>尚無資料，${msg}</div></div></body></html>`;
}

// ── 下個月空殼建置 ────────────────────────────────────────────────────────────

function prepareNextMonth(year, month) {
  let ny=year, nm=month+1;
  if (nm>12) { nm=1; ny++; }
  const dir = ensureDir(ny, nm);
  const files = [
    [path.join(dir,'皮諾可_今日銷售狀況.html'), emptyShell(ny,nm,'today')],
    [path.join(dir,`皮諾可_${nm}月業績圖表.html`), emptyShell(ny,nm,'monthly')],
    [path.join(dir,'pnl_data.json'), JSON.stringify({days:[],updatedAt:new Date().toISOString()},null,2)],
  ];
  files.forEach(([p,c]) => { if (!fs.existsSync(p)) { fs.writeFileSync(p,c,'utf8'); console.log('建立:', path.basename(p)); } });
  console.log(`下個月空殼就緒: ${ny}年${nm}月`);
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const now = getTaipeiNow();
  const bizDate = getBusinessDate(now); // 凌晨 6 點前用前一天
  const year = bizDate.getFullYear(), month = bizDate.getMonth()+1;
  const todayIso = isoDate(bizDate);
  const todayDay = dayBeginStr(bizDate);
  const monthStartIso = `${year}-${String(month).padStart(2,'0')}-01`;
  const monthStartDay = `${year}-${month}-1`;
  const updatedAt = displayTime(now); // 更新時間仍顯示實際時間
  const dateLabel = `${month}/${bizDate.getDate()}`;

  console.log(`[${updatedAt}] 開始更新 (mode: ${MODE})`);
  const dir = ensureDir(year, month);

  console.log('登入 UShow...');
  const token = await getToken();
  console.log('Token 取得');

  // ── 今日資料 ──────────────────────────────────────────────────────────────

  console.log('抓取今日品牌拆分...');
  const brandRaw = await fetchDayPages('foodmajorkindstatistic', todayDay, todayDay, token);
  const brandToday = {};
  let todayTotal = 0;
  brandRaw.forEach(d => {
    brandToday[d.FoodMajorKindNumber] = d.Total;
    todayTotal += d.Total; // 包含折讓（4000 為負值）
  });

  console.log('抓取今日銷售筆數...');
  const saleAll = await fetchSalePages(todayIso, todayIso, token);
  const todayRow = saleAll.find(d => d.BusinessDay === todayIso);
  const todaySheets = todayRow?.Sheets || 0;
  if (todayTotal === 0 && todayRow) todayTotal = todayRow.Total || 0;

  console.log('抓取今日商品排名...');
  const [kindMap, prodRaw] = await Promise.all([
    buildKindBrandMap(token),
    fetchDayPages('foodsalestatistic', todayDay, todayDay, token)
  ]);

  const productsByBrand = {};
  BRANDS.forEach(b => productsByBrand[b.code] = []);
  prodRaw
    .filter(p => p.Qty > 0 && !SKIP_KIND.has(p.FoodKindName) && !SKIP_KIND.has(p.FoodName))
    .forEach(p => {
      const brand = kindMap[p.FoodKindNumber];
      if (brand && productsByBrand[brand]) productsByBrand[brand].push(p);
    });
  BRANDS.forEach(b => productsByBrand[b.code].sort((a,b)=>b.Qty-a.Qty));

  console.log('抓取今日代支...');
  const cpRaw = await fetchDayPages('collectionpayment', todayDay, todayDay, token);
  const todayExpense = cpRaw
    .filter(d => d.CollectionPaymentType === '代支')
    .reduce((s,d) => s+(d.Price||0), 0);

  console.log('抓取今日時段分布...');
  const hourlyToday = await fetchTimeStatistic(todayDay, todayDay, token);

  // 寫今日銷售 HTML
  const todayHtml = buildTodayHtml({ todayTotal, brandToday, todayExpense, todaySheets, productsByBrand, hourlyToday }, updatedAt, dateLabel);
  fs.writeFileSync(path.join(dir,'皮諾可_今日銷售狀況.html'), todayHtml, 'utf8');
  fs.writeFileSync(path.join(PINOKO_WEB_DIR,'皮諾可_今日銷售狀況.html'), todayHtml, 'utf8');
  console.log(`✅ 今日銷售狀況 更新完成`);

  console.log('驗證前兩日資料...');
  const needsFull = await verifyPreviousDays(token, year, month, dir, todayIso);

  if (MODE !== 'full' && !needsFull) {
    await deployToGitHub();
    console.log(`[${displayTime(getTaipeiNow())}] 完成 (today mode)`);
    return;
  }

  if (needsFull) console.log('前兩日有誤，切換全量更新修正...');

  // ── 月資料（full mode）────────────────────────────────────────────────────

  console.log('抓取當月每日趨勢...');
  const saleMonth = await fetchSalePages(monthStartIso, todayIso, token);
  const daysInMonth = new Date(year, month, 0).getDate();
  const dailySales = [];
  for (let d=1; d<=daysInMonth; d++) {
    const ds = `${year}-${String(month).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    if (ds > todayIso) break;
    const row = saleMonth.find(r => r.BusinessDay === ds);
    dailySales.push({ label:`${month}/${d}`, date:ds, Total: row?.Total||0, Sheets: row?.Sheets||0 });
  }
  const monthTotal = dailySales.reduce((s,d)=>s+d.Total, 0);

  console.log('抓取當月品牌拆分...');
  const brandMonthRaw = await fetchDayPages('foodmajorkindstatistic', monthStartDay, todayDay, token);
  const brandMonth = {};
  brandMonthRaw.forEach(d => { brandMonth[d.FoodMajorKindNumber] = d.Total; });

  console.log('抓取當月代支...');
  const cpMonthRaw = await fetchDayPages('collectionpayment', monthStartDay, todayDay, token);
  const dailyExpenseMap = {};
  const monthExpense = cpMonthRaw
    .filter(d => d.CollectionPaymentType === '代支')
    .reduce((s,d) => {
      const key = d.BusinessDay || '';
      if (key) dailyExpenseMap[key] = (dailyExpenseMap[key]||0) + (d.Price||0);
      return s + (d.Price||0);
    }, 0);
  dailySales.forEach(d => { d.Expense = dailyExpenseMap[d.date] || 0; });

  console.log('抓取當月商品排名...');
  const [prodMonthRaw, productCatalog] = await Promise.all([
    fetchDayPages('foodsalestatistic', monthStartDay, todayDay, token),
    fetchProductCatalog(token),
  ]);
  const monthProductsByBrand = {};
  BRANDS.forEach(b => monthProductsByBrand[b.code] = []);
  prodMonthRaw
    .filter(p => !SKIP_KIND.has(p.FoodKindName) && !SKIP_KIND.has(p.FoodName))
    .forEach(p => {
      const brand = kindMap[p.FoodKindNumber];
      if (brand && monthProductsByBrand[brand]) monthProductsByBrand[brand].push(p);
    });

  // 補充 0 銷量商品（從商品目錄）
  // 用原始銷售資料建集合，避免 kindMap 遺漏或目錄 API 編碼問題（� 取代字元）
  const salesNamesRaw = new Set(
    prodMonthRaw
      .filter(p => !SKIP_KIND.has(p.FoodKindName) && !SKIP_KIND.has(p.FoodName))
      .map(p => p.FoodName.replace(/�/g, ''))
  );
  productCatalog
    .filter(p => !SKIP_KIND.has(p.FoodKindName) && !SKIP_KIND.has(p.FoodName))
    .forEach(p => {
      const brand = p.FoodMajorKindNumber;
      if (!monthProductsByBrand[brand]) return;
      const normalizedName = p.FoodName.replace(/�/g, '');
      // 精確匹配或前綴匹配（處理多規格商品，例如衣服的 S/M/L 展開）
      const hasSale = salesNamesRaw.has(normalizedName) ||
        [...salesNamesRaw].some(s => s.startsWith(normalizedName + '-') || s.startsWith(normalizedName + ' '));
      if (!hasSale) {
        monthProductsByBrand[brand].push({
          FoodName: normalizedName, FoodKindName: p.FoodKindName,
          FoodKindNumber: p.FoodKindNumber, Qty: 0, Times: 0, Total: 0,
        });
      }
    });

  BRANDS.forEach(b => monthProductsByBrand[b.code].sort((a,b) => b.Qty - a.Qty));

  console.log('抓取當月時段累計...');
  const hourlyMonth = await fetchTimeStatistic(monthStartDay, todayDay, token);

  // 更新 pnl_data.json
  const pnl = { days: dailySales.map(d=>({date:d.label,total:d.Total,sheets:d.Sheets})), brandMonth, monthTotal, monthExpense, updatedAt: now.toISOString() };
  fs.writeFileSync(path.join(dir,'pnl_data.json'), JSON.stringify(pnl,null,2), 'utf8');
  console.log(`✅ pnl_data.json 更新完成`);

  // 寫月業績圖表 HTML
  const monthHtml = buildMonthlyHtml({ dailySales, monthTotal, monthExpense, brandMonth, monthProductsByBrand, hourlyMonth }, updatedAt, year, month);
  fs.writeFileSync(path.join(dir,`皮諾可_${month}月業績圖表.html`), monthHtml, 'utf8');
  console.log(`✅ ${month}月業績圖表 更新完成（僅本機備份）`);

  // 月底預建下個月
  if (now.getDate() >= 28) prepareNextMonth(year, month);

  await deployToGitHub();
  console.log(`[${displayTime(getTaipeiNow())}] 全量更新完成`);
}

main().catch(err => { console.error('更新失敗:', err.message); process.exit(1); });
