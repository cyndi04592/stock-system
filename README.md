# 美股神器 Stock System v5.0

上班族沒時間看盤？每天早上直接推播個人化股票分析，傳截圖自動識別持股。

## 功能

- 股票健診 17式（技術面 + 基本面 + TACO川普指標）
- 持倉主控台（即時股價 + DIX暗池 + 鯨魚偵測）
- LINE個人化推播（每個用戶看自己的股票）
- 拍照識別持股（傳截圖自動讀取，不用手動Key）
- 美股台股都支援

## 訂閱方案

| 方案 | 月費 | 追蹤股票 | 功能 |
|------|------|---------|------|
| 試用版 | 免費 | 2支 | 每日快報（7天） |
| 基礎版 | 59元 | 3支 | 每日快報 + 截圖識別 |
| 進階版 | 99元 | 8支 | AI深度分析 + 17式健診 + TACO |
| VIP版 | 199元 | 20支 | 全部功能 + 盤前盤後通知 |

## 目錄結構

```
stock-system/
├── index.html          首頁（GitHub Pages 入口）
├── web/
│   ├── stock_12steps.html   股票健診17式
│   └── dashboard_v5.html    持倉主控台
└── gas/
    ├── 01_config.gs    設定區
    ├── 02_users.gs     用戶管理
    ├── 03_stocks.gs    股價抓取
    ├── 04_vision.gs    拍照識別持股
    ├── 05_analysis.gs  Claude分析
    ├── 06_push.gs      LINE個人化推播
    ├── 07_webhook.gs   訊息處理
    └── 08_admin.gs     管理員功能
```

## 安裝步驟

### 前台（GitHub Pages）
1. Fork 這個倉庫
2. Settings → Pages → Branch: main
3. 網址自動產生：yourname.github.io/stock-system

### 後台（Google Apps Script）
1. 開新的 Google 試算表
2. 擴充功能 → Apps Script
3. 新增 8 個檔案，分別貼入 gas/ 資料夾的程式碼
4. 在 01_config.gs 填入 LINE Token 和 Claude API Key
5. 部署 Webhook → 複製網址到 LINE Developers
6. 選單「系統管理」→「初始化所有工作表」
7. 選單「系統管理」→「設定自動推播觸發」

## LINE 帳號

@368ceoiv

## 技術棧

- 前台：HTML + CSS + JavaScript（純靜態，GitHub Pages 免費託管）
- 後台：Google Apps Script
- AI：Claude API（Vision識別 + 文字分析）
- 推播：LINE Messaging API
- 股價：Yahoo Finance API
