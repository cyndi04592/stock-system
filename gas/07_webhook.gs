// ════════════════════════════════════════════════
//  07_webhook.gs  LINE Webhook 處理
//  接收用戶傳來的訊息和圖片
// ════════════════════════════════════════════════

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    body.events.forEach(event => handleEvent(event));
  } catch(err) {
    Logger.log("Webhook錯誤: " + err.message);
  }
  return ContentService.createTextOutput("OK");
}

function doGet(e) {
  return ContentService.createTextOutput("OK");
}

// ── 分發事件 ─────────────────────────────────────
function handleEvent(event) {
  const userId     = event.source?.userId;
  const replyToken = event.replyToken;
  if (!userId) return;

  // 用戶加好友
  if (event.type === "follow") {
    handleFollow(userId, replyToken);
    return;
  }

  // 文字訊息
  if (event.type === "message" && event.message?.type === "text") {
    handleTextMessage(userId, event.message.text.trim(), replyToken);
    return;
  }

  // 圖片訊息（核心功能：拍照識別持股）
  if (event.type === "message" && event.message?.type === "image") {
    processImageMessage(userId, event.message.id, replyToken);
    return;
  }
}

// ── 新用戶加入 ───────────────────────────────────
function handleFollow(userId, replyToken) {
  let user = getUser(userId);
  if (!user) user = createUser(userId, "新朋友");

  replyToUser(replyToken, buildWelcomeMsg());
}

// ── 處理文字訊息 ─────────────────────────────────
function handleTextMessage(userId, text, replyToken) {
  let user = getUser(userId);
  if (!user) {
    user = createUser(userId, "新朋友");
    replyToUser(replyToken, buildWelcomeMsg());
    return;
  }

  const cmd = text.toLowerCase();

  // ── 設定步驟中 ──
  if (user.step === "set_stocks") {
    handleManualSetStocks(user, text, replyToken);
    return;
  }

  // ── 指令處理 ──

  // 說明
  if (["說明","help","?","？"].includes(cmd)) {
    replyToUser(replyToken, buildHelpMsg(user));
    return;
  }

  // 我的設定
  if (["我的設定","設定","my"].includes(cmd)) {
    replyToUser(replyToken, buildMySettingsMsg(user));
    return;
  }

  // 方案
  if (["方案","升級","price","訂閱"].includes(cmd)) {
    replyToUser(replyToken, buildPlanMsg());
    return;
  }

  // 手動設定股票
  if (cmd.startsWith("設定股票") || cmd.startsWith("修改股票")) {
    updateUserField(user.row, "step", "set_stocks");
    replyToUser(replyToken, buildSetStocksMsg(user));
    return;
  }

  // 查詢持股
  if (["持股","我的持股","庫存"].includes(cmd)) {
    const holdings = getUserHoldings(user.userId);
    if (holdings.length === 0) {
      replyToUser(replyToken, "你還沒有持股記錄。\n\n傳券商截圖給我，我自動幫你識別！");
    } else {
      const tickers = holdings.map(h=>h.ticker);
      const prices  = fetchPrices(tickers);
      let msg = `你的持股（${holdings.length}支）：\n\n`;
      holdings.forEach(h => {
        const pd = prices[h.ticker];
        if (!pd?.ok) { msg += `${h.ticker}  無法取得\n`; return; }
        const ret = h.avgPrice > 0 ? (pd.price-h.avgPrice)/h.avgPrice*100 : 0;
        msg += `${h.ticker}  ${pd.cur}${pd.price.toFixed(2)}  ${pd.pct>=0?"+":""}${pd.pct.toFixed(2)}%\n`;
        msg += `  ${h.shares}股  均價${pd.cur}${h.avgPrice}  報酬${ret>=0?"+":""}${ret.toFixed(0)}%\n\n`;
      });
      replyToUser(replyToken, msg.trim());
    }
    return;
  }

  // 立即分析
  if (["分析","今日分析","快報"].includes(cmd)) {
    replyToUser(replyToken, "分析中，請稍等...");
    const holdings = getUserHoldings(user.userId);
    if (holdings.length === 0) {
      pushToUser(userId, "你還沒有持股記錄。\n\n傳券商截圖給我，我自動幫你識別！");
      return;
    }
    const prices = fetchPrices(holdings.map(h=>h.ticker));
    const sp  = fetchPrice("^GSPC");
    const ndq = fetchPrice("^IXIC");
    const vix = fetchPrice("^VIX");
    const msg = buildDailyMessage(user, holdings, prices, sp, ndq, vix);
    pushToUser(userId, msg);
    return;
  }

  // 查詢單一股票：「查 ORCL」或直接傳代號
  const queryMatch = text.match(/^查\s*([A-Za-z0-9.]+)$/) ||
                     text.match(/^([A-Z]{2,6})$/) ||
                     text.match(/^(\d{4,6}(?:\.TW)?)$/i);
  if (queryMatch) {
    const ticker = queryMatch[1].toUpperCase();
    replyToUser(replyToken, "查詢中...");
    const result = quickAnalyze(ticker, user);
    pushToUser(userId, result);
    return;
  }

  // 預設
  replyToUser(replyToken, buildHelpMsg(user));
}

// ── 手動設定股票 ─────────────────────────────────
function handleManualSetStocks(user, text, replyToken) {
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;

  const tickers = text.toUpperCase()
    .replace(/[，、\s]+/g, ",")
    .split(",")
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 8);

  if (tickers.length === 0) {
    replyToUser(replyToken, "格式不對，請輸入股票代號\n\n範例：ORCL, SMR, 0050");
    return;
  }

  if (tickers.length > plan.maxStocks) {
    replyToUser(replyToken,
      `你的${plan.name}最多 ${plan.maxStocks} 支\n` +
      `你輸入了 ${tickers.length} 支\n\n` +
      `請減少，或傳「方案」查看升級選項`
    );
    return;
  }

  replyToUser(replyToken, "驗證中...");

  const valid   = [];
  const invalid = [];
  tickers.forEach(t => { sleep(200); fetchPrice(t).ok ? valid.push(t) : invalid.push(t); });

  if (valid.length === 0) {
    pushToUser(user.userId, `找不到這些代號：${tickers.join(", ")}\n\n美股範例：ORCL NVDA\n台股範例：0050 2330`);
    return;
  }

  // 更新用戶設定步驟
  updateUserField(user.row, "step", "done");

  // 建立持股記錄（沒有均價，只有追蹤）
  const holdings = valid.map(t => ({
    ticker: t,
    shares: 0,
    avgPrice: 0,
    market: /^\d/.test(t) ? "TW" : "US"
  }));
  updateUserHoldings(user.userId, holdings);

  let msg = `設定完成！追蹤：\n${valid.map(t => "  " + t).join("\n")}`;
  if (invalid.length > 0) msg += `\n\n找不到（略過）：${invalid.join(", ")}`;
  msg += `\n\n每天早上會推播分析給你！\n\n如果要同步持股數量和均價，請傳券商截圖給我。`;

  pushToUser(user.userId, msg);
}

// ── 訊息模板 ─────────────────────────────────────
function buildWelcomeMsg() {
  return `歡迎加入美股追蹤系統！

我每天幫你分析股票，直接推播給你，不用自己看盤。

最快的方式：
直接傳你的券商App庫存截圖給我，我自動識別你的持股！

或是輸入：設定股票 ORCL, SMR
手動設定要追蹤的股票代號。

試用版可以追蹤 2 支，傳「方案」查看升級選項。`;
}

function buildHelpMsg(user) {
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;
  return `指令說明  ${plan.name}

傳截圖      自動識別持股（最快）
設定股票    手動輸入代號
我的設定    查看目前設定
持股        查看持股和損益
分析        立即取得今日分析
查 ORCL    查詢單一股票
方案        查看訂閱方案`;
}

function buildMySettingsMsg(user) {
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;
  const holdings = getUserHoldings(user.userId);
  const expStr = user.expDate ? new Date(user.expDate).toLocaleDateString("zh-TW") : "無期限";
  return `你的設定\n\n方案：${plan.name}\n到期：${expStr}\n持股：${holdings.length > 0 ? holdings.map(h=>h.ticker).join(", ") : "未設定"}\n\n傳截圖可更新持股\n傳「方案」查看升級選項`;
}

function buildSetStocksMsg(user) {
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;
  const current = getUserHoldings(user.userId);
  const cur = current.length > 0 ? `目前：${current.map(h=>h.ticker).join(", ")}\n\n` : "";
  return `${cur}請輸入股票代號（最多 ${plan.maxStocks} 支）\n用逗號分開：\n\nORCL, SMR, 0050`;
}

function buildPlanMsg() {
  return `訂閱方案

試用版  免費  7天
  追蹤 2 支  基礎快報

基礎版  59元/月
  追蹤 3 支  每日快報  自動識別截圖

進階版  99元/月
  追蹤 8 支  AI深度分析  12式健診  TACO指標

VIP版  199元/月
  追蹤 20 支  全部功能  盤前盤後通知  優先回覆

要升級請聯繫管理員`;
}
