/**
 * Vercel Serverless Function - 数据接口代理
 * 解决东财接口CORS和JSONP限制问题
 */

const allowedOrigins = [
  'https://jkwell.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'https://*.vercel.app'
];

export default async function handler(req, res) {
  // CORS处理
  const origin = req.headers.origin || '';
  const isAllowed = allowedOrigins.some(allowed =>
    origin === allowed || origin.endsWith(allowed.replace('*', ''))
  );

  if (isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    // 解码URL
    const targetUrl = decodeURIComponent(url);

    // 安全检查：只允许白名单域名
    const allowedDomains = [
      'push2.eastmoney.com',
      'push2his.eastmoney.com',
      'datacenter-web.eastmoney.com',
      'qt.gtimg.cn',
      'web.ifzq.gtimg.cn',
      'vip.stock.finance.sina.com.cn'
    ];

    const targetDomain = new URL(targetUrl).hostname;
    if (!allowedDomains.some(domain => targetDomain.includes(domain))) {
      return res.status(403).json({ error: 'Domain not allowed' });
    }

    // 发起请求
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': targetDomain.includes('eastmoney')
          ? 'https://quote.eastmoney.com/'
          : targetDomain.includes('gtimg')
          ? 'https://gu.qq.com/'
          : 'https://finance.sina.com.cn/',
        'Accept': '*/*',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream error: ${response.status} ${response.statusText}`
      });
    }

    // 获取内容类型
    const contentType = response.headers.get('content-type') || '';

    // 返回数据
    if (contentType.includes('application/json')) {
      const data = await response.json();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).json(data);
    } else {
      const text = await response.text();
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(200).send(text);
    }

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({
      error: error.message || 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
}
