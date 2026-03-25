import process from 'node:process';
import { Buffer } from 'buffer';
import { FetchMode, ServerSetting } from './src/types/types';
import { Connect } from 'vite';
import httpProxy from 'http-proxy';
import { exec } from 'child_process';
import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'zlib';

const proxy = httpProxy.createProxyServer({});

const settings: ServerSetting = {
  CLIENT_HOST: 'http://localhost:3000',
  fetchMode: FetchMode.PROXY,
  disAllowedRequestHeaders: [
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'sec-fetch-site',
    'origin',
    'sec-fetch-dest',
    'pragma',
  ],
  disAllowResponseHeaders: ['link', 'set-cookie', 'set-cookie2'],
  useUserAgent: true,
};

// 配置设置中间件
const proxySettingMiddleware: Connect.NextHandleFunction = (req, res) => {
  let str = '';
  req.on('data', chunk => {
    str += chunk;
  });
  req.on('end', () => {
    try {
      const newSettings = JSON.parse(str);
      for (const key in newSettings) {
        // @ts-ignore
        settings[key] = newSettings[key];
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.write(JSON.stringify(settings));
    } catch {
      res.statusCode = 400;
    } finally {
      res.end();
    }
  });
};

// 代理逻辑中间件
const proxyHandlerMiddle: Connect.NextHandleFunction = (req, res) => {
  // 修正 1: 确保协议匹配，如果是内网 IP 建议先尝试 http
  const rawUrl = 'http:' + req.url; 
  
  if (req.headers['access-control-request-method']) {
    res.setHeader('access-control-allow-methods', req.headers['access-control-request-method'] as string);
    delete req.headers['access-control-request-method'];
  }
  if (req.headers['access-control-request-headers']) {
    res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] as string);
    delete req.headers['access-control-request-headers'];
  }

  res.setHeader('Access-Control-Allow-Origin', settings.CLIENT_HOST);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  try {
    const _url = new URL(rawUrl);
    
    // 修正 2: 清除可能导致 304 Not Modified 的头部，确保后端一定返回完整数据
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];

    for (const _header in req.headers) {
      if (
        req.headers[_header]?.includes('localhost') ||
        settings.disAllowedRequestHeaders.includes(_header)
      ) {
        delete req.headers[_header];
      }
    }

    req.headers['sec-fetch-mode'] = 'cors';
    if (settings.cookies) {
      req.headers['cookie'] = settings.cookies;
    }
    if (!settings.useUserAgent) {
      delete req.headers['user-agent'];
    }

    // 核心修正 3: 设置正确的 host，这对后端身份校验至关重要
    req.headers.host = _url.host;
    req.headers.referer = _url.origin + '/';
    req.url = _url.pathname + _url.search;

    proxyRequest(req, res, _url);
  } catch (err) {
    console.error('\x1b[31m', 'URL Parse Error:', err);
    res.statusCode = 500;
    res.end();
  }
};

const proxyRequest = (req: any, res: any, _url: URL) => {
  console.log('\x1b[36m%s\x1b[0m', `[Proxy] ${req.method} -> ${_url.href}`);

  if (settings.fetchMode === FetchMode.CURL) {
    let curl = `curl '${_url.href}'`;
    if (settings.useUserAgent) curl += ` -H 'User-Agent: ${req.headers['user-agent']}'`;
    if (settings.cookies) curl += ` -H 'Cookie: ${settings.cookies}'`;
    
    const isWindows = process.platform === 'win32';
    const options = isWindows ? { shell: process.env.BASH_LOCATION || 'C:\\Program Files\\Git\\usr\\bin\\bash.exe' } : {};

    exec(curl, options, (error, stdout) => {
      if (error) {
        res.statusCode = 500;
        res.end(error.message);
        return;
      }
      res.statusCode = 200;
      res.write(stdout);
      res.end();
    });

  } else if (settings.fetchMode === FetchMode.NODE_FETCH) {
    fetch(_url.href, {
      method: req.method,
      headers: req.headers as any,
    })
      .then(async res2 => {
        res.statusCode = res2.status;
        res2.headers.forEach((val, key) => {
          if (!settings.disAllowResponseHeaders.includes(key) && !['content-encoding', 'content-length'].includes(key)) {
            res.setHeader(key, val);
          }
        });
        const text = await res2.text();
        res.end(text);
      })
      .catch(err => {
        console.error(err);
        res.statusCode = 500;
        res.end();
      });

  } else if (settings.fetchMode === FetchMode.PROXY) {
    proxy.web(
      req,
      res,
      {
        target: _url.origin,
        selfHandleResponse: true, // 我们需要手动解压，所以保持 true
        changeOrigin: true,       // 核心修正 4: 必须为 true，修改 Header 中的 Host
        secure: false,            // 核心修正 5: 忽略自签名证书错误
        followRedirects: true,
      },
      err => {
        console.error('Proxy Error:', err);
        res.statusCode = 500;
        res.end();
      }
    );
  }
};

proxy.on('proxyRes', function (proxyRes, req, res) {
  // 修正 6: 必须同步状态码
  res.statusCode = proxyRes.statusCode || 200;

  // 1. 处理重定向
  if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
    // 如果 selfHandleResponse 为 true，重定向需要手动处理或交给前端
    // 这里简单处理：直接转发 location 头部
    for (const key in proxyRes.headers) {
      res.setHeader(key, proxyRes.headers[key] as string);
    }
    res.end();
    return;
  }

  // 2. 准备过滤响应头
  for (const key in proxyRes.headers) {
    if (!settings.disAllowResponseHeaders.includes(key)) {
      res.setHeader(key, proxyRes.headers[key] as string);
    }
  }

  const contentEncoding = proxyRes.headers['content-encoding'] || '';
  const isBrotli = contentEncoding.includes('br');
  const isGzip = contentEncoding.includes('gzip');
  const isZstd = contentEncoding.includes('zstd');

  // 3. 处理数据
  const chunks: Buffer[] = [];
  proxyRes.on('data', chunk => chunks.push(Buffer.from(chunk)));
  proxyRes.on('end', () => {
    const buffer = Buffer.concat(chunks);
    
    // 如果没有数据，直接结束
    if (buffer.length === 0) {
      res.end();
      return;
    }

    if (isBrotli || isGzip || isZstd) {
      // 移除会导致长度不匹配的头部
      res.removeHeader('content-encoding');
      res.removeHeader('content-length');

      try {
        let decompressed: Buffer;
        if (isBrotli) decompressed = brotliDecompressSync(buffer);
        else if (isZstd) decompressed = zstdDecompressSync(buffer);
        else decompressed = gunzipSync(buffer);

        res.end(decompressed);
      } catch (err) {
        console.error('Decompression failed:', err);
        res.statusCode = 500;
        res.end('Decompression error');
      }
    } else {
      res.end(buffer);
    }
  });
});

export { proxyHandlerMiddle, proxySettingMiddleware };