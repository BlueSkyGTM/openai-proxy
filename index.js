// Updated index.js for BlueSkyGTM/openai-proxy
// Changes from original:
//   1. OPENAI_API_URL is now configurable via OPENAI_BASE_URL env var
//      (swap between OpenAI and Z.ai by changing one Railway env var)
//   2. Auth accepts standard 'Authorization: Bearer <key>' in addition to
//      x-proxy-auth, so the openai Python SDK works without custom headers
//   3. Forwards /v1/embeddings in addition to /v1/chat/completions
//   4. Error message updated to remove 'OpenAI' branding

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

// OPENAI_BASE_URL lets you swap upstream without redeploying code:
//   OpenAI:  https://api.openai.com/v1
//   Z.ai:    https://open.bigmodel.cn/api/paas/v4
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
const UPSTREAM_API_KEY = process.env.OPENAI_API_KEY;
const PROXY_SECRET_KEY = process.env.PROXY_SECRET_KEY;

// Z.ai keys are "id.secret" and require a signed HS256 JWT.
// Standard OpenAI keys (sk-...) are passed as-is.
function getUpstreamAuthHeader() {
  if (!UPSTREAM_API_KEY || !UPSTREAM_API_KEY.includes('.')) {
    return `Bearer ${UPSTREAM_API_KEY}`;
  }
  const [id, secret] = UPSTREAM_API_KEY.split('.');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', sign_type: 'SIGN' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ api_key: id, exp: now + 3600, timestamp: now })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `Bearer ${header}.${payload}.${sig}`;
}

const authMiddleware = (req, res, next) => {
  // Accept both x-proxy-auth (legacy) and Authorization: Bearer (OpenAI SDK standard)
  const xProxyAuth = req.headers['x-proxy-auth'];
  const bearerMatch = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  const clientToken = xProxyAuth || (bearerMatch && bearerMatch[1]);

  if (!clientToken || clientToken !== PROXY_SECRET_KEY) {
    console.warn('Forbidden: Invalid or missing auth header.');
    return res.status(403).json({ error: { message: 'Forbidden. Invalid proxy credentials.' } });
  }
  next();
};

// Z.ai rejects OpenAI-specific params it doesn't support.
// Keep only the params GLM accepts; strip everything else.
const ZAI_ALLOWED = new Set([
  'model','messages','temperature','max_tokens','top_p','stream',
  'stop','n','user','tools','tool_choice','response_format',
]);
function sanitizeBody(body) {
  if (!BASE_URL.includes('bigmodel')) return body; // pass-through for OpenAI
  const clean = {};
  for (const [k, v] of Object.entries(body)) {
    if (ZAI_ALLOWED.has(k)) clean[k] = v;
  }
  return clean;
}

async function proxyRequest(endpoint, req, res) {
  console.log(`Received request to ${endpoint}`);
  try {
    const headers = {
      'Authorization': getUpstreamAuthHeader(),
      'Content-Type': 'application/json',
    };

    const requestBody = sanitizeBody(req.body);
    const isStreaming = requestBody.stream === true;

    const upstreamResponse = await axios({
      method: 'POST',
      url: `${BASE_URL}${endpoint}`,
      headers,
      data: requestBody,
      responseType: isStreaming ? 'stream' : 'json',
    });

    if (isStreaming) {
      res.setHeader('Content-Type', upstreamResponse.headers['content-type']);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      upstreamResponse.data.pipe(res);
    } else {
      res.status(upstreamResponse.status).json(upstreamResponse.data);
    }
  } catch (error) {
    console.error(`Error proxying ${endpoint}:`, error.message);
    if (error.response) {
      if (req.body.stream === true) {
        let errorData = '';
        error.response.data.on('data', chunk => { errorData += chunk; });
        error.response.data.on('end', () => { res.status(error.response.status).send(errorData); });
      } else {
        res.status(error.response.status).json(error.response.data);
      }
    } else {
      res.status(502).json({ error: { message: 'Bad Gateway: Proxy could not reach upstream API.' } });
    }
  }
}

app.post('/v1/chat/completions', authMiddleware, (req, res) => proxyRequest('/chat/completions', req, res));
app.post('/v1/embeddings', authMiddleware, (req, res) => proxyRequest('/embeddings', req, res));

app.get('/', (req, res) => {
  res.status(200).send('BlueSkyGTM Proxy is running.');
});

app.listen(PORT, HOST, () => {
  console.log(`Proxy listening on ${HOST}:${PORT} → ${BASE_URL}`);
  if (!UPSTREAM_API_KEY) console.warn('WARNING: OPENAI_API_KEY is not set.');
  if (!PROXY_SECRET_KEY) console.warn('WARNING: PROXY_SECRET_KEY is not set. Proxy is open!');
});
