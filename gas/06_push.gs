// ════════════════════════════════════════════════
//  06_push.gs  LINE 個人化推播
//  每個用戶收到自己的股票分析
// ════════════════════════════════════════════════

// ── Push 給單一用戶 ──────────────────────────────
function pushToUser(userId, message) {
  if (!CFG.LINE_TOKEN || CFG.LINE_TOKEN.includes("貼上")) {
    Logger.log("LINE Token未設定：" + message);
    return false;
  }
  try {
    const res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CFG.LINE_TOKEN}`
      },
      payload: JSON.stringify({
        to: userId,
        messages: [{ type: "text", text: String(message).slice(0, 4999) }]
      }),
      muteHttpExceptions: true
    });
    return res.getResponseCode() === 200;
  } catch(e) {
    Logger.log("Push失敗 " + userId + ": " + e.message);
    return false;
  }
}

// ── Reply Token 即時回覆 ─────────────────────────
function replyToUser(replyToken, message) {
  if (!CFG.LINE_TOKEN || CFG.LINE_TOKEN.includes("貼上")) return;
  try {
    UrlFetchApp.fetch("https://api.line.me/v2/bot/message/reply", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CFG.LINE_TOKEN}`
      },
      payload: JSON.stringify({
        replyToken,
        messages: [{ type: "text", text: String(message).slice(0, 4999) }]
      }),
      muteHttpExceptions: true
    });
  } catch(e) { Logger.log("Reply失敗: " + e.message); }
}

// ── 每日個人化推播（每天早上自動跑）─────────────
function sendDailyAll() {
  if (!isTradingDay()) { Logger.log("週末跳過"); return; }

  const users = getAllActiveUsers();
  Logger.log(`開始推播，共 ${users.length} 位用戶`);

  // 先取大盤數據（所有人共用）
  const sp  = fetchPrice("^GSPC");
  const ndq = fetchPrice("^IXIC");
  const vix = fetchPrice("^VIX");

  let successCount = 0;

  users.forEach((user, i) => {
    if (i > 0) sleep(600); // 間隔避免LINE rate limit

    try {
      // 取得該用戶的持股
      const holdings = getUserHoldings(user.userId);

      if (holdings.length === 0) {
        // 沒有持股，提醒設定
        pushToUser(user.userId,
          `${user.name} 早安！\n\n你還沒有設定追蹤的股票。\n\n` +
          `最快的方式：\n直接傳券商App的庫存截圖給我，我會自動識別你的持股！\n\n` +
          `或是傳「設定股票 ORCL,SMR」手動設定。`
        );
        return;
      }

      // 批次抓取股價
      const tickers = holdings.map(h => h.ticker);
      const prices  = fetchPrices(tickers);

      // 建立個人化訊息
      const msg = buildDailyMessage(user, holdings, prices, sp, ndq, vix);

      const ok = pushToUser(user.userId, msg);
      if (ok) successCount++;

      // 寫入推播紀錄
      logPush(user.userId, user.name, "每日快報", ok);

    } catch(e) {
      Logger.log(`推播失敗 ${user.userId}: ${e.message}`);
    }
  });

  Logger.log(`推播完成：${successCount}/${users.length} 成功`);
}

// ── 組合每日訊息 ─────────────────────────────────
function buildDailyMessage(user, holdings, prices, sp, ndq, vix) {
  const plan     = CFG.PLANS[user.plan] || CFG.PLANS.trial;
  const dateStr  = getTWTimeStr();
  const planName = plan.name;

  // 大盤區
  const spLine  = sp.ok  ? `S&P500  ${sp.price.toFixed(0)}  ${sp.pct>=0?"+":""}${sp.pct.toFixed(2)}%` : "";
  const ndqLine = ndq.ok ? `Nasdaq  ${ndq.price.toFixed(0)}  ${ndq.pct>=0?"+":""}${ndq.pct.toFixed(2)}%` : "";
  const vixLine = vix.ok ? `VIX  ${vix.price.toFixed(1)}  ${vix.price>30?"極度恐慌":vix.price>20?"偏高":"穩定"}` : "";

  // 持股區
  const stockLines = holdings.map(h => {
    const pd = prices[h.ticker];
    if (!pd?.ok) return `${h.ticker}  無法取得`;
    const ret  = h.avgPrice > 0 ? (pd.price - h.avgPrice) / h.avgPrice * 100 : 0;
    const sign = pd.pct >= 0 ? "+" : "";
    const retSign = ret >= 0 ? "+" : "";
    const whale = detectWhale(pd);
    let line = `${h.ticker}  ${pd.cur}${pd.price.toFixed(2)}  ${sign}${pd.pct.toFixed(2)}%  報酬${retSign}${ret.toFixed(0)}%`;
    if (whale) line += `\n  ${whale}`;
    return line;
  }).join("\n");

  // Claude分析（依方案不同）
  const analysis = analyzeForUser(user, holdings, prices);

  // 組合
  const parts = [
    `━━━━━━━━━━━━━━━`,
    `${user.name} 早安  ${dateStr}`,
    `${planName}  追蹤 ${holdings.length} 支`,
    `━━━━━━━━━━━━━━━`,
    `大盤`,
    [spLine, ndqLine, vixLine].filter(Boolean).join("\n"),
    ``,
    `你的持股`,
    stockLines,
    ``,
    `━━━━━━━━━━━━━━━`,
    `AI分析`,
    analysis,
    `━━━━━━━━━━━━━━━`,
    `傳截圖可更新持股`,
    `傳「查 代號」查詢股價`
  ].filter(s => s !== undefined).join("\n").replace(/\n{3,}/g, "\n\n");

  return parts;
}

// ── 寫推播紀錄 ──────────────────────────────────
function logPush(userId, name, type, success) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(CFG.SHEETS.log);
  if (!ws) {
    ws = ss.insertSheet(CFG.SHEETS.log);
    ws.getRange(1,1,1,5).setValues([["時間","UserID","暱稱","類型","結果"]])
      .setBackground("#0A1E35").setFontColor("#F5A623").setFontWeight("bold");
  }
  ws.appendRow([new Date(), userId, name, type, success ? "成功" : "失敗"]);
}

// ── 觸發條件設定 ─────────────────────────────────
function setupPushTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // 每天早上8:30推播
  ScriptApp.newTrigger("sendDailyAll")
    .timeBased().everyDays(1).atHour(8).nearMinute(30).create();
  Logger.log("觸發條件設定完成：每天 08:30 個人化推播");
  SpreadsheetApp.getUi().alert("設定完成！\n每天 08:30 自動推播給所有訂閱用戶");
}
