// ════════════════════════════════════════════════
//  08_admin.gs  管理員功能 + 選單
// ════════════════════════════════════════════════

function onOpen() {
  SpreadsheetApp.getUi().createMenu("系統管理")
    .addItem("初始化所有工作表",   "adminInitAll")
    .addItem("設定自動推播觸發",   "setupPushTriggers")
    .addSeparator()
    .addItem("立即推播所有用戶",   "sendDailyAll")
    .addItem("查看訂閱統計",       "adminStats")
    .addSeparator()
    .addItem("測試推播給自己",     "adminTestPush")
    .addItem("測試截圖識別",       "adminTestVision")
    .addSeparator()
    .addItem("新增用戶",           "adminAddUserUI")
    .addItem("升級用戶方案",       "adminUpgradeUI")
    .addToUi();
}

// ── 初始化 ───────────────────────────────────────
function adminInitAll() {
  getUserSheet();
  getHoldingSheet();

  // 建立推播紀錄
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let logWs = ss.getSheetByName(CFG.SHEETS.log);
  if (!logWs) {
    logWs = ss.insertSheet(CFG.SHEETS.log);
    logWs.getRange(1,1,1,5).setValues([["時間","UserID","暱稱","類型","結果"]])
      .setBackground("#0A1E35").setFontColor("#F5A623").setFontWeight("bold");
  }

  SpreadsheetApp.getUi().alert(
    "初始化完成！\n\n" +
    "建立的工作表：\n" +
    "  用戶\n  持股\n  推播紀錄\n\n" +
    "接下來：\n" +
    "1. 在 01_config.gs 填入 LINE Token\n" +
    "2. 填入 Claude API Key\n" +
    "3. 部署 Webhook\n" +
    "4. 設定自動推播觸發"
  );
}

// ── 統計 ─────────────────────────────────────────
function adminStats() {
  const users = getAllActiveUsers();
  const counts = { trial:0, basic:0, pro:0, vip:0 };
  users.forEach(u => { counts[u.plan] = (counts[u.plan]||0) + 1; });

  const revenue = counts.basic*59 + counts.pro*99 + counts.vip*199;

  SpreadsheetApp.getUi().alert(
    `訂閱統計\n\n` +
    `總用戶：${users.length} 人\n` +
    `試用：${counts.trial} 人\n` +
    `基礎(59元)：${counts.basic} 人\n` +
    `進階(99元)：${counts.pro} 人\n` +
    `VIP(199元)：${counts.vip} 人\n\n` +
    `月收入估算：${revenue} 元\n\n` +
    `LINE則數：${users.length} 則/天  ${users.length*30} 則/月`
  );
}

// ── 測試推播 ─────────────────────────────────────
function adminTestPush() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt("測試推播", "輸入你的LINE UserID：", ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;

  const userId = r.getResponseText().trim();
  const ok = pushToUser(userId,
    "測試推播成功！\n\n" +
    "這是美股追蹤訂閱系統\n" +
    "每天早上8:30自動推播個人化分析\n" +
    "傳截圖可自動識別持股\n\n" +
    `現在時間：${getTWTimeStr()}`
  );
  ui.alert(ok ? "推播成功！請查看LINE" : "推播失敗，請確認Token");
}

// ── 測試截圖識別 ─────────────────────────────────
function adminTestVision() {
  const ui = SpreadsheetApp.getUi();
  ui.alert(
    "截圖識別測試說明\n\n" +
    "請用LINE傳一張券商截圖給Bot\n" +
    "系統會自動識別持股並更新\n\n" +
    "支援的截圖：\n" +
    "  庫存/持倉頁面\n" +
    "  成交記錄\n" +
    "  損益頁面"
  );
}

// ── 新增用戶 UI ──────────────────────────────────
function adminAddUserUI() {
  const ui = SpreadsheetApp.getUi();

  const idR = ui.prompt("新增用戶", "LINE UserID（U開頭）：", ui.ButtonSet.OK_CANCEL);
  if (idR.getSelectedButton() !== ui.Button.OK) return;

  const nameR = ui.prompt("新增用戶", "用戶暱稱：", ui.ButtonSet.OK_CANCEL);
  if (nameR.getSelectedButton() !== ui.Button.OK) return;

  const planR = ui.prompt("新增用戶", "方案（trial/basic/pro/vip）：", ui.ButtonSet.OK_CANCEL);
  if (planR.getSelectedButton() !== ui.Button.OK) return;

  const userId = idR.getResponseText().trim();
  const name   = nameR.getResponseText().trim();
  const plan   = planR.getResponseText().trim();

  if (!userId || !name || !CFG.PLANS[plan]) {
    ui.alert("輸入有誤，請重新操作");
    return;
  }

  adminAddUser(userId, name, plan);

  // 傳歡迎訊息給用戶
  pushToUser(userId,
    `${name} 歡迎加入！\n\n` +
    `你的方案：${CFG.PLANS[plan]?.name}\n\n` +
    `請傳券商截圖給我，我自動識別你的持股！\n` +
    `或是傳「設定股票 代號」手動設定。`
  );

  ui.alert(`新增完成！\n${name} (${plan})\n已傳送歡迎訊息`);
}

// ── 升級用戶 UI ──────────────────────────────────
function adminUpgradeUI() {
  const ui = SpreadsheetApp.getUi();

  const idR = ui.prompt("升級方案", "LINE UserID：", ui.ButtonSet.OK_CANCEL);
  if (idR.getSelectedButton() !== ui.Button.OK) return;

  const planR = ui.prompt("升級方案", "新方案（basic/pro/vip）：", ui.ButtonSet.OK_CANCEL);
  if (planR.getSelectedButton() !== ui.Button.OK) return;

  const userId = idR.getResponseText().trim();
  const plan   = planR.getResponseText().trim();

  if (!CFG.PLANS[plan]) { ui.alert("方案名稱錯誤"); return; }

  adminUpgradePlan(userId, plan);
  ui.alert(`升級完成！已通知用戶`);
}
