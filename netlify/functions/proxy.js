/**
 * Netlify Serverless Function - 数据接口代理
 * 解决东财接口CORS和JSONP限制问题
 */

const allowedOrigins = [
  'https://jkwell.github.io',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

exports.handler = async (event, context) => {
  // CORS处理
  const origin = event.headers.origin || '';
  const isAllowed = allowedOrigins.some(allowed =>
    origin === allowed || origin.includes('netlify.app')
  );

  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (isAllowed || origin.includes('netlify.app')) {
    headers['Access-Control-Allow-Origin'] = origin || '*';
  } else {
    headers['Access-Control-Allow-Origin'] = '*';
  }

  // OPTIONS请求
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  try {
    const params = event.queryStringParameters || {};
    const url = params.url;

    if (!url) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing url parameter' })
      };
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
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Domain not allowed' })
      };
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
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({
          error: `Upstream error: ${response.status} ${response.statusText}`
        })
      };
    }

    // 获取内容类型
    const contentType = response.headers.get('content-type') || '';
    const responseHeaders = { ...headers };

    // 返回数据
    if (contentType.includes('application/json')) {
      const data = await response.json();
      responseHeaders['Content-Type'] = 'application/json; charset=utf-8';
      return {
        statusCode: 200,
        headers: responseHeaders,
        body: JSON.stringify(data)
      };
    } else {
      const text = await response.text();
      responseHeaders['Content-Type'] = 'text/plain; charset=utf-8';
      return {
        statusCode: 200,
        headers: responseHeaders,
        body: text
      };
    }

  } catch (error) {
    console.error('Proxy error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: error.message || 'Internal server error'
      })
    };
  }
};
