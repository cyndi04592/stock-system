// ════════════════════════════════════════════════
//  02_users.gs  用戶管理
// ════════════════════════════════════════════════
//  欄位：A=UserID B=暱稱 C=方案 D=到期日
//        E=狀態 F=設定步驟 G=加入日期 H=備註

function getUserSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let ws = ss.getSheetByName(CFG.SHEETS.users);
  if (!ws) {
    ws = ss.insertSheet(CFG.SHEETS.users);
    ws.getRange(1,1,1,8).setValues([[
      "UserID","暱稱","方案","到期日","狀態","步驟","加入日期","備註"
    ]]).setBackground("#0A1E35").setFontColor("#F5A623").setFontWeight("bold");
    ws.setFrozenRows(1);
    [160,80,60,100,60,80,100,120].forEach((w,i)=>ws.setColumnWidth(i+1,w));
  }
  return ws;
}

function getUser(userId) {
  const ws = getUserSheet();
  const data = ws.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim() === userId) {
      return {
        row:    i + 1,
        userId: userId,
        name:   String(data[i][1]).trim() || "用戶",
        plan:   String(data[i][2]).trim() || "trial",
        expDate:data[i][3],
        status: String(data[i][4]).trim() || "active",
        step:   String(data[i][5]).trim() || "done",
      };
    }
  }
  return null;
}

function createUser(userId, name) {
  const ws = getUserSheet();
  const now = new Date();
  const exp = new Date(now.getTime() + 7*24*60*60*1000);
  ws.appendRow([userId, name, "trial", exp, "active", "welcome", now, "新用戶"]);
  return getUser(userId);
}

function updateUserField(row, field, value) {
  const cols = {userId:1,name:2,plan:3,expDate:4,status:5,step:6,joinDate:7,note:8};
  if (cols[field]) {
    SpreadsheetApp.getActiveSpreadsheet()
      .getSheetByName(CFG.SHEETS.users)
      .getRange(row, cols[field]).setValue(value);
  }
}

function isUserActive(user) {
  if (!user || user.status !== "active") return false;
  if (user.expDate && new Date(user.expDate) < new Date()) return false;
  return true;
}

function getAllActiveUsers() {
  const ws = getUserSheet();
  const data = ws.getDataRange().getValues();
  if (data.length <= 1) return [];
  return data.slice(1)
    .map((row, i) => ({
      row:    i + 2,
      userId: String(row[0]).trim(),
      name:   String(row[1]).trim() || "用戶",
      plan:   String(row[2]).trim() || "trial",
      expDate:row[3],
      status: String(row[4]).trim() || "active",
      step:   String(row[5]).trim() || "done",
    }))
    .filter(u => u.userId && isUserActive(u));
}

// 管理員：新增用戶
function adminAddUser(userId, name, plan) {
  const ws = getUserSheet();
  const now = new Date();
  const days = CFG.PLANS[plan]?.days || 30;
  const exp = new Date(now.getTime() + days*24*60*60*1000);
  ws.appendRow([userId, name, plan, exp, "active", "done", now, "管理員新增"]);
  Logger.log(`新增用戶：${name} (${plan}) 到期：${exp.toLocaleDateString()}`);
}

// 管理員：更新方案
function adminUpgradePlan(userId, newPlan) {
  const user = getUser(userId);
  if (!user) { Logger.log("找不到：" + userId); return; }
  const days = CFG.PLANS[newPlan]?.days || 30;
  const exp = new Date(new Date().getTime() + days*24*60*60*1000);
  updateUserField(user.row, "plan", newPlan);
  updateUserField(user.row, "expDate", exp);
  pushToUser(userId, `方案已升級為 ${CFG.PLANS[newPlan]?.name}！感謝訂閱！`);
  Logger.log(`升級：${userId} → ${newPlan}`);
}
