// ════════════════════════════════════════════════
//  05_analysis.gs  Claude 個人化分析
//  依方案給不同深度的分析
// ════════════════════════════════════════════════

// ── 主分析函數 ───────────────────────────────────
function analyzeForUser(user, holdings, prices) {
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;

  if (plan.analysis === "full") {
    return analyzeFullVersion(user, holdings, prices);
  } else {
    return analyzeBasicVersion(user, holdings, prices);
  }
}

// ── 基礎版分析（59元以下）─────────────────────────
function analyzeBasicVersion(user, holdings, prices) {
  const lines = [];

  holdings.forEach(h => {
    const pd = prices[h.ticker];
    if (!pd?.ok) { lines.push(`${h.ticker}  無法取得`); return; }

    const ret = h.avgPrice > 0 ? (pd.price - h.avgPrice) / h.avgPrice * 100 : 0;
    const sign = pd.pct >= 0 ? "+" : "";
    const retSign = ret >= 0 ? "+" : "";

    let advice = "";
    if (Math.abs(pd.pct) >= 5) {
      advice = pd.pct >= 5 ? "大漲，注意適時獲利" : "大跌，確認基本面";
    } else if (ret >= 30) {
      advice = "累積獲利不錯，可考慮賣1/3";
    } else if (ret <= -15) {
      advice = "虧損偏大，重新評估邏輯";
    } else {
      advice = "正常波動，繼續持有";
    }

    lines.push(`${h.ticker}  ${pd.cur}${pd.price.toFixed(2)}  ${sign}${pd.pct.toFixed(1)}%  報酬${retSign}${ret.toFixed(0)}%\n  建議：${advice}`);
  });

  return lines.join("\n\n");
}

// ── 進階版分析（99元以上）─────────────────────────
function analyzeFullVersion(user, holdings, prices) {
  try {
    // 整理持股資料給Claude
    const holdingLines = holdings.map(h => {
      const pd = prices[h.ticker];
      if (!pd?.ok) return `${h.ticker}  無法取得股價`;
      const ret = h.avgPrice > 0 ? (pd.price - h.avgPrice) / h.avgPrice * 100 : 0;
      const whale = detectWhale(pd);
      return [
        `${h.ticker}（${h.shares}股 均價${pd.cur}${h.avgPrice}）`,
        `現價：${pd.cur}${pd.price.toFixed(2)}  今日：${pd.pct>=0?"+":""}${pd.pct.toFixed(2)}%`,
        `報酬：${ret>=0?"+":""}${ret.toFixed(1)}%`,
        whale ? `鯨魚訊號：${whale}` : ""
      ].filter(Boolean).join("\n");
    }).join("\n\n");

    // 取得大盤數據
    const sp = fetchPrice("^GSPC");
    const vix = fetchPrice("^VIX");
    const marketStr = [
      sp.ok ? `S&P500 ${sp.price.toFixed(0)} ${sp.pct>=0?"+":""}${sp.pct.toFixed(2)}%` : "",
      vix.ok ? `VIX ${vix.price.toFixed(1)} ${vix.price>30?"極度恐慌":vix.price>20?"偏高":"穩定"}` : ""
    ].filter(Boolean).join("  ");

    const isVIP = user.plan === "vip";

    const prompt = `你是專業股票分析師，請用繁體中文白話文，給這位訂閱者個人化分析。

【訂閱者】${user.name}  方案：${CFG.PLANS[user.plan]?.name}
【今日大盤】${marketStr}

【持倉狀況】
${holdingLines}

請用以下格式回覆，白話文，每點不超過25字：

${holdings.map(h => {
  const pd = prices[h.ticker];
  if (!pd?.ok) return "";
  const ret = h.avgPrice > 0 ? (pd.price-h.avgPrice)/h.avgPrice*100 : 0;
  return `【${h.ticker}】
今日：${pd.pct>=0?"上漲":"下跌"}${Math.abs(pd.pct).toFixed(1)}%
白話建議：${getAdviceHint(pd.pct, ret)}`;
}).filter(Boolean).join("\n\n")}

${isVIP ? "\n【TACO指標】\n川普最新動態對持倉影響一句話" : ""}

【今日總結】
一句話說明整體操作建議（賣全部/賣一半/賣1/3/繼續持有/加碼）`;

    const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CFG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }]
      }),
      muteHttpExceptions: true
    });

    return JSON.parse(res.getContentText()).content?.[0]?.text || analyzeBasicVersion(user, holdings, prices);

  } catch(e) {
    Logger.log("進階分析失敗，改用基礎版: " + e.message);
    return analyzeBasicVersion(user, holdings, prices);
  }
}

// 給Claude的操作提示
function getAdviceHint(todayPct, returnPct) {
  if (returnPct >= 60)  return "獲利超過60%，可考慮賣1/3";
  if (returnPct >= 30)  return "獲利超過30%，可考慮賣1/3";
  if (returnPct <= -50) return "虧損超過50%，評估是否停損";
  if (returnPct <= -15) return "虧損超過15%，重新評估邏輯";
  if (todayPct >= 10)   return "今日大漲，注意適時獲利了結";
  if (todayPct <= -10)  return "今日大跌，確認基本面是否改變";
  return "正常波動，繼續持有觀察";
}

// ── 單一股票快速查詢 ─────────────────────────────
function quickAnalyze(ticker, user) {
  const pd = fetchPrice(ticker);
  if (!pd.ok) return `查不到 ${ticker} 的股價，請確認代號`;

  const sign = pd.pct >= 0 ? "+" : "";
  const whale = detectWhale(pd);
  const plan = CFG.PLANS[user.plan] || CFG.PLANS.trial;

  let msg = `${ticker} 即時報價\n${pd.cur}${pd.price.toFixed(2)}  ${sign}${pd.pct.toFixed(2)}%\n52週高：${pd.cur}${pd.high52.toFixed(2)}\n52週低：${pd.cur}${pd.low52.toFixed(2)}`;

  if (whale) msg += `\n\n鯨魚訊號：${whale}`;

  // 進階版以上才有即時分析
  if (plan.analysis === "full") {
    try {
      const prompt = `${ticker} 今日 ${pd.cur}${pd.price.toFixed(2)} ${sign}${pd.pct.toFixed(2)}%\n用一句白話文說明今日走勢和操作建議，不超過30字`;
      const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
        method: "post",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": CFG.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        payload: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 80,
          messages: [{ role: "user", content: prompt }]
        }),
        muteHttpExceptions: true
      });
      const analysis = JSON.parse(res.getContentText()).content?.[0]?.text;
      if (analysis) msg += `\n\nAI分析：${analysis}`;
    } catch(e) {}
  }

  return msg;
}
