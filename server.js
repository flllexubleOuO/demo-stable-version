// 本地 HTTP 服务入口：解析路由和请求，把翻译业务交给独立服务模块。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createTranslationService } = require('./translation-service.cjs');

const root = __dirname;
const version = '0.3.0';
const port = Number(process.env.PORT || 4173);
const translationService = createTranslationService();
const diagnosticDirectory = path.join(root, 'logs');
const diagnosticFile = path.join(diagnosticDirectory, 'diagnostics.jsonl');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request, maxBytes) {
  // 所有接口都限制请求体大小，避免异常大的正文占用本地服务资源。
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > maxBytes) {
      const error = new Error('Request body is too large.');
      error.status = 413;
      throw error;
    }
  }

  try {
    return JSON.parse(body);
  } catch {
    const error = new Error('Invalid JSON request.');
    error.status = 400;
    throw error;
  }
}

async function handleDiagnostics(request, response) {
  if (request.method !== 'POST') {
    return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }

  try {
    const body = await readJsonBody(request, 128 * 1024);
    const events = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
    const lines = events
      .filter(event => event && typeof event === 'object')
      .map(event => JSON.stringify({
        timestamp: typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString(),
        scope: String(event.scope || 'Unknown').slice(0, 40),
        event: String(event.event || 'unknown').slice(0, 100),
        details: event.details && typeof event.details === 'object' ? event.details : {}
      }));

    if (lines.length) {
      await fs.promises.mkdir(diagnosticDirectory, { recursive: true });
      await fs.promises.appendFile(diagnosticFile, `${lines.join('\n')}\n`, 'utf8');
    }

    return sendJson(response, 200, { saved: lines.length });
  } catch (error) {
    return sendJson(response, error.status || 400, { error: error.message || 'Could not save diagnostics.' });
  }
}

async function handleTranslation(request, response) {
  if (request.method !== 'POST') {
    return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
  }
  const currentSettings = translationService.getSettings();
  if (!currentSettings.configured) {
    const providerName = currentSettings.provider === 'gemini' ? 'Gemini' : 'OpenAI';
    return sendJson(response, 503, { error: `No ${providerName} API key is set. Open Settings and add your API key.` });
  }

  try {
    const body = await readJsonBody(request, 12000);
    const result = await translationService.translate(body, { isDisconnected: () => response.destroyed });
    return sendJson(response, 200, result);
  } catch (error) {
    if (response.destroyed) return;
    return sendJson(response, error.status || 502, { error: error.message || 'Could not reach the translation API.' });
  }
}

async function handleSettings(request, response) {
  if (request.method === 'GET') return sendJson(response, 200, translationService.getSettings());
  if (request.method !== 'POST') {
    return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET, POST' });
  }

  try {
    const body = await readJsonBody(request, 5000);
    return sendJson(response, 200, translationService.configure(body));
  } catch (error) {
    return sendJson(response, error.status || 400, { error: error.message || 'Invalid settings request.' });
  }
}

function serveStatic(request, response, requestedPath) {
  // 仅发布前端白名单文件，禁止通过静态路由读取服务端源码、日志和配置。
  const publicFiles = new Set(['/index.html', '/style.css', '/app.js', '/speech-capture.js', '/audio-capture.js', '/audio-worklet-processor.js', '/translation-queue.js', '/diagnostics.js']);
  if (!publicFiles.has(requestedPath)) {
    response.writeHead(404);
    return response.end('Not found');
  }
  const filePath = path.join(root, requestedPath.slice(1));

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404);
      return response.end('Not found');
    }
    const contentType = contentTypes[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(contents);
  });
}

const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;

  if (pathname === '/healthz') {
    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
    return sendJson(response, 200, { status: 'ok', version, asr: { configured: translationService.isRealtimeAsrConfigured(), provider: 'gemini', model: 'gemini-3.5-transcribe-live' } });
  }
  if (pathname === '/api/asr/session') {
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
    try {
      const body = await readJsonBody(request, 2000);
      const language = typeof body.language === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/.test(body.language) ? body.language : 'en-US';
      const temporaryCredential = await translationService.createRealtimeTranscriptionSecret(language);
      return sendJson(response, 200, temporaryCredential, { 'Cache-Control': 'no-store' });
    } catch (error) {
      return sendJson(response, error.status || 502, { error: error.message || 'Could not create an ASR session.' });
    }
  }

  if (pathname === '/api/translate' || pathname === '/api/translate-batch') {
    return handleTranslation(request, response);
  }
  if (pathname === '/api/settings') return handleSettings(request, response);
  if (pathname === '/api/diagnostics') return handleDiagnostics(request, response);
  const requestedPath = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  return serveStatic(request, response, requestedPath);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Lingua is running at http://127.0.0.1:${port}`);
  console.log(`Speech diagnostics are saved to ${diagnosticFile} when ?debugSpeech=1 is enabled.`);
});
