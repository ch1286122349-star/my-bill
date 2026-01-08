require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const isDev = process.env.NODE_ENV !== 'production';

if (isDev) {
  const livereload = require('livereload');
  const connectLivereload = require('connect-livereload');
  const lrServer = livereload.createServer({ exts: ['html', 'css', 'js'], delay: 150 });
  lrServer.watch([
    path.join(__dirname, 'partials'),
    path.join(__dirname, 'assets'),
    path.join(__dirname, 'image'),
    path.join(__dirname, 'site.css'),
    path.join(__dirname, 'home.html'),
    path.join(__dirname, 'companies.html'),
    path.join(__dirname, 'index.html'),
  ]);
  app.use(connectLivereload());
}

// Initialize SQLite and ensure table exists.
const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(
    `CREATE TABLE IF NOT EXISTS submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      city TEXT,
      type TEXT,
      details TEXT,
      contact TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const HEADER_PATH = path.join(__dirname, 'partials', 'header.html');
let headerHtml = '';
try {
  headerHtml = fs.readFileSync(HEADER_PATH, 'utf8');
} catch (err) {
  console.warn('Header partial not found:', err.message);
}

const HEAD_PATH = path.join(__dirname, 'partials', 'head.html');
let headHtml = '';
try {
  headHtml = fs.readFileSync(HEAD_PATH, 'utf8');
} catch (err) {
  console.warn('Head partial not found:', err.message);
}

const COMPANIES_TEMPLATE_PATH = path.join(__dirname, 'partials', 'companies.html');
let companiesTemplate = '';
try {
  companiesTemplate = fs.readFileSync(COMPANIES_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Companies partial not found:', err.message);
}

const FOOTER_PATH = path.join(__dirname, 'partials', 'footer.html');
let footerHtml = '';
try {
  footerHtml = fs.readFileSync(FOOTER_PATH, 'utf8');
} catch (err) {
  console.warn('Footer partial not found:', err.message);
}

const COMPANY_TEMPLATE_PATH = path.join(__dirname, 'company.html');
let companyTemplate = '';
try {
  companyTemplate = fs.readFileSync(COMPANY_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Company template not found:', err.message);
}

const COMPANIES_DATA_PATH = path.join(__dirname, 'data', 'companies.json');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

const sanitizeCover = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^[-a-zA-Z0-9_./:]+$/.test(raw)) return '';
  return raw;
};

const slugifyAscii = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const buildCompaniesHtml = () => {
  if (!companiesTemplate) return '';
  const companies = loadCompaniesData();
  if (!companies.length) {
    return companiesTemplate
      .replace('<!--COMPANY_NAV-->', '')
      .replace('<!--COMPANY_SECTIONS-->', '<p class=\"muted\">暂无企业数据。</p>');
  }

  const cityOrder = [];
  const cityMap = new Map();

  companies.forEach((company) => {
    const city = company.city || '未分类城市';
    const industry = company.industry || '其他';
    if (!cityMap.has(city)) {
      cityMap.set(city, { count: 0, industries: new Map() });
      cityOrder.push(city);
    }
    const cityEntry = cityMap.get(city);
    cityEntry.count += 1;
    if (!cityEntry.industries.has(industry)) {
      cityEntry.industries.set(industry, []);
    }
    cityEntry.industries.get(industry).push(company);
  });

  const navHtml = cityOrder.map((city, index) => {
    const cityEntry = cityMap.get(city);
    const slug = slugifyAscii(city);
    const id = slug ? `city-${slug}` : `city-${index + 1}`;
    return `<a class=\"pill\" href=\"#${id}\">${escapeHtml(city)} <em>${cityEntry.count}</em></a>`;
  }).join('');

  const sectionsHtml = cityOrder.map((city, index) => {
    const cityEntry = cityMap.get(city);
    const industryEntries = Array.from(cityEntry.industries.entries());
    const industryCount = industryEntries.length;
    const slug = slugifyAscii(city);
    const id = slug ? `city-${slug}` : `city-${index + 1}`;

    const industriesHtml = industryEntries.map(([industry, items]) => {
      const cardsHtml = items.map((company) => {
        const safeName = escapeHtml(company.name);
        const safeSummary = escapeHtml(company.summary);
        const safeContact = escapeHtml(company.contact);
        const safeSlug = encodeURIComponent(String(company.slug || ''));
        const safeCover = sanitizeCover(company.cover);
        const coverStyle = safeCover
          ? ` style=\"background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.35), rgba(15, 23, 42, 0.7)), url('${safeCover}')\"`
          : '';
        const coverClass = safeCover ? ' company-cover' : '';
        return (
          `<a class=\"company-card company-link${coverClass}\" href=\"/company/${safeSlug}\"${coverStyle}>` +
          `<h4>${safeName}</h4>` +
          `<p class=\"company-desc\">${safeSummary}</p>` +
          `<div class=\"company-contact\"><span>微信/WhatsApp：${safeContact}</span></div>` +
          `</a>`
        );
      }).join('');

      return (
        `<div class=\"industry-block\">` +
        `<div class=\"industry-head\">` +
        `<h3>${escapeHtml(industry)}</h3>` +
        `<span class=\"industry-count\">${items.length} 家</span>` +
        `</div>` +
        `<div class=\"company-grid\">${cardsHtml}</div>` +
        `</div>`
      );
    }).join('');

    return (
      `<section class=\"city-section\" id=\"${id}\">` +
      `<div class=\"city-head\">` +
      `<h2>${escapeHtml(city)}</h2>` +
      `<p class=\"muted\">${cityEntry.count} 家企业 · 共 ${industryCount} 个行业。</p>` +
      `</div>` +
      `<div class=\"city-body\">${industriesHtml}</div>` +
      `</section>`
    );
  }).join('');

  return companiesTemplate
    .replace('<!--COMPANY_NAV-->', navHtml)
    .replace('<!--COMPANY_SECTIONS-->', sectionsHtml);
};

const loadCompaniesData = () => {
  try {
    const raw = fs.readFileSync(COMPANIES_DATA_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('Companies data not found or invalid:', err.message);
    return [];
  }
};

const renderPage = (fileName) => {
  const filePath = path.join(__dirname, fileName);
  const page = fs.readFileSync(filePath, 'utf8');
  const companiesHtml = buildCompaniesHtml();
  return page
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--COMPANIES-->', companiesHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '');
};

const renderCompanyPage = (company) => {
  if (!companyTemplate) return '';
  const safeName = escapeHtml(company.name);
  const safeIndustry = escapeHtml(company.industry);
  const safeCity = escapeHtml(company.city);
  const safeSummary = escapeHtml(company.summary);
  const safeContact = escapeHtml(company.contact);
  const safeDetail = escapeHtml(company.detail);
  const detailEnabled = Boolean(company.detail && company.detailPaid);
  const detailHtml = detailEnabled
    ? `<div class="company-detail-extra"><h2>详情</h2><p>${safeDetail}</p></div>`
    : `<div class="company-detail-extra locked"><h2>详情</h2><p>该企业未开通详情展示，如需展示请联系站长。</p></div>`;
  const safeCover = sanitizeCover(company.cover);
  const coverStyle = safeCover
    ? `style="background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.25), rgba(15, 23, 42, 0.65)), url('${safeCover}')"`
    : '';
  return companyTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace(/<!--COMPANY_NAME-->/g, safeName)
    .replace('<!--COMPANY_INDUSTRY-->', safeIndustry)
    .replace('<!--COMPANY_CITY-->', safeCity)
    .replace('<!--COMPANY_SUMMARY-->', safeSummary)
    .replace('<!--COMPANY_CONTACT-->', safeContact)
    .replace('<!--COMPANY_COVER_STYLE-->', coverStyle)
    .replace('<!--COMPANY_DETAIL_SECTION-->', detailHtml);
};

const loadServiceAccount = () => {
  const b64 = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64;
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  let parsed;
  try {
    if (b64) {
      parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    } else if (json) {
      parsed = JSON.parse(json);
    }
  } catch (err) {
    console.error('Failed to parse Google service account JSON:', err.message);
    return null;
  }
  if (!parsed || !parsed.client_email || !parsed.private_key) return null;
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
};

const getSheetsClient = () => {
  const creds = loadServiceAccount();
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!creds || !sheetId) return null;

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  return { sheets: google.sheets({ version: 'v4', auth }), sheetId };
};

const appendToSheet = async (submission) => {
  const client = getSheetsClient();
  if (!client) return;

  const { sheets, sheetId } = client;
  const row = [
    submission.id || '',
    new Date().toISOString(),
    submission.name || '',
    submission.email || '',
    submission.city || '',
    submission.type || '',
    submission.details || '',
    submission.contact || '',
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: 'Submissions!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  } catch (err) {
    console.error('Append to Google Sheet failed:', err.message);
  }
};

// ===== Feishu Bitable (optional) =====
const feishuTokenCache = { token: null, expiresAt: 0 };
const getFeishuConfig = () => {
  const { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID } = process.env;
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !FEISHU_APP_TOKEN || !FEISHU_TABLE_ID) return null;
  return { FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_APP_TOKEN, FEISHU_TABLE_ID };
};

const feishuCfg = getFeishuConfig();
if (feishuCfg) {
  console.log('Feishu Bitable enabled:', {
    appToken: feishuCfg.FEISHU_APP_TOKEN,
    tableId: feishuCfg.FEISHU_TABLE_ID,
  });
} else {
  console.log('Feishu Bitable disabled (missing env vars).');
}

const getFeishuTenantToken = async () => {
  const cfg = getFeishuConfig();
  if (!cfg) return null;
  if (feishuTokenCache.token && feishuTokenCache.expiresAt > Date.now()) {
    return feishuTokenCache.token;
  }
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: cfg.FEISHU_APP_ID, app_secret: cfg.FEISHU_APP_SECRET }),
  });
  const data = await res.json();
  if (!res.ok || !data.tenant_access_token) {
    throw new Error(data.msg || 'Failed to get Feishu tenant_access_token');
  }
  feishuTokenCache.token = data.tenant_access_token;
  feishuTokenCache.expiresAt = Date.now() + ((data.expire || 7200) - 60) * 1000;
  return feishuTokenCache.token;
};

const appendToFeishu = async (submission) => {
  const cfg = getFeishuConfig();
  if (!cfg) return;

  let token;
  try {
    token = await getFeishuTenantToken();
  } catch (err) {
    console.error('Feishu token error:', err.message);
    return;
  }

  const payload = {
    fields: {
      ID: `${submission.id ?? ''}`,
      姓名: `${submission.name ?? ''}`,
      邮箱: `${submission.email ?? ''}`,
      城市: `${submission.city ?? ''}`,
      需求: `${submission.type ?? ''}`,
      主题内容: `${submission.details ?? ''}`,
      备用联系方式: `${submission.contact ?? ''}`,
      创建时间: new Date().toISOString(),
    },
  };

  try {
    const res = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${cfg.FEISHU_APP_TOKEN}/tables/${cfg.FEISHU_TABLE_ID}/records`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json();
    if (!res.ok || !data.data) {
      throw new Error(data.msg || 'Feishu append failed');
    }
  } catch (err) {
    console.error('Append to Feishu failed:', err.message);
  }
};

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/submit', (req, res) => {
  const { name, email, city, type, details, contact } = req.body;
  const safeContact = (contact || '').trim();
  const safeName = (name || '').trim() || (safeContact ? '网站访客' : '');
  const safeEmail = (email || '').trim() || safeContact;
  if (!safeEmail) {
    return res.status(400).json({ ok: false, message: '缺少联系方式' });
  }

  const stmt = db.prepare(
    `INSERT INTO submissions (name, email, city, type, details, contact)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  stmt.run([safeName, safeEmail, city, type, details, safeContact], function (err) {
    if (err) {
      console.error('DB insert error:', err);
      return res.status(500).json({ ok: false, message: '存储失败' });
    }
    const submission = { id: this.lastID, name: safeName, email: safeEmail, city, type, details, contact: safeContact };
    appendToSheet(submission); // fire-and-forget; errors are logged.
    appendToFeishu(submission); // optional, requires env vars; errors are logged.
    return res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/submissions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  db.all(
    `SELECT id, name, email, city, type, details, contact, created_at
     FROM submissions
     ORDER BY datetime(created_at) DESC
     LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        console.error('DB read error:', err);
        return res.status(500).json({ ok: false, message: '读取失败' });
      }
      return res.json({ ok: true, data: rows });
    }
  );
});

app.get('/', (_req, res) => {
  res.send(renderPage('home.html'));
});

app.get(['/home', '/home.html'], (_req, res) => {
  res.send(renderPage('home.html'));
});

app.get(['/contact', '/contact.html', '/index.html'], (_req, res) => {
  res.send(renderPage('index.html'));
});

app.get(['/companies', '/companies.html'], (_req, res) => {
  res.send(renderPage('companies.html'));
});

app.get('/company/:slug', (req, res) => {
  const companies = loadCompaniesData();
  const company = companies.find((item) => item.slug === req.params.slug);
  if (!company) {
    return res.status(404).send('未找到该企业信息');
  }
  const html = renderCompanyPage(company);
  if (!html) {
    return res.status(500).send('企业详情模板缺失');
  }
  return res.send(html);
});

// Serve the static pages and assets so frontend and backend share the same origin.
app.use(express.static(path.join(__dirname)));

app.get('*', (_req, res) => {
  res.send(renderPage('home.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB file at ${DB_PATH}`);
});
