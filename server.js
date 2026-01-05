const path = require('path');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data.db');

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
  if (!name || !email) {
    return res.status(400).json({ ok: false, message: '缺少姓名或邮箱' });
  }

  const stmt = db.prepare(
    `INSERT INTO submissions (name, email, city, type, details, contact)
     VALUES (?, ?, ?, ?, ?, ?)`
  );

  stmt.run([name, email, city, type, details, contact], function (err) {
    if (err) {
      console.error('DB insert error:', err);
      return res.status(500).json({ ok: false, message: '存储失败' });
    }
    const submission = { id: this.lastID, name, email, city, type, details, contact };
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

// Serve the static form so frontend and backend share the same origin.
app.use(express.static(path.join(__dirname)));

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB file at ${DB_PATH}`);
});
