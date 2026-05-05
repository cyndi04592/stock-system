// ════════════════════════════════════════════════
//  api/proxy.js  v2 (2026/05/05 第四十二輪結案)
//
//  v2 改動:
//   🚨 修「LINE webhook timeout」案
//      v1 等 GAS 跑完才回 LINE → GAS 慢 → LINE 5 秒 timeout
//      v2 先回 LINE 200,再背景 fire-and-forget 打 GAS
//
//   保留:
//   - GET 路徑(api_dashboard / api_analyze / api_poll)同步等 GAS,因為前端要等回應
//   - POST 路徑(LINE webhook)立刻回 200,GAS 慢沒差
// ════════════════════════════════════════════════

export default async function handler(req, res) {
  // 允許跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzjaRxJhYkqNIaJaFxvSiy0L120H0m0k7NY_Vc6IXIw70kO2SIvf3fOf26TnhApTgrg/exec';

  // ════════════════════════════════════════════
  // POST 路徑(LINE webhook)── 火後發送
  // ════════════════════════════════════════════
  if (req.method === 'POST') {
    // Step 1:立刻回 200 OK 給 LINE(關鍵!)
    res.status(200).send('OK');

    // Step 2:背景轉發給 GAS(不 await,不擋 LINE)
    try {
      const body = req.body;
      // 不 await,讓 Vercel 自己跑完
      fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'follow'
      }).catch(err => {
        console.error('[proxy POST→GAS]', err.message);
      });
    } catch (err) {
      console.error('[proxy POST]', err.message);
    }
    return;
  }

  // ════════════════════════════════════════════
  // GET 路徑 ── 同步等 GAS(前端 JSONP 要回應)
  // ════════════════════════════════════════════
  try {
    const params = new URLSearchParams(req.query).toString();
    const gasRes = await fetch(`${GAS_URL}${params ? '?' + params : ''}`, {
      redirect: 'follow'
    });

    // 嘗試解析 JSON,失敗就回原文
    const text = await gasRes.text();
    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch (parseErr) {
      // 不是 JSON(可能是 JSONP callback 包過的),直接回原文
      res.setHeader('Content-Type', gasRes.headers.get('content-type') || 'text/plain');
      return res.status(200).send(text);
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
