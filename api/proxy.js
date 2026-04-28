export default async function handler(req, res) {
  // 允許跨域
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const GAS_URL = 'https://script.google.com/macros/s/AKfycbzjaRxJhYkqNIaJaFxvSiy0L120H0m0k7NY_Vc6IXIw70kO2SIvf3fOf26TnhApTgrg/exec';

  try {
    let gasRes;

    if (req.method === 'POST') {
      const body = req.body;
      gasRes = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'follow'
      });
    } else {
      const params = new URLSearchParams(req.query).toString();
      gasRes = await fetch(`${GAS_URL}${params ? '?' + params : ''}`, {
        redirect: 'follow'
      });
    }

    const data = await gasRes.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
