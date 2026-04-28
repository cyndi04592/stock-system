// ════════════════════════════════════════════════
//  03_stocks.gs  股價抓取（美股 + 台股）
// ════════════════════════════════════════════════

function fetchPrice(ticker) {
  const isTW = /^\d{4,5}/.test(ticker) || ticker.includes(".TW");
  const symbol = isTW ? (ticker.includes(".TW") ? ticker : ticker + ".TW") : ticker;

  // 主力：Yahoo Finance v6
  try {
    const url = `https://query2.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const q = JSON.parse(res.getContentText()).quoteResponse?.result?.[0];
    if (q && q.regularMarketPrice > 0) {
      const price = q.regularMarketPrice;
      const prev  = q.regularMarketPreviousClose || price;
      const pct   = prev > 0 ? (price - prev) / prev * 100 : 0;
      return {
        ticker, symbol, price, prev, pct,
        vol:    q.regularMarketVolume || 0,
        avgVol: q.averageDailyVolume10Day || 0,
        high52: q.fiftyTwoWeekHigh || 0,
        low52:  q.fiftyTwoWeekLow || 0,
        name:   q.shortName || q.longName || ticker,
        cur:    isTW ? "NT$" : "$",
        isTW, ok: true,
      };
    }
  } catch(e) { Logger.log("股價失敗 " + ticker + ": " + e.message); }

  // 備用：Yahoo v8
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const meta = JSON.parse(res.getContentText()).chart?.result?.[0]?.meta;
    if (meta?.regularMarketPrice > 0) {
      const price = meta.regularMarketPrice;
      const prev  = meta.previousClose || price;
      return {
        ticker, symbol, price, prev,
        pct: prev > 0 ? (price-prev)/prev*100 : 0,
        vol: meta.regularMarketVolume || 0, avgVol: 0,
        high52: meta.fiftyTwoWeekHigh || 0,
        low52:  meta.fiftyTwoWeekLow  || 0,
        name: ticker, cur: isTW ? "NT$" : "$",
        isTW, ok: true,
      };
    }
  } catch(e) {}

  return { ticker, price:0, pct:0, cur: isTW?"NT$":"$", isTW, ok:false };
}

// 批次抓取（自動間隔避免被擋）
function fetchPrices(tickers) {
  const results = {};
  tickers.forEach((t, i) => {
    if (i > 0 && i % 5 === 0) sleep(500);
    results[t] = fetchPrice(t);
  });
  return results;
}

// 格式化單一股票顯示
function formatStockLine(sd) {
  if (!sd.ok) return `${sd.ticker}  無法取得`;
  const sign = sd.pct >= 0 ? "+" : "";
  const alert = Math.abs(sd.pct) >= CFG.ALERT_PCT ? "  !!!" : "";
  return `${sd.ticker}  ${sd.cur}${sd.price.toFixed(2)}  ${sign}${sd.pct.toFixed(2)}%${alert}`;
}

// 鯨魚偵測
function detectWhale(sd) {
  if (!sd?.ok || !sd.avgVol || sd.avgVol === 0) return null;
  const mult = sd.vol / sd.avgVol;
  if (mult < CFG.WHALE_VOL_MULT) return null;
  const range = sd.high52 - sd.low52;
  const pos = range > 0 ? (sd.price - sd.low52) / range : 0.5;
  if (pos < 0.15) return `鯨魚吸籌 量${mult.toFixed(1)}x 接近52週低點`;
  if (pos > 0.85) return `鯨魚出貨? 量${mult.toFixed(1)}x 接近52週高點`;
  return `爆量 ${mult.toFixed(1)}x 均量 方向待確認`;
}
