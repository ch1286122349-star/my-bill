const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://mxchino.com').replace(/\/$/, '');
const BAIDU_PUSH_TOKEN = (process.env.BAIDU_PUSH_TOKEN || 'XNopxYYC2STPK8vR').trim();
const CUSTOM_ENDPOINT = process.env.BAIDU_PUSH_ENDPOINT;
const SITEMAP_PATH = path.join(__dirname, '..', 'sitemap.xml');

if (!BAIDU_PUSH_TOKEN) {
  console.error('Missing BAIDU_PUSH_TOKEN. Set it as env or update the token.');
  process.exit(1);
}

if (!fs.existsSync(SITEMAP_PATH)) {
  console.error('sitemap.xml not found. Run `npm run sitemap` first.');
  process.exit(1);
}

const sitemapContent = fs.readFileSync(SITEMAP_PATH, 'utf8');
const locRegex = /<loc>([^<]+)<\/loc>/g;
const urls = [];
let match;
while ((match = locRegex.exec(sitemapContent)) !== null) {
  const loc = String(match[1] || '').trim();
  if (loc) urls.push(loc);
}

if (!urls.length) {
  console.error('No URLs found in sitemap.xml');
  process.exit(1);
}

const endpointUrl = new URL(
  CUSTOM_ENDPOINT || `http://data.zz.baidu.com/urls?site=${SITE_ORIGIN}&token=${BAIDU_PUSH_TOKEN}`
);

const payload = urls.join('\n');
const transport = endpointUrl.protocol === 'https:' ? https : http;
const requestOptions = {
  method: 'POST',
  hostname: endpointUrl.hostname,
  port: endpointUrl.port || (endpointUrl.protocol === 'https:' ? 443 : 80),
  path: endpointUrl.pathname + endpointUrl.search,
  headers: {
    'Content-Type': 'text/plain',
    'Content-Length': Buffer.byteLength(payload),
  },
};

console.log(`Pushing ${urls.length} URLs to Baidu...`);

const req = transport.request(requestOptions, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log('Body:', body || '<empty>');
    if (res.statusCode !== 200) {
      process.exitCode = 1;
    }
  });
});

req.on('error', (err) => {
  console.error('Request failed:', err.message);
  process.exit(1);
});

req.write(payload);
req.end();
