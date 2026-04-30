// ════════════════════════════════════════════════
//  12_leverage_decay.gs  槓桿 ETF 耗損計算器 v1.2
//
//  v1.0 → v1.1:歷史價改用 adjclose(自動處理 split + 配息)
//  v1.1 → v1.2:加試算表「槓桿對應」分頁,RA 可手動覆蓋/補充
//
//  本檔職責:
//    1. 偵測一個 ticker 是否為槓桿 ETF(2x / 3x)
//    2. 對有對應標的股的,計算過去 90 天累積耗損(理論值 - 實際值)
//    3. 不預測未來,不投票,只提供資訊揭露
//
//  對外 API:
//    getLeverageDecay(ticker) → 完整結構物件
//
//  工具函數(GAS 編輯器手動跑):
//    initLeverageMapSheet()    建立試算表「槓桿對應」分頁(只跑一次)
//    clearLeverageMapCache()   改完試算表後清緩存讓對應立刻生效
//    testDetectOnly()          測偵測規則(不抓網路)
//    testLeverageDecay()       測完整流程(會抓 Yahoo 歷史價)
//
//  偵測規則(先比先得):
//    0. 試算表「槓桿對應」分頁 — RA 手動維護,優先級最高
//    1. 白名單(LEVERAGE_MAP)— 寫死的常用 ETF
//    2. 含 3X / 3L / 3S 字樣 → 3x 槓桿但未知標的
//    3. 結尾 X / UP / DN(且不在白名單) → 推測 2x 但未知標的
//    4. 都不符 → 不是槓桿 ETF
//
//  資料來源:
//    Yahoo Finance v8 chart API(自寫 fetchHistoricalCloses_,
//    不依賴 03_stocks.gs,避免函數名變動風險)
//    優先 adjclose(已調整 split/配息),抓不到才 fallback close
//
//  RA 鐵則:
//    - 沒標的就不算耗損(回傳 null + 警示說明),不假數據
//    - 偵測到疑似槓桿但未知標的也老實標出來,不假裝沒事
//    - source 欄位透傳對應來源:custom_sheet/builtin_map/heuristic_2x/3x
// ════════════════════════════════════════════════


// ════════════════════════════════════════════════
// 白名單(本檔常數,不污染 01_config.gs)
// 格式:ETF代號 → { underlying: 標的股, multiplier: 倍數, name: 顯示名稱 }
// 新增槓桿 ETF 在這裡加即可
// ════════════════════════════════════════════════
const LEVERAGE_MAP = {
  // RA 持股
  'ORCX': { underlying: 'ORCL', multiplier: 2, name: '甲骨文' },
  'SMUP': { underlying: 'SMR',  multiplier: 2, name: '小型核能 SMR' },

  // 常見 3x 槓桿 ETF
  'TQQQ': { underlying: 'QQQ',  multiplier: 3, name: '納指100' },
  'SQQQ': { underlying: 'QQQ',  multiplier: -3, name: '納指100反向' },
  'SOXL': { underlying: 'SOXX', multiplier: 3, name: '半導體' },
  'SOXS': { underlying: 'SOXX', multiplier: -3, name: '半導體反向' },
  'SPXL': { underlying: 'SPY',  multiplier: 3, name: '標普500' },
  'SPXS': { underlying: 'SPY',  multiplier: -3, name: '標普500反向' },
  'TNA':  { underlying: 'IWM',  multiplier: 3, name: '小型股' },
  'TZA':  { underlying: 'IWM',  multiplier: -3, name: '小型股反向' },
  'UPRO': { underlying: 'SPY',  multiplier: 3, name: '標普500' },
  'TMF':  { underlying: 'TLT',  multiplier: 3, name: '20年公債' },

  // 個股 2x 槓桿(GraniteShares / Direxion / T-Rex 等)
  'NVDX': { underlying: 'NVDA', multiplier: 2, name: '輝達' },
  'NVDU': { underlying: 'NVDA', multiplier: 2, name: '輝達' },
  'TSLL': { underlying: 'TSLA', multiplier: 2, name: '特斯拉' },
  'TSLR': { underlying: 'TSLA', multiplier: 2, name: '特斯拉' },
  'AAPU': { underlying: 'AAPL', multiplier: 2, name: '蘋果' },
  'AAPB': { underlying: 'AAPL', multiplier: 2, name: '蘋果' },
  'MSFU': { underlying: 'MSFT', multiplier: 2, name: '微軟' },
  'AMZU': { underlying: 'AMZN', multiplier: 2, name: '亞馬遜' },
  'GGLL': { underlying: 'GOOGL', multiplier: 2, name: 'Google' },
  'METU': { underlying: 'META', multiplier: 2, name: 'Meta' },
};

// 顏色門檻
const DECAY_THRESHOLDS = {
  MILD_MAX:   5.0,    // < 5% 黃
  WARN_MAX:   15.0,   // 5-15% 橘
                      // ≥ 15% 紅
};

const DECAY_COLORS = {
  mild:   '#FFD93D',  // 黃
  warn:   '#FF8C42',  // 橘
  severe: '#FF4757',  // 紅
};

// 預設分析天數
const DECAY_DAYS = 90;


// ════════════════════════════════════════════════
// 對外主函數:getLeverageDecay
// 不論輸入什麼都回完整結構,不會 throw
// ════════════════════════════════════════════════
function getLeverageDecay(ticker) {
  // 預設骨架
  const result = {
    ok: true,
    error: null,
    ticker: (ticker || '').toUpperCase(),
    isLeveraged: false,
    multiplier: null,
    underlying: null,
    underlyingName: null,
    days: DECAY_DAYS,
    underlyingReturn: null,
    theoreticalReturn: null,
    actualReturn: null,
    decay: null,
    decayPct: null,
    decayLevel: null,
    decayColor: null,
    priceField: null,    // 'adjclose' / 'close (fallback)'  方便除錯
    source: null,        // 'custom_sheet' / 'builtin_map' / 'heuristic_3x' / 'heuristic_2x' / null
    note: '',
  };

  try {
    if (!ticker || typeof ticker !== 'string') {
      result.ok = false;
      result.error = 'ticker 為空或非字串';
      result.note = '輸入錯誤,無法判斷';
      return result;
    }

    const t = ticker.toUpperCase().trim();
    result.ticker = t;

    // ── Step 1:偵測是否為槓桿 ETF(優先序:試算表 > 白名單 > 啟發式)──
    const customMap = loadCustomLeverageMap_();
    const detect = detectLeverage_(t, customMap);
    result.isLeveraged = detect.isLeveraged;
    result.multiplier = detect.multiplier;
    result.underlying = detect.underlying;
    result.underlyingName = detect.underlyingName;
    result.source = detect.source;

    if (!detect.isLeveraged) {
      result.note = '非槓桿 ETF,無耗損計算';
      return result;
    }

    // ── Step 2:沒對應標的,提示後直接返回 ──
    if (!detect.underlying) {
      result.note = `偵測到疑似 ${detect.multiplier > 0 ? Math.abs(detect.multiplier) : Math.abs(detect.multiplier)}x 槓桿 ETF,但未知對應標的,無法計算耗損,請手動確認`;
      result.decayLevel = 'mild'; // 沒辦法算,給個中性顏色避免前端崩
      result.decayColor = DECAY_COLORS.mild;
      return result;
    }

    // ── Step 3:抓 ETF + 標的兩邊歷史價 ──
    const etfData = fetchHistoricalCloses_(t, DECAY_DAYS);
    if (!etfData.ok) {
      result.ok = false;
      result.error = `抓 ${t} 歷史價失敗:${etfData.error}`;
      result.note = '資料來源失敗,無法計算耗損';
      return result;
    }

    const undData = fetchHistoricalCloses_(detect.underlying, DECAY_DAYS);
    if (!undData.ok) {
      result.ok = false;
      result.error = `抓 ${detect.underlying} 歷史價失敗:${undData.error}`;
      result.note = '標的股資料失敗,無法計算耗損';
      return result;
    }

    if (etfData.closes.length < 10 || undData.closes.length < 10) {
      result.ok = false;
      result.error = '歷史價資料不足 10 天';
      result.note = '資料天數不足,無法計算耗損';
      return result;
    }

    // 紀錄資料來源欄位(方便除錯,正常應為 'adjclose')
    // ETF 跟標的通常都會回同一種 field,以 ETF 為準
    result.priceField = etfData.priceField;

    // ── Step 4:算累積報酬 ──
    const etfReturn = calcCumulativeReturn_(etfData.closes);
    const undReturn = calcCumulativeReturn_(undData.closes);

    if (etfReturn === null || undReturn === null) {
      result.ok = false;
      result.error = '累積報酬計算失敗';
      result.note = '計算失敗';
      return result;
    }

    // 理論值 = 倍數 × 標的報酬(注意反向 ETF 倍數是負)
    const theoretical = detect.multiplier * undReturn;
    const decayValue = theoretical - etfReturn;
    const decayPct = decayValue * 100;

    result.underlyingReturn = round_(undReturn, 4);
    result.theoreticalReturn = round_(theoretical, 4);
    result.actualReturn = round_(etfReturn, 4);
    result.decay = round_(decayValue, 4);
    result.decayPct = round_(decayPct, 2);

    // ── Step 5:分級 + 顏色 + note ──
    const grading = gradeDecay_(decayPct);
    result.decayLevel = grading.level;
    result.decayColor = grading.color;
    result.note = buildNote_(t, detect, decayPct, undReturn, etfReturn);

    return result;

  } catch (e) {
    result.ok = false;
    result.error = e.message || String(e);
    result.note = `計算發生異常:${result.error}`;
    return result;
  }
}


// ════════════════════════════════════════════════
// 內部函數:偵測槓桿 ETF
// 優先序:customMap(試算表)> LEVERAGE_MAP(寫死)> 啟發式規則
// ────────────────────────────────────────────────
// customMap 由 loadCustomLeverageMap_() 提供,可為 null
// ════════════════════════════════════════════════
function detectLeverage_(ticker, customMap) {
  const out = {
    isLeveraged: false,
    multiplier: null,
    underlying: null,
    underlyingName: null,
    source: null,    // 對應來自:custom_sheet / builtin_map / heuristic_3x / heuristic_2x
  };

  // ── 規則 0:自訂表(試算表「槓桿對應」分頁,RA 手動維護)──
  if (customMap && customMap[ticker]) {
    const m = customMap[ticker];
    out.isLeveraged = true;
    out.multiplier = m.multiplier;
    out.underlying = m.underlying;
    out.underlyingName = m.name;
    out.source = 'custom_sheet';
    return out;
  }

  // ── 規則 1:白名單(寫死在程式碼,常用 ETF)──
  if (LEVERAGE_MAP[ticker]) {
    const m = LEVERAGE_MAP[ticker];
    out.isLeveraged = true;
    out.multiplier = m.multiplier;
    out.underlying = m.underlying;
    out.underlyingName = m.name;
    out.source = 'builtin_map';
    return out;
  }

  // ── 規則 2:含 3X / 3L / 3S 字樣 ──
  if (/3X|3L|3S/i.test(ticker)) {
    out.isLeveraged = true;
    // 3S 通常代表反向 3x,3L/3X 代表正向 3x
    out.multiplier = /3S/i.test(ticker) ? -3 : 3;
    out.source = 'heuristic_3x';
    return out;
  }

  // ── 規則 3:結尾 X / UP / DN(常見 2x 槓桿命名)──
  // 排除 SPX/QQQ/IWM 這類純指數代號(沒以 X/UP/DN 結尾,不會誤判)
  // 但要避開 NDX/SPX/RUT 這類指數本身結尾是 X
  // 用「長度 ≥ 4 + 結尾 X/UP/DN」當啟發式
  if (ticker.length >= 4) {
    if (/X$/.test(ticker)) {
      // 排除常見指數誤判:SPX/NDX/VIX 等
      const indexFalsePositive = ['SPX', 'NDX', 'VIX', 'RUT', 'DJX'];
      if (!indexFalsePositive.includes(ticker)) {
        out.isLeveraged = true;
        out.multiplier = 2;
        out.source = 'heuristic_2x';
        return out;
      }
    }
    if (/UP$/.test(ticker)) {
      out.isLeveraged = true;
      out.multiplier = 2;
      out.source = 'heuristic_2x';
      return out;
    }
    if (/DN$/.test(ticker)) {
      out.isLeveraged = true;
      out.multiplier = -2;
      out.source = 'heuristic_2x';
      return out;
    }
  }

  return out;
}


// ════════════════════════════════════════════════
// 內部函數:讀取試算表「槓桿對應」分頁
// ────────────────────────────────────────────────
// 試算表結構:
//   分頁名稱:槓桿對應
//   欄位:ETF代號 | 標的股 | 倍數 | 顯示名稱 | 備註
//
// 緩存策略:
//   用 GAS CacheService 緩存 5 分鐘,避免每次都讀試算表
//   RA 改完試算表後可呼叫 clearLeverageMapCache() 立刻刷新
//
// 異常處理:
//   分頁不存在 → 回 {} 不報錯(沿用 LEVERAGE_MAP)
//   單列資料異常 → 跳過該列,繼續處理其他列
// ════════════════════════════════════════════════
const CUSTOM_LEVERAGE_SHEET_NAME = '槓桿對應';
const CUSTOM_LEVERAGE_CACHE_KEY = 'leverage_custom_map_v1';
const CUSTOM_LEVERAGE_CACHE_SEC = 300;  // 5 分鐘

function loadCustomLeverageMap_() {
  try {
    // 1. 先查緩存
    const cache = CacheService.getScriptCache();
    const cached = cache.get(CUSTOM_LEVERAGE_CACHE_KEY);
    if (cached) {
      try {
        return JSON.parse(cached);
      } catch (e) {
        // 緩存壞掉,當作沒有,繼續往下
      }
    }

    // 2. 緩存沒有,讀試算表
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CUSTOM_LEVERAGE_SHEET_NAME);
    if (!sheet) {
      // 分頁還沒建,回空物件,但不存緩存(避免下次又略過)
      return {};
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      // 只有表頭沒資料
      cache.put(CUSTOM_LEVERAGE_CACHE_KEY, '{}', CUSTOM_LEVERAGE_CACHE_SEC);
      return {};
    }

    // 讀 A2:E lastRow(5 欄:ETF代號 | 標的股 | 倍數 | 顯示名稱 | 備註)
    const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const map = {};

    values.forEach(row => {
      const etf = (row[0] || '').toString().trim().toUpperCase();
      const underlying = (row[1] || '').toString().trim().toUpperCase();
      const multiplier = parseFloat(row[2]);
      const name = (row[3] || '').toString().trim();
      // row[4] 備註不入 map,只給 RA 自己看

      // 嚴格驗證,任一欄位異常就跳過
      if (!etf || !underlying || isNaN(multiplier) || multiplier === 0) {
        return;
      }
      map[etf] = {
        multiplier: multiplier,
        underlying: underlying,
        name: name || underlying  // 沒填顯示名稱就用標的代號
      };
    });

    // 3. 寫入緩存
    cache.put(CUSTOM_LEVERAGE_CACHE_KEY, JSON.stringify(map), CUSTOM_LEVERAGE_CACHE_SEC);
    return map;

  } catch (e) {
    Logger.log(`[loadCustomLeverageMap_] 失敗: ${e.message}`);
    return {};  // 出錯就回空,讓系統 fallback 到 LEVERAGE_MAP
  }
}


// ════════════════════════════════════════════════
// 工具函數:清除自訂表緩存
// ────────────────────────────────────────────────
// 用法:在 GAS 編輯器執行 clearLeverageMapCache(),
//      下次呼叫 getLeverageDecay 會重讀試算表
// ════════════════════════════════════════════════
function clearLeverageMapCache() {
  try {
    CacheService.getScriptCache().remove(CUSTOM_LEVERAGE_CACHE_KEY);
    Logger.log('✅ 槓桿對應緩存已清除,下次呼叫會重讀試算表');
  } catch (e) {
    Logger.log(`❌ 清除緩存失敗: ${e.message}`);
  }
}


// ════════════════════════════════════════════════
// 工具函數:初始化「槓桿對應」分頁
// ────────────────────────────────────────────────
// 用法:在 GAS 編輯器執行 initLeverageMapSheet() 一次,
//      會自動建立分頁、寫入表頭、填入範例資料
//      已存在不會覆蓋,只會補表頭(如果缺)
// ════════════════════════════════════════════════
function initLeverageMapSheet() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(CUSTOM_LEVERAGE_SHEET_NAME);

    if (!sheet) {
      sheet = ss.insertSheet(CUSTOM_LEVERAGE_SHEET_NAME);
      Logger.log(`✅ 建立分頁:${CUSTOM_LEVERAGE_SHEET_NAME}`);
    } else {
      Logger.log(`ℹ️ 分頁已存在:${CUSTOM_LEVERAGE_SHEET_NAME}`);
    }

    // 寫表頭(深藍底+橘字+粗體,沿用既有風格)
    const headers = [['ETF代號', '標的股', '倍數', '顯示名稱', '備註']];
    sheet.getRange(1, 1, 1, 5).setValues(headers)
      .setBackground('#0A1E35')
      .setFontColor('#F5A623')
      .setFontWeight('bold')
      .setHorizontalAlignment('center');

    // 凍結第 1 列
    sheet.setFrozenRows(1);

    // 設定欄寬(讓 RA 看著舒服)
    sheet.setColumnWidth(1, 100);   // ETF代號
    sheet.setColumnWidth(2, 100);   // 標的股
    sheet.setColumnWidth(3, 70);    // 倍數
    sheet.setColumnWidth(4, 150);   // 顯示名稱
    sheet.setColumnWidth(5, 250);   // 備註

    // 加範例資料(只在沒資料時加)
    if (sheet.getLastRow() < 2) {
      const examples = [
        ['GOOGX', 'GOOGL', 2, 'Google',          '範例:結尾X推測,RA確認後保留或刪除'],
        ['MSTU',  'MSTR',  2, 'MicroStrategy',   '範例:GraniteShares 2x MSTR'],
        ['',      '',      '', '',                '↑ 範例,可刪除。下面開始加你需要的對應'],
      ];
      sheet.getRange(2, 1, examples.length, 5).setValues(examples);

      // 範例列灰底
      sheet.getRange(2, 1, 2, 5).setBackground('#F5F5F5').setFontColor('#888888');
      sheet.getRange(4, 1, 1, 5).setBackground('#FFF8E7').setFontStyle('italic').setFontColor('#888888');

      Logger.log(`✅ 寫入 ${examples.length} 列範例資料`);
    }

    // 寫使用說明到 G1
    sheet.getRange(1, 7).setValue('📋 使用說明');
    sheet.getRange(1, 7).setBackground('#F5A623').setFontColor('#FFFFFF').setFontWeight('bold');
    const helpText = [
      ['1. ETF代號:大寫(例 GOOGX)'],
      ['2. 標的股:大寫(例 GOOGL)'],
      ['3. 倍數:正數=正向(2/3),負數=反向(-2/-3)'],
      ['4. 顯示名稱:中文好讀(例 Google)'],
      ['5. 備註:給自己看的(來源/確認日期)'],
      [''],
      ['⚠️ 改完後,在 GAS 編輯器執行 clearLeverageMapCache()'],
      ['   或等 5 分鐘讓緩存自動過期,新對應才會生效'],
      [''],
      ['💡 此分頁優先級高於程式碼內建白名單,'],
      ['   如果某 ETF 內建有但你想換對應(例如改倍數),'],
      ['   在這裡寫,會覆蓋內建設定'],
    ];
    sheet.getRange(2, 7, helpText.length, 1).setValues(helpText)
      .setFontColor('#555555')
      .setVerticalAlignment('top');
    sheet.setColumnWidth(7, 350);

    Logger.log(`\n========== 完成 ==========`);
    Logger.log(`分頁:${CUSTOM_LEVERAGE_SHEET_NAME}`);
    Logger.log(`網址:${ss.getUrl()}`);
    Logger.log(`\n下一步:打開試算表「${CUSTOM_LEVERAGE_SHEET_NAME}」分頁手動編輯`);

    // 順手清緩存,讓初始化資料立刻生效
    clearLeverageMapCache();

  } catch (e) {
    Logger.log(`❌ 初始化失敗: ${e.message}`);
    Logger.log(`堆疊: ${e.stack}`);
  }
}


// ════════════════════════════════════════════════
// 內部函數:抓 Yahoo Finance 歷史調整收盤價
// ────────────────────────────────────────────────
// 用 v8/finance/chart API + events=split,div,公開無需 token
// 優先使用 adjclose(已自動處理股票分割 + 配息),
// 抓不到時 fallback 到 close
// range 用 6mo 抓夠用,然後切後 N 天
//
// 為什麼要 adjclose:
//   像 SMUP 在 2026/04/08 做了 1:25 逆向分割,
//   close 欄位會把「分割前」價格自動乘 25 對齊,
//   但配息再投入不會處理。
//   adjclose 同時處理 split 和 dividend,計算長期報酬最準。
// ════════════════════════════════════════════════
function fetchHistoricalCloses_(ticker, days) {
  const out = { ok: false, closes: [], timestamps: [], priceField: null, error: null };

  try {
    // range 用 6mo(夠涵蓋 90 天交易日 + 緩衝)
    // events=split,div 確保回傳會有 adjclose 欄位
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=6mo&interval=1d&events=split%2Cdiv`;

    const res = UrlFetchApp.fetch(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: {
        // Yahoo 有時擋無 UA 的請求
        'User-Agent': 'Mozilla/5.0 (compatible; StockSystem/1.0)'
      }
    });

    const code = res.getResponseCode();
    if (code !== 200) {
      out.error = `HTTP ${code}`;
      return out;
    }

    const json = JSON.parse(res.getContentText());
    const chart = json && json.chart;
    if (!chart || chart.error) {
      out.error = chart && chart.error ? chart.error.description : 'chart 回傳異常';
      return out;
    }

    const r = chart.result && chart.result[0];
    if (!r) {
      out.error = '無 result';
      return out;
    }

    const ts = r.timestamp || [];
    const indicators = r.indicators || {};

    // 優先 adjclose(自動處理 split + 配息);抓不到 fallback 到 close
    let pricesRaw = null;
    let priceField = null;
    if (indicators.adjclose && indicators.adjclose[0] && Array.isArray(indicators.adjclose[0].adjclose)) {
      pricesRaw = indicators.adjclose[0].adjclose;
      priceField = 'adjclose';
    } else if (indicators.quote && indicators.quote[0] && Array.isArray(indicators.quote[0].close)) {
      pricesRaw = indicators.quote[0].close;
      priceField = 'close (fallback)';
    }

    if (!pricesRaw || pricesRaw.length === 0 || ts.length === 0) {
      out.error = '價格陣列為空(adjclose 與 close 皆無)';
      return out;
    }

    // 過濾 null(Yahoo 偶會回 null)
    const filtered = [];
    const filteredTs = [];
    for (let i = 0; i < pricesRaw.length; i++) {
      if (pricesRaw[i] !== null && pricesRaw[i] !== undefined && !isNaN(pricesRaw[i])) {
        filtered.push(pricesRaw[i]);
        filteredTs.push(ts[i]);
      }
    }

    if (filtered.length < 10) {
      out.error = `有效${priceField}不足 10 筆(只有 ${filtered.length})`;
      return out;
    }

    // 切後 N 天(以交易日計)
    const sliceCount = Math.min(days, filtered.length);
    out.closes = filtered.slice(-sliceCount);
    out.timestamps = filteredTs.slice(-sliceCount);
    out.priceField = priceField;
    out.ok = true;
    return out;

  } catch (e) {
    out.error = e.message || String(e);
    return out;
  }
}


// ════════════════════════════════════════════════
// 內部函數:累積報酬 = 最新 / 最早 - 1
// ════════════════════════════════════════════════
function calcCumulativeReturn_(closes) {
  if (!closes || closes.length < 2) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  if (!first || first <= 0) return null;
  return (last / first) - 1;
}


// ════════════════════════════════════════════════
// 內部函數:耗損分級 + 顏色
// 規則:
//   decayPct < 0  → 實際表現優於理論(罕見,當作 mild)
//   < 5%           → mild 黃
//   5-15%          → warn 橘
//   ≥ 15%          → severe 紅
// ════════════════════════════════════════════════
function gradeDecay_(decayPct) {
  if (decayPct < 0) {
    return { level: 'mild', color: DECAY_COLORS.mild };
  }
  if (decayPct < DECAY_THRESHOLDS.MILD_MAX) {
    return { level: 'mild', color: DECAY_COLORS.mild };
  }
  if (decayPct < DECAY_THRESHOLDS.WARN_MAX) {
    return { level: 'warn', color: DECAY_COLORS.warn };
  }
  return { level: 'severe', color: DECAY_COLORS.severe };
}


// ════════════════════════════════════════════════
// 內部函數:組裝白話 note
// ════════════════════════════════════════════════
function buildNote_(ticker, detect, decayPct, undReturn, etfReturn) {
  const mult = detect.multiplier;
  const undName = detect.underlyingName ? `${detect.underlying}(${detect.underlyingName})` : detect.underlying;
  const undPctStr = (undReturn * 100).toFixed(1);
  const etfPctStr = (etfReturn * 100).toFixed(1);

  const sign = mult > 0 ? '正向' : '反向';
  const absMult = Math.abs(mult);
  const header = `${absMult}x ${sign}槓桿 / 標的:${undName}`;

  if (decayPct < 0) {
    return `${header}|過去 ${DECAY_DAYS} 天:${ticker} ${etfPctStr}% / 標的 ${undPctStr}%|實際表現優於理論值 ${(-decayPct).toFixed(2)}%(罕見,可能是再平衡時點優勢)`;
  }

  let levelDesc;
  if (decayPct < DECAY_THRESHOLDS.MILD_MAX) {
    levelDesc = '輕微';
  } else if (decayPct < DECAY_THRESHOLDS.WARN_MAX) {
    levelDesc = '警示';
  } else {
    levelDesc = '嚴重';
  }

  return `${header}|過去 ${DECAY_DAYS} 天:${ticker} ${etfPctStr}% / 標的 ${undPctStr}%|累積耗損 ${decayPct.toFixed(2)}%(${levelDesc})`;
}


// ════════════════════════════════════════════════
// 內部函數:四捨五入到指定小數位
// ════════════════════════════════════════════════
function round_(num, digits) {
  if (num === null || num === undefined || isNaN(num)) return null;
  const factor = Math.pow(10, digits);
  return Math.round(num * factor) / factor;
}


// ════════════════════════════════════════════════
// 測試函數(GAS 編輯器手動跑)
// ════════════════════════════════════════════════

/** 主測試:跑 RA 持股 + 常見槓桿 ETF + 非槓桿股,看完整結構 */
function testLeverageDecay() {
  const tickers = [
    'ORCX',   // RA 持股,2x ORCL
    'SMUP',   // RA 持股,2x SMR
    'TQQQ',   // 3x QQQ
    'SOXL',   // 3x SOXX
    'NVDX',   // 2x NVDA
    'AAPL',   // 非槓桿
    'NVDA',   // 非槓桿
  ];

  tickers.forEach(t => {
    Logger.log(`\n========== ${t} ==========`);
    const r = getLeverageDecay(t);
    Logger.log(`isLeveraged: ${r.isLeveraged}`);
    if (r.isLeveraged) {
      Logger.log(`倍數: ${r.multiplier}x  標的: ${r.underlying}(${r.underlyingName || '未知'})`);
      Logger.log(`對應來源: ${r.source}`);
      if (r.decay !== null) {
        Logger.log(`價格欄位: ${r.priceField}`);
        Logger.log(`標的報酬: ${(r.underlyingReturn * 100).toFixed(2)}%`);
        Logger.log(`理論報酬: ${(r.theoreticalReturn * 100).toFixed(2)}%`);
        Logger.log(`實際報酬: ${(r.actualReturn * 100).toFixed(2)}%`);
        Logger.log(`耗損: ${r.decayPct}% (${r.decayLevel} / ${r.decayColor})`);
      }
    }
    Logger.log(`note: ${r.note}`);
    if (r.error) Logger.log(`⚠️ error: ${r.error}`);
  });
}

/** 只測 RA 持股,看完整 JSON 結構 */
function testRAHoldings() {
  ['ORCX', 'SMUP'].forEach(t => {
    const r = getLeverageDecay(t);
    Logger.log(`\n${t}:`);
    Logger.log(JSON.stringify(r, null, 2));
  });
}

/** 測偵測規則(不抓股價,純測 detectLeverage_) */
function testDetectOnly() {
  const cases = [
    { t: 'ORCX',  expect: '白名單 2x ORCL' },
    { t: 'SMUP',  expect: '白名單 2x SMR' },
    { t: 'TQQQ',  expect: '白名單 3x QQQ' },
    { t: 'SQQQ',  expect: '白名單 -3x QQQ' },
    { t: 'GOOGX', expect: '結尾 X 推測 2x 但未知標的(若試算表有設則以試算表為準)' },
    { t: 'TEST3X',expect: '含 3X 但未知標的' },
    { t: 'AAPL',  expect: '非槓桿' },
    { t: 'NVDA',  expect: '非槓桿' },
    { t: 'SPX',   expect: '指數,非槓桿(避開 X 結尾誤判)' },
    { t: '',      expect: '空字串,非槓桿' },
  ];

  // 載入自訂表(會試讀試算表;沒分頁就回 {})
  const customMap = loadCustomLeverageMap_();
  Logger.log(`自訂表載入:${Object.keys(customMap).length} 筆對應`);
  if (Object.keys(customMap).length > 0) {
    Logger.log(`自訂內容:${JSON.stringify(customMap)}`);
  }
  Logger.log('---');

  cases.forEach(c => {
    const d = detectLeverage_(c.t.toUpperCase(), customMap);
    Logger.log(`${c.t.padEnd(8)} → isLev=${d.isLeveraged}, mult=${d.multiplier}, und=${d.underlying || '無'}, src=${d.source || '無'}  [預期:${c.expect}]`);
  });
}

/** 測一個未知標的的疑似槓桿(GOOGX),看 note 怎麼寫 */
function testUnknownLeverage() {
  const r = getLeverageDecay('GOOGX');
  Logger.log(JSON.stringify(r, null, 2));
}
