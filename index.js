const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PROXY_SECRET_KEY = process.env.PROXY_SECRET_KEY;

const authMiddleware = (req, res, next) => {
  const clientToken = req.headers['x-proxy-auth'];
  if (!clientToken || clientToken !== PROXY_SECRET_KEY) {
    console.warn('Forbidden: Invalid or missing X-Proxy-Auth header.');
    return res.status(403).json({ error: { message: 'Forbidden. You do not have permission to access this proxy.' } });
  }
  next();
};

app.post('/v1/chat/completions', authMiddleware, async (req, res) => {
  console.log('Received request to /v1/chat/completions');
  try {
    const headers = {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    };
    if (req.headers['openai-organization']) {
      headers['OpenAI-Organization'] = req.headers['openai-organization'];
    }

    const requestBody = req.body;
    const isStreaming = requestBody.stream === true;

    const openaiResponse = await axios({
      method: 'POST',
      url: OPENAI_API_URL,
      headers: headers,
      data: requestBody,
      responseType: isStreaming ? 'stream' : 'json',
    });

    if (isStreaming) {
      res.setHeader('Content-Type', openaiResponse.headers['content-type']);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      openaiResponse.data.pipe(res);
    } else {
      res.status(openaiResponse.status).json(openaiResponse.data);
    }
  } catch (error) {
    console.error('Error proxying request to OpenAI:', error.message);
    if (error.response) {
        if (req.body.stream === true) {
            let errorData = '';
            error.response.data.on('data', chunk => { errorData += chunk; });
            error.response.data.on('end', () => { res.status(error.response.status).send(errorData); });
        } else {
            res.status(error.response.status).json(error.response.data);
        }
    } else {
      res.status(502).json({ error: { message: 'Bad Gateway: Proxy could not reach OpenAI API.' } });
    }
  }
});

app.get('/', (req, res) => {
  res.status(200).send('OpenAI Proxy is running.');
});

app.listen(PORT, HOST, () => {
  console.log(`OpenAI Proxy Server listening on ${HOST}:${PORT}`);
  if (!OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY environment variable is not set.');
  if (!PROXY_SECRET_KEY) console.warn('WARNING: PROXY_SECRET_KEY environment variable is not set. The proxy is insecure!');
});