// ════════════════════════════════════════════════
//  01_config.gs  全域設定
//  所有其他檔案都會用到這裡的設定
// ════════════════════════════════════════════════

const CFG = {
  // LINE
  LINE_TOKEN:     "貼上你的LINE Channel Access Token",

  // Claude API
  CLAUDE_API_KEY: "貼上你的Claude API Key",

  // 匯率
  USD_TWD: 32.0,

  // 方案定義
  PLANS: {
    trial: { name:"試用版", price:0,   days:7,  maxStocks:2,  vision:false, analysis:"basic"  },
    basic: { name:"基礎版", price:59,  days:30, maxStocks:3,  vision:true,  analysis:"basic"  },
    pro:   { name:"進階版", price:99,  days:30, maxStocks:8,  vision:true,  analysis:"full"   },
    vip:   { name:"VIP版",  price:199, days:30, maxStocks:20, vision:true,  analysis:"full"   },
  },

  // Google Sheet 分頁名稱
  SHEETS: {
    users:    "用戶",
    holdings: "持股",
    trades:   "交易紀錄",
    log:      "推播紀錄",
  },

  // 警示門檻
  ALERT_PCT:      5,   // 漲跌超過5%發警示
  WHALE_VOL_MULT: 2.0, // 成交量超過均量2倍=鯨魚
};

// 工具函數：週末判斷
function isTradingDay() {
  const now = new Date();
  const tw = new Date(now.getTime() + (8*60 + now.getTimezoneOffset())*60000);
  return tw.getDay() !== 0 && tw.getDay() !== 6;
}

// 工具函數：台灣時間字串
function getTWTimeStr() {
  const now = new Date();
  const tw = new Date(now.getTime() + (8*60 + now.getTimezoneOffset())*60000);
  return `${tw.getMonth()+1}/${tw.getDate()} ${tw.toTimeString().slice(0,5)}`;
}

// 工具函數：睡眠
function sleep(ms) { Utilities.sleep(ms); }
