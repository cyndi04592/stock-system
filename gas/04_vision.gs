// ════════════════════════════════════════════════
//  04_vision.gs  拍照識別持股
//  用戶拍券商截圖傳LINE → Claude Vision識別
//  → 自動更新持股資料，不用手動Key
// ════════════════════════════════════════════════

// ── 持股工作表設定 ──────────────────────────────
//  A=UserID B=代號 C=股數 D=均價 E=市場
//  F=板塊 G=備註 H=最後更新

function getHoldingSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(CFG.SHEETS.holdings);
  if (!ws) {
    ws = ss.insertSheet(CFG.SHEETS.holdings);
    ws.getRange(1,1,1,8).setValues([[
      "UserID","代號","股數","均價","市場","板塊","備註","最後更新"
    ]]).setBackground("#0A1E35").setFontColor("#F5A623").setFontWeight("bold");
    ws.setFrozenRows(1);
    [160,70,70,80,50,100,150,120].forEach((w,i)=>ws.setColumnWidth(i+1,w));
  }
  return ws;
}

// ── 主函數：識別圖片並更新持股 ──────────────────
function recognizeHoldingImage(userId, imageBase64, mimeType) {
  try {
    // Step1: 呼叫 Claude Vision 識別圖片
    const recognized = callClaudeVision(imageBase64, mimeType);
    if (!recognized || recognized.length === 0) return null;

    // Step2: 更新該用戶的持股資料
    updateUserHoldings(userId, recognized);

    return recognized;
  } catch(e) {
    Logger.log("識別失敗 " + userId + ": " + e.message);
    return null;
  }
}

// ── Claude Vision 識別 ───────────────────────────
function callClaudeVision(imageBase64, mimeType) {
  const prompt = `你是專業的股票截圖識別助手。

請仔細分析這張券商App的截圖，識別所有持股資訊。

支援的截圖類型：
- 庫存/持倉頁面（最常見）
- 成交記錄
- 對帳單
- 損益頁面

請識別出所有股票，並以JSON格式回覆，不要有其他文字：

[
  {
    "ticker": "股票代號（美股如ORCL，台股如0050）",
    "shares": 股數（數字，不含逗號）,
    "avgPrice": 均價（數字，不含貨幣符號）,
    "market": "US或TW",
    "currency": "USD或TWD",
    "sector": "板塊（如果看得出來）",
    "unrealizedPnl": 未實現損益（如果有的話，數字）,
    "returnPct": 報酬率（如果有的話，如-59.1）
  }
]

注意：
- 台股代號通常是4位數字（如0050、2330、00631L）
- 美股代號通常是英文字母（如ORCL、SMUP、NVDA）
- 如果有反向拆分的警示請忽略，以截圖上的數字為準
- 只回傳JSON，不要說明文字`;

  try {
    const res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CFG.CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-opus-4-6",  // Vision用最強的
        max_tokens: 1000,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mimeType || "image/jpeg",
                data: imageBase64
              }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }]
      }),
      muteHttpExceptions: true
    });

    const result = JSON.parse(res.getContentText());
    const text = result.content?.[0]?.text || "";

    // 解析JSON
    const cleaned = text.replace(/```json|```/g, "").trim();
    const holdings = JSON.parse(cleaned);

    if (!Array.isArray(holdings)) return null;
    Logger.log(`識別成功：${holdings.length} 支股票`);
    return holdings;

  } catch(e) {
    Logger.log("Claude Vision 失敗: " + e.message);
    return null;
  }
}

// ── 更新用戶持股 ────────────────────────────────
function updateUserHoldings(userId, holdings) {
  const ws = getHoldingSheet();
  const data = ws.getDataRange().getValues();
  const now = new Date();

  // 找出該用戶現有的持股行號
  const existingRows = [];
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      existingRows.push(i + 1);
    }
  }

  // 刪除舊的持股（從後往前刪避免行號跑掉）
  existingRows.reverse().forEach(row => ws.deleteRow(row));

  // 寫入新的持股
  holdings.forEach(h => {
    if (!h.ticker || !h.shares) return;
    ws.appendRow([
      userId,
      String(h.ticker).toUpperCase().trim(),
      parseFloat(h.shares) || 0,
      parseFloat(h.avgPrice) || 0,
      h.market || (isNaN(h.ticker.charAt(0)) ? "US" : "TW"),
      h.sector || "",
      h.returnPct ? `報酬${h.returnPct}%` : "",
      now
    ]);
  });

  Logger.log(`更新持股：${userId} 共 ${holdings.length} 支`);
}

// ── 取得用戶持股 ────────────────────────────────
function getUserHoldings(userId) {
  const ws = getHoldingSheet();
  const data = ws.getDataRange().getValues();
  if (data.length <= 1) return [];

  return data.slice(1)
    .filter(row => String(row[0]).trim() === userId && row[1])
    .map(row => ({
      userId:   String(row[0]).trim(),
      ticker:   String(row[1]).trim().toUpperCase(),
      shares:   parseFloat(row[2]) || 0,
      avgPrice: parseFloat(row[3]) || 0,
      market:   String(row[4]).trim() || "US",
      sector:   String(row[5]).trim() || "",
      note:     String(row[6]).trim() || "",
      updated:  row[7],
    }))
    .filter(h => h.ticker && h.shares > 0);
}

// ── 從LINE取得圖片並識別 ─────────────────────────
function processImageMessage(userId, messageId, replyToken) {
  try {
    // 先回覆用戶告知處理中
    replyToUser(replyToken, "收到截圖，識別中...\n請稍等約10秒");

    // 從LINE取得圖片
    const imageRes = UrlFetchApp.fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: { "Authorization": `Bearer ${CFG.LINE_TOKEN}` },
        muteHttpExceptions: true
      }
    );

    if (imageRes.getResponseCode() !== 200) {
      pushToUser(userId, "圖片取得失敗，請重新傳送");
      return;
    }

    // 轉Base64
    const blob = imageRes.getBlob();
    const mimeType = blob.getContentType() || "image/jpeg";
    const base64 = Utilities.base64Encode(blob.getBytes());

    // Claude Vision 識別
    const holdings = recognizeHoldingImage(userId, base64, mimeType);

    if (!holdings || holdings.length === 0) {
      pushToUser(userId,
        "識別失敗，請確認：\n" +
        "1. 截圖要清楚不模糊\n" +
        "2. 要有庫存/持倉頁面\n" +
        "3. 要看得到股票代號和股數\n\n" +
        "請重新傳送截圖"
      );
      return;
    }

    // 整理識別結果給用戶看
    let msg = `識別完成！找到 ${holdings.length} 支持股：\n\n`;
    holdings.forEach(h => {
      const cur = h.market === "TW" ? "NT$" : "$";
      msg += `${h.ticker}  ${h.shares}股  均價${cur}${h.avgPrice}\n`;
      if (h.returnPct) msg += `  報酬：${h.returnPct}%\n`;
    });

    msg += `\n已自動更新你的持股資料！\n每天早上會根據這些持股推播分析給你。\n\n如果數字有誤，請重新傳送正確截圖。`;

    pushToUser(userId, msg);

    // 同時更新追蹤股票清單（讓推播系統知道要分析哪些股票）
    const tickers = holdings.map(h => h.ticker).join(",");
    const user = getUser(userId);
    if (user) updateUserField(user.row, "step", "done");

    Logger.log(`圖片識別完成：${userId} ${holdings.length}支`);

  } catch(e) {
    Logger.log("圖片處理失敗: " + e.message);
    pushToUser(userId, "系統發生錯誤，請稍後再試或重新傳送截圖");
  }
}

// ── 手動測試（管理員用）─────────────────────────
function testVisionWithUrl(imageUrl, userId) {
  try {
    const res = UrlFetchApp.fetch(imageUrl, { muteHttpExceptions: true });
    const base64 = Utilities.base64Encode(res.getBlob().getBytes());
    const mimeType = res.getBlob().getContentType() || "image/jpeg";

    const holdings = callClaudeVision(base64, mimeType);
    Logger.log("識別結果：");
    Logger.log(JSON.stringify(holdings, null, 2));

    if (holdings && userId) {
      updateUserHoldings(userId, holdings);
      Logger.log("已更新用戶持股");
    }

    return holdings;
  } catch(e) {
    Logger.log("測試失敗: " + e.message);
    return null;
  }
}
