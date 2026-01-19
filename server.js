require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const isDev = process.env.NODE_ENV !== 'production';
const ANALYTICS_ENABLED = String(process.env.ANALYTICS_ENABLED || 'true').toLowerCase() !== 'false';
const ANALYTICS_TOKEN = String(process.env.ANALYTICS_TOKEN || '').trim();
const ANALYTICS_COOKIE_NAME = 'mx_vid';
const ANALYTICS_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const ANALYTICS_UA_MAX_LENGTH = 300;
const ANALYTICS_REFERRER_MAX_LENGTH = 300;

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
let insertPageViewStmt = null;
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
  db.run(
    `CREATE TABLE IF NOT EXISTS page_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor_id TEXT NOT NULL,
      path TEXT NOT NULL,
      referrer TEXT,
      user_agent TEXT,
      ip_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.run(
    `CREATE TABLE IF NOT EXISTS forum_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      city TEXT,
      contact TEXT,
      ip_hash TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
  db.run('CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON page_views(created_at)');
  db.run('CREATE INDEX IF NOT EXISTS idx_page_views_path ON page_views(path)');
  db.run('CREATE INDEX IF NOT EXISTS idx_page_views_visitor ON page_views(visitor_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_forum_posts_created_at ON forum_posts(created_at)');
  insertPageViewStmt = db.prepare(
    `INSERT INTO page_views (visitor_id, path, referrer, user_agent, ip_hash)
     VALUES (?, ?, ?, ?, ?)`
  );
});

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const parseCookies = (headerValue) => {
  const cookies = {};
  if (!headerValue) return cookies;
  headerValue.split(';').forEach((item) => {
    const index = item.indexOf('=');
    if (index === -1) return;
    const name = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
};

const isLocalRequest = (req) => {
  const ip = String(req.ip || '');
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1';
};

const isAnalyticsAuthorized = (req) => {
  if (!ANALYTICS_TOKEN) {
    return isLocalRequest(req);
  }
  const header = String(req.get('authorization') || '');
  const token = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length).trim()
    : String(req.query.token || '').trim();
  return token && token === ANALYTICS_TOKEN;
};

const shouldTrackRequest = (req) => {
  if (!ANALYTICS_ENABLED) return false;
  if (req.method !== 'GET') return false;
  const requestPath = String(req.path || '');
  if (!requestPath) return false;
  if (requestPath.startsWith('/api')) return false;
  if (requestPath.startsWith('/assets') || requestPath.startsWith('/image')) return false;
  const ext = path.extname(requestPath).toLowerCase();
  if (ext && [
    '.css', '.js', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.map',
    '.json', '.txt', '.xml', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip',
  ].includes(ext)) {
    return false;
  }
  return true;
};

const ensureVisitorId = (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  let visitorId = cookies[ANALYTICS_COOKIE_NAME];
  if (!visitorId || !/^[0-9a-f-]{36}$/i.test(visitorId)) {
    visitorId = crypto.randomUUID();
    const cookieParts = [
      `${ANALYTICS_COOKIE_NAME}=${encodeURIComponent(visitorId)}`,
      `Max-Age=${ANALYTICS_COOKIE_MAX_AGE}`,
      'Path=/',
      'SameSite=Lax',
      'HttpOnly',
    ];
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '');
    const isSecure = req.secure || forwardedProto.includes('https');
    if (isSecure) {
      cookieParts.push('Secure');
    }
    res.append('Set-Cookie', cookieParts.join('; '));
  }
  return visitorId;
};

const hashIp = (value) => {
  if (!value) return '';
  return crypto.createHash('sha256').update(String(value)).digest('hex');
};

const formatLocalDate = (date) => {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const normalizeDateParam = (value) => {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return formatLocalDate(new Date());
};

const FORUM_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const FORUM_RATE_LIMIT_MAX = 4;
const FORUM_MIN_INTERVAL_MS = 25 * 1000;
const forumRateLimits = new Map();

const checkForumRateLimit = (ip) => {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const entry = forumRateLimits.get(key) || {
    count: 0,
    resetAt: now + FORUM_RATE_LIMIT_WINDOW_MS,
    lastAt: 0,
  };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + FORUM_RATE_LIMIT_WINDOW_MS;
    entry.lastAt = 0;
  }
  if (now - entry.lastAt < FORUM_MIN_INTERVAL_MS) {
    return { ok: false, reason: 'too_fast', retryIn: FORUM_MIN_INTERVAL_MS - (now - entry.lastAt) };
  }
  if (entry.count >= FORUM_RATE_LIMIT_MAX) {
    return { ok: false, reason: 'rate_limited', retryIn: entry.resetAt - now };
  }
  entry.count += 1;
  entry.lastAt = now;
  forumRateLimits.set(key, entry);
  return { ok: true };
};

app.use((req, res, next) => {
  if (!shouldTrackRequest(req)) return next();
  const visitorId = ensureVisitorId(req, res);
  const requestPath = String(req.path || '/');
  const referrer = String(req.get('referer') || '').slice(0, ANALYTICS_REFERRER_MAX_LENGTH);
  const userAgent = String(req.get('user-agent') || '').slice(0, ANALYTICS_UA_MAX_LENGTH);
  const ipHash = hashIp(req.ip || req.connection?.remoteAddress || '');
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 400) return;
    if (!insertPageViewStmt) return;
    insertPageViewStmt.run([visitorId, requestPath, referrer, userAgent, ipHash], (err) => {
      if (err) {
        console.error('Analytics insert failed:', err.message);
      }
    });
  });
  return next();
});

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

const ENTERPRISES_TEMPLATE_PATH = path.join(__dirname, 'partials', 'enterprises.html');
let enterprisesTemplate = '';
try {
  enterprisesTemplate = fs.readFileSync(ENTERPRISES_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Enterprises partial not found:', err.message);
}

const RESTAURANTS_TEMPLATE_PATH = path.join(__dirname, 'partials', 'restaurants.html');
let restaurantsTemplate = '';
try {
  restaurantsTemplate = fs.readFileSync(RESTAURANTS_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Restaurants partial not found:', err.message);
}

const DIRECTORY_TEMPLATE_PATH = path.join(__dirname, 'partials', 'directory.html');
let directoryTemplate = '';
try {
  directoryTemplate = fs.readFileSync(DIRECTORY_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Directory partial not found:', err.message);
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

const ENTERPRISES_PAGE_TEMPLATE_PATH = path.join(__dirname, 'enterprises.html');
let enterprisesPageTemplate = '';
try {
  enterprisesPageTemplate = fs.readFileSync(ENTERPRISES_PAGE_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Enterprises template not found:', err.message);
}

const RESTAURANTS_PAGE_TEMPLATE_PATH = path.join(__dirname, 'restaurants.html');
let restaurantsPageTemplate = '';
try {
  restaurantsPageTemplate = fs.readFileSync(RESTAURANTS_PAGE_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Restaurants template not found:', err.message);
}

const DIRECTORY_PAGE_TEMPLATE_PATH = path.join(__dirname, 'directory.html');
let directoryPageTemplate = '';
try {
  directoryPageTemplate = fs.readFileSync(DIRECTORY_PAGE_TEMPLATE_PATH, 'utf8');
} catch (err) {
  console.warn('Directory template not found:', err.message);
}

const COMPANIES_DATA_PATH = path.join(__dirname, 'data', 'companies.json');
const GOOGLE_PLACES_API_KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
const SERPAPI_KEY = (process.env.SERPAPI_KEY || '').trim();
const SEARCHAPI_KEY = (process.env.SEARCHAPI_KEY || '').trim();
const PLACES_PROVIDER = String(
  process.env.PLACES_PROVIDER
  || (SERPAPI_KEY ? 'serpapi' : (SEARCHAPI_KEY ? 'searchapi' : 'google'))
).trim().toLowerCase();
const PLACES_API_ENABLED = String(process.env.PLACES_API_ENABLED || '').toLowerCase() === 'true';
const PLACES_PREFETCH_ENABLED = String(process.env.PLACES_PREFETCH_ENABLED || '').toLowerCase() === 'true';
const PLACE_DETAILS_CACHE_PATH = path.join(__dirname, 'data', 'place-details.json');
const PLACES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const placesCache = new Map();
const placeIdCache = new Map();
const placePhotoCache = new Map();
const PREFETCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFETCH_START_DELAY_MS = 15 * 1000;
const PREFETCH_DELAY_MS = 250;
let prefetchRunning = false;
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://mxchino.com').replace(/\/$/, '');
let placeDetailsDiskCache = null;
const isPlacesApiEnabled = () => {
  if (!PLACES_API_ENABLED) return false;
  if (PLACES_PROVIDER === 'serpapi') return Boolean(SERPAPI_KEY);
  if (PLACES_PROVIDER === 'searchapi') return Boolean(SEARCHAPI_KEY);
  return Boolean(GOOGLE_PLACES_API_KEY);
};
const loadPlaceDetailsDiskCache = () => {
  if (placeDetailsDiskCache) return placeDetailsDiskCache;
  try {
    const raw = fs.readFileSync(PLACE_DETAILS_CACHE_PATH, 'utf8');
    placeDetailsDiskCache = JSON.parse(raw);
  } catch (err) {
    placeDetailsDiskCache = {};
  }
  return placeDetailsDiskCache;
};
const savePlaceDetailsDiskCache = () => {
  if (!placeDetailsDiskCache) return;
  try {
    fs.writeFileSync(PLACE_DETAILS_CACHE_PATH, JSON.stringify(placeDetailsDiskCache, null, 2), 'utf8');
  } catch (err) {
    console.warn('Failed to persist place details cache:', err.message);
  }
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

const PLACE_PHOTO_DIR = path.join(__dirname, 'image', 'place-photos');
const ensurePlacePhotoDir = () => {
  try {
    fs.mkdirSync(PLACE_PHOTO_DIR, { recursive: true });
  } catch (err) {
    console.warn('Could not create place photo dir:', err.message);
  }
};
ensurePlacePhotoDir();

const sanitizeCover = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^[-a-zA-Z0-9_./:]+$/.test(raw)) return '';
  return raw;
};

const sanitizeUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return '';
  return raw;
};

const buildAbsoluteUrl = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  const prefix = raw.startsWith('/') ? '' : '/';
  return `${SITE_ORIGIN}${prefix}${raw}`;
};

const parseCategoryFromSummary = (summary) => {
  const raw = String(summary || '').trim();
  if (!raw.includes('·')) return '';
  const parts = raw.split('·').map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : '';
};

const formatCategoryLabel = (company) => {
  const raw = String(company.category || '').trim() || parseCategoryFromSummary(company.summary);
  if (!raw) return '';
  if (raw === '中餐') return '中餐馆';
  return raw;
};

const buildRatingSummary = (company, placeData, categoryLabel) => {
  if (typeof placeData?.rating === 'number') {
    const ratingCount = placeData.user_ratings_total ? `（${placeData.user_ratings_total}）` : '';
    return `评分 ${placeData.rating}${ratingCount}${categoryLabel ? ` · ${categoryLabel}` : ''}`;
  }
  const summary = String(company.summary || '').trim();
  if (summary) return summary;
  return categoryLabel || '';
};

const resolveSchemaType = (company, categoryLabel) => {
  const raw = `${categoryLabel || ''} ${company.industry || ''}`;
  if (/超市|市场|商店/.test(raw)) return 'GroceryStore';
  if (/饮品|茶|咖啡/.test(raw)) return 'Cafe';
  if (/餐|火锅|面馆|烧烤|中餐/.test(raw)) return 'Restaurant';
  return 'LocalBusiness';
};

const resolveOgType = (schemaType) => {
  if (schemaType === 'Restaurant') return 'restaurant';
  return 'business.business';
};

const buildCompanyStructuredData = (company, placeData, url, imageUrl, categoryLabel) => {
  const schemaType = resolveSchemaType(company, categoryLabel);
  const geoSource = placeData?.geometry?.location
    || (Number.isFinite(company.lat) && Number.isFinite(company.lng) ? { lat: company.lat, lng: company.lng } : null);
  const addressText = placeData?.formatted_address || '';
  const ratingValue = placeData?.rating;
  const ratingCount = placeData?.user_ratings_total;
  const payload = {
    '@context': 'https://schema.org',
    '@type': schemaType,
    name: company.name,
    url,
  };
  if (imageUrl) payload.image = imageUrl;
  if (addressText || company.city) {
    payload.address = {
      '@type': 'PostalAddress',
      streetAddress: addressText || company.city,
      addressLocality: company.city || '',
      addressCountry: 'MX',
    };
  }
  if (geoSource) {
    payload.geo = {
      '@type': 'GeoCoordinates',
      latitude: geoSource.lat,
      longitude: geoSource.lng,
    };
  }
  if (typeof ratingValue === 'number' && Number.isFinite(ratingValue) && ratingCount) {
    payload.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue,
      ratingCount,
    };
  }
  if (categoryLabel && (schemaType === 'Restaurant' || schemaType === 'Cafe')) {
    payload.servesCuisine = categoryLabel;
  }
  return payload;
};

const buildCompanySeo = (company, placeData) => {
  const name = String(company.name || '').trim();
  const city = String(company.city || '').trim();
  const categoryLabel = formatCategoryLabel(company);
  const title = `墨西哥中文网 - ${name}${city ? `｜${city}` : ''}${categoryLabel ? `｜${categoryLabel}` : ''}`;
  const ratingSummary = buildRatingSummary(company, placeData, categoryLabel);
  const address = placeData?.formatted_address || '';
  let description = `墨西哥中文网收录：${name}${city ? `（${city}）` : ''}`;
  if (ratingSummary) description += `，${ratingSummary}`;
  description += address ? `。地址：${address}` : '。';

  const slug = encodeURIComponent(String(company.slug || ''));
  const canonicalUrl = `${SITE_ORIGIN}/company/${slug}`;
  const placeId = String(placeData?.place_id || company.placeId || company.place_id || '').trim();
  const cover = resolveCompanyCoverUrl(company, placeId);
  const imageUrl = buildAbsoluteUrl(cover) || buildAbsoluteUrl('/apple-touch-icon.png');
  const schema = buildCompanyStructuredData(company, placeData, canonicalUrl, imageUrl, categoryLabel);
  const ogType = resolveOgType(schema['@type']);

  const metaTags = [
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${canonicalUrl}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:url" content="${canonicalUrl}">`,
    `<meta property="og:site_name" content="墨西哥中文网">`,
    `<meta property="og:image" content="${imageUrl}">`,
    `<meta property="og:image:alt" content="${escapeHtml(name)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${imageUrl}">`,
  ].join('\n');

  const jsonLd = `<script type="application/ld+json">${JSON.stringify(schema)}</script>`;
  return { title, description, headHtml: `${metaTags}\n${jsonLd}` };
};

const slugifyAscii = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '');

const formatPriceLevel = (value) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  const clamped = Math.max(0, Math.min(4, Math.round(value)));
  if (clamped === 0) return '免费';
  return '¥'.repeat(clamped);
};

const splitSummaryLines = (summary) => {
  const raw = String(summary ?? '').trim();
  if (!raw) return [];
  const parts = raw.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length > 1) {
    return [
      { label: '主打', text: parts[0] },
      { label: '适合', text: parts.slice(1).join('，') },
    ];
  }
  return [{ label: '亮点', text: raw }];
};

const buildSummaryLinesHtml = (summary) => {
  const lines = splitSummaryLines(summary);
  if (!lines.length) {
    return '<p class="muted">暂无简介。</p>';
  }
  const items = lines.map((item) => (
    `<li><strong>${escapeHtml(item.text)}</strong></li>`
  )).join('');
  return `<ul class="company-summary-list">${items}</ul>`;
};

const getTodayHours = (openingHours) => {
  const weekdayText = openingHours?.weekday_text;
  if (!Array.isArray(weekdayText) || weekdayText.length < 7) return '';
  const today = new Date().getDay();
  const index = (today + 6) % 7;
  const entry = String(weekdayText[index] || '').trim();
  if (!entry) return '';
  const parts = entry.split(/[:：]/);
  if (parts.length < 2) return '';
  return parts.slice(1).join(':').trim();
};

const buildValueLineHtml = (company, placeData) => {
  const parts = [];
  if (placeData?.rating) {
    const ratingCount = placeData.user_ratings_total
      ? `（${placeData.user_ratings_total} 条评价）`
      : '';
    parts.push(`⭐ ${placeData.rating}${ratingCount}`);
  }
  const priceLevel = formatPriceLevel(placeData?.price_level);
  if (priceLevel) {
    parts.push(`人均 ${priceLevel}`);
  }
  const summaryTag = splitSummaryLines(company.summary)?.[0]?.text || '';
  if (summaryTag) {
    const trimmed = summaryTag.length > 18 ? `${summaryTag.slice(0, 18)}…` : summaryTag;
    parts.push(trimmed);
  }
  if (!parts.length) return '';
  return `<div class="company-value-line">${parts.map((part) => `<span>${escapeHtml(part)}</span>`).join('')}</div>`;
};

const buildValueSublineHtml = (placeData) => {
  const parts = [];
  const todayHours = getTodayHours(placeData?.opening_hours);
  if (todayHours) {
    parts.push(`<span class="subtle">今日营业 ${escapeHtml(todayHours)}</span>`);
  }
  if (!parts.length) return '';
  return `<div class="company-value-subline">${parts.join('')}</div>`;
};

const getLocalPlacePhoto = (placeId, index = 0) => {
  const safeId = String(placeId || '').trim();
  if (!safeId) return null;
  const fileName = index > 0 ? `${safeId}-${index}.jpg` : `${safeId}.jpg`;
  const abs = path.join(PLACE_PHOTO_DIR, fileName);
  if (fs.existsSync(abs)) {
    return { abs, url: `/image/place-photos/${fileName}` };
  }
  return null;
};

const resolveCompanyCoverUrl = (company, placeId) => {
  const explicitCover = sanitizeCover(company?.cover);
  if (explicitCover) return explicitCover;
  const localCover = getLocalPlacePhoto(placeId, 0)?.url || '';
  return sanitizeCover(localCover) || buildPlacePhotoUrl(placeId, 0);
};
const countLocalPlacePhotos = (placeId) => {
  const safeId = String(placeId || '').trim();
  if (!safeId) return 0;
  const MAX_SCAN = 12;
  let count = 0;
  for (let i = 0; i < MAX_SCAN; i += 1) {
    const exists = getLocalPlacePhoto(safeId, i);
    if (exists) {
      count += 1;
    } else if (i === 0) {
      break;
    } else {
      break;
    }
  }
  return count;
};

const buildPlacePhotoUrl = (placeId, index = 0) => {
  const local = getLocalPlacePhoto(placeId, index);
  if (local) return local.url;
  if (!isPlacesApiEnabled()) return '';
  const safeId = String(placeId || '').trim();
  if (!safeId) return '';
  const safeIndex = Number.isInteger(index) && index > 0 ? `/${index}` : '';
  return `/api/place-photo/${safeId}${safeIndex}`;
};

const DIRECTORY_FOOD_CATEGORIES = ['中餐', '火锅', '面馆', '烧烤', '饮品', '超市'];
const classifyFoodCategoryForDirectory = (company) => {
  const existing = String(company.category || '').trim();
  if (existing) return existing;
  const text = `${company.name || ''} ${company.summary || ''}`.toLowerCase();
  if (/火锅|hot\s*pot|hotpot|麻辣烫|串串香/i.test(text)) return '火锅';
  if (/面馆|拉面|ramen|noodle|noodles|牛肉面|兰州|刀削面|米线/i.test(text)) return '面馆';
  if (/烧烤|串串|烤肉|bbq|barbecue|烤鱼/i.test(text)) return '烧烤';
  if (/茶|奶茶|饮品|咖啡|coffee|bubble\s*tea/i.test(text)) return '饮品';
  if (/超市|便利|market|grocery/i.test(text)) return '超市';
  return '中餐';
};

const buildDirectoryDataScript = () => {
  const items = loadCompaniesData()
    .filter((company) => company && company.slug && company.name)
    .map((company) => {
      const placeId = String(company.placeId || company.place_id || '').trim();
      const industry = String(company.industry || '').trim() || '其他';
      return {
        slug: String(company.slug || '').trim(),
        name: String(company.name || '').trim(),
        summary: String(company.summary || '').trim(),
        cover: resolveCompanyCoverUrl(company, placeId),
        city: String(company.city || '未分类城市').trim(),
        industry,
        category: industry === '餐饮与服务' ? classifyFoodCategoryForDirectory(company) : '',
      };
    });
  const payload = { items };
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<script>window.__DIRECTORY_DATA__=${json};</script>`;
};

const getCachedValue = (cache, key) => {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt > Date.now()) return entry.value;
  cache.delete(key);
  return null;
};

const setCachedValue = (cache, key, value) => {
  cache.set(key, { value, expiresAt: Date.now() + PLACES_CACHE_TTL_MS });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, options) => {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  return data;
};

const isHttpUrl = (value) => /^https?:\/\//i.test(String(value || ''));

const fetchSerpApiJson = async (params) => {
  const provider = PLACES_PROVIDER;
  const apiKey = provider === 'searchapi' ? SEARCHAPI_KEY : SERPAPI_KEY;
  if (!apiKey) {
    throw new Error(provider === 'searchapi' ? 'Missing SEARCHAPI_KEY' : 'Missing SERPAPI_KEY');
  }
  const endpoint = provider === 'searchapi'
    ? 'https://www.searchapi.io/api/v1/search'
    : 'https://serpapi.com/search.json';
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  url.searchParams.set('api_key', apiKey);
  return fetchJson(url.toString());
};

const normalizeSerpOpenNow = (value) => {
  if (typeof value === 'boolean') return value;
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (['true', 'yes', 'open', 'open now', '营业', '营业中'].includes(raw)) return true;
  if (['false', 'no', 'closed', '休息', '休息中'].includes(raw)) return false;
  return undefined;
};

const normalizeSerpWeekdayText = (hours) => {
  if (Array.isArray(hours?.weekday_text) && hours.weekday_text.length >= 7) {
    return hours.weekday_text;
  }
  if (Array.isArray(hours?.days)) {
    const mapped = hours.days
      .map((entry) => {
        const day = String(entry?.day || '').trim();
        const span = String(entry?.hours || '').trim();
        if (!day || !span) return '';
        return `${day}: ${span}`;
      })
      .filter(Boolean);
    return mapped.length ? mapped : [];
  }
  return [];
};

const normalizeSerpPriceLevel = (value) => {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const raw = String(value || '');
  const match = raw.match(/[$¥€£]+/);
  if (!match) return undefined;
  return match[0].length;
};

const normalizeSerpPhotos = (photos) => {
  if (!Array.isArray(photos)) return [];
  const output = [];
  photos.forEach((item) => {
    if (!item) return;
    if (typeof item === 'string') {
      output.push({ photo_reference: item });
      return;
    }
    const url = item.image || item.photo || item.thumbnail || item.url || '';
    if (url) {
      output.push({ photo_reference: url });
    }
  });
  return output;
};

const buildMapsUrlFromPlaceId = (placeId) => {
  const safeId = String(placeId || '').trim();
  if (!safeId) return '';
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(safeId)}`;
};

const mapSerpPlaceResult = (place, fallbackPlaceId = '') => {
  if (!place) return null;
  const placeId = String(place.place_id || fallbackPlaceId || '').trim();
  const rating = Number(place.rating);
  const reviews = Number(place.reviews || place.reviews_count || place.user_ratings_total);
  const priceLevel = normalizeSerpPriceLevel(place.price_level || place.price);
  const gps = place.gps_coordinates || place.gps || null;
  const latitude = Number(gps?.latitude ?? gps?.lat);
  const longitude = Number(gps?.longitude ?? gps?.lng);
  const geometry = (Number.isFinite(latitude) && Number.isFinite(longitude))
    ? { location: { lat: latitude, lng: longitude } }
    : undefined;
  const address = place.address || place.full_address || place.formatted_address || '';
  const phone = place.phone || place.phone_number || '';
  const hours = place.hours || place.opening_hours || {};
  const openingHours = {};
  const openNow = normalizeSerpOpenNow(hours?.open_now ?? place.open_state);
  if (typeof openNow === 'boolean') openingHours.open_now = openNow;
  const weekdayText = normalizeSerpWeekdayText(hours);
  if (weekdayText.length) openingHours.weekday_text = weekdayText;
  const photos = normalizeSerpPhotos(place.photos);
  const images = Array.isArray(place.images) ? place.images : [];
  const mapsUrl = place.links?.google_maps || place.google_maps_url || place.url || buildMapsUrlFromPlaceId(placeId);
  const website = place.website || place.links?.website || '';

  return {
    place_id: placeId || place.place_id,
    name: place.title || place.name || '',
    rating: Number.isFinite(rating) ? rating : undefined,
    user_ratings_total: Number.isFinite(reviews) ? reviews : undefined,
    price_level: Number.isFinite(priceLevel) ? priceLevel : undefined,
    geometry,
    formatted_address: address || undefined,
    formatted_phone_number: phone || undefined,
    opening_hours: Object.keys(openingHours).length ? openingHours : undefined,
    photos: photos.length ? photos : undefined,
    images: images.length ? images : undefined,
    url: mapsUrl || undefined,
    website: website || undefined,
  };
};

const fetchPlaceIdByQuery = async (query) => {
  if (!isPlacesApiEnabled() || !query) return '';
  const cached = getCachedValue(placeIdCache, query);
  if (cached) return cached;
  if (PLACES_PROVIDER === 'serpapi' || PLACES_PROVIDER === 'searchapi') {
    try {
      const data = await fetchSerpApiJson({
        engine: 'google_maps',
        type: 'search',
        q: query,
        hl: 'zh-CN',
        gl: 'mx',
      });
      const localResults = Array.isArray(data.local_results) ? data.local_results : [];
      const first = localResults[0] || data.place_results || null;
      const placeId = String(first?.place_id || '').trim();
      if (placeId) {
        setCachedValue(placeIdCache, query, placeId);
      }
      return placeId;
    } catch (err) {
      console.warn('SerpApi find failed:', err.message);
      return '';
    }
  }
  if (!GOOGLE_PLACES_API_KEY) return '';
  const url = new URL('https://maps.googleapis.com/maps/api/place/findplacefromtext/json');
  url.searchParams.set('input', query);
  url.searchParams.set('inputtype', 'textquery');
  url.searchParams.set('fields', 'place_id,name');
  url.searchParams.set('language', 'zh-CN');
  url.searchParams.set('key', GOOGLE_PLACES_API_KEY);
  try {
    const data = await fetchJson(url.toString());
    if (data.status !== 'OK' || !Array.isArray(data.candidates) || !data.candidates[0]) {
      console.warn('Places find failed:', data.status, data.error_message || '');
      return '';
    }
    const placeId = String(data.candidates[0].place_id || '').trim();
    if (placeId) {
      setCachedValue(placeIdCache, query, placeId);
    }
    return placeId;
  } catch (err) {
    console.warn('Places find failed:', err.message);
    return '';
  }
};

const pickPlaceResult = (data, placeId = '') => {
  const localResults = Array.isArray(data?.local_results) ? data.local_results : [];
  const placeResults = data?.place_results || data?.place_result || null;
  const candidates = localResults.length ? localResults : (placeResults ? [placeResults] : []);
  if (!placeId) return candidates[0] || null;
  const match = candidates.find((item) => String(item?.place_id || '').trim() === placeId);
  return match || candidates[0] || null;
};

const fetchPlaceDetails = async (placeId, query = '') => {
  if (!isPlacesApiEnabled() || !placeId) return null;
  const cached = getCachedValue(placesCache, placeId);
  if (cached) return cached;
  const diskCache = loadPlaceDetailsDiskCache();
  if (diskCache[placeId]) {
    setCachedValue(placesCache, placeId, diskCache[placeId]);
    return diskCache[placeId];
  }
  if (PLACES_PROVIDER === 'searchapi') {
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return null;
    try {
      const data = await fetchSerpApiJson({
        engine: 'google_maps',
        type: 'search',
        q: safeQuery,
        hl: 'zh-CN',
        gl: 'mx',
      });
      const place = pickPlaceResult(data, placeId);
      const mapped = mapSerpPlaceResult(place, placeId);
      if (!mapped) return null;
      setCachedValue(placesCache, placeId, mapped);
      diskCache[placeId] = mapped;
      savePlaceDetailsDiskCache();
      return mapped;
    } catch (err) {
      console.warn('SearchApi detail failed:', err.message);
      return null;
    }
  }
  if (PLACES_PROVIDER === 'serpapi') {
    try {
      const data = await fetchSerpApiJson({
        engine: 'google_maps',
        type: 'place',
        place_id: placeId,
        hl: 'zh-CN',
        gl: 'mx',
      });
      const place = data.place_results || data.place_result || (Array.isArray(data.local_results) ? data.local_results[0] : null);
      const mapped = mapSerpPlaceResult(place, placeId);
      if (!mapped) return null;
      setCachedValue(placesCache, placeId, mapped);
      diskCache[placeId] = mapped;
      savePlaceDetailsDiskCache();
      return mapped;
    } catch (err) {
      console.warn('SerpApi detail failed:', err.message);
      return null;
    }
  }
  if (!GOOGLE_PLACES_API_KEY) return null;
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', [
    'place_id',
    'name',
    'rating',
    'user_ratings_total',
    'price_level',
    'geometry',
    'formatted_address',
    'formatted_phone_number',
    'opening_hours',
    'photos',
    'url',
    'website',
  ].join(','));
  url.searchParams.set('language', 'zh-CN');
  url.searchParams.set('key', GOOGLE_PLACES_API_KEY);
  try {
    const data = await fetchJson(url.toString());
    if (data.status !== 'OK' || !data.result) {
      console.warn('Places detail failed:', data.status, data.error_message || '');
      return null;
    }
    setCachedValue(placesCache, placeId, data.result);
    diskCache[placeId] = data.result;
    savePlaceDetailsDiskCache();
    return data.result;
  } catch (err) {
    console.warn('Places detail failed:', err.message);
    return null;
  }
};

const fetchPlacePhoto = async (placeId, index = 0) => {
  if (!isPlacesApiEnabled() || !placeId) return null;
  const normalizedIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const cacheKey = `${placeId}:${normalizedIndex}`;
  const cached = getCachedValue(placePhotoCache, cacheKey);
  if (cached) return cached;
  const details = await fetchPlaceDetails(placeId);
  const photoEntry = details?.photos?.[normalizedIndex] || details?.photos?.[0] || null;
  const imageEntry = Array.isArray(details?.images)
    ? (details.images[normalizedIndex] || details.images[0])
    : null;
  const photoRef = photoEntry?.photo_reference
    || photoEntry?.url
    || photoEntry?.image
    || photoEntry?.thumbnail
    || imageEntry?.image
    || imageEntry?.url
    || imageEntry?.thumbnail
    || photoEntry
    || imageEntry;
  if (!photoRef) return null;
  if (isHttpUrl(photoRef)) {
    try {
      const response = await fetch(photoRef);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') || 'image/jpeg';
      const payload = { buffer, contentType };
      setCachedValue(placePhotoCache, cacheKey, payload);
      return payload;
    } catch (err) {
      console.warn('Places photo failed:', err.message);
      return null;
    }
  }
  if (!GOOGLE_PLACES_API_KEY) return null;
  const photoUrl = new URL('https://maps.googleapis.com/maps/api/place/photo');
  photoUrl.searchParams.set('maxwidth', '1600');
  photoUrl.searchParams.set('photo_reference', photoRef);
  photoUrl.searchParams.set('key', GOOGLE_PLACES_API_KEY);
  try {
    const response = await fetch(photoUrl.toString());
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const payload = { buffer, contentType };
    setCachedValue(placePhotoCache, cacheKey, payload);
    return payload;
  } catch (err) {
    console.warn('Places photo failed:', err.message);
    return null;
  }
};

const prefetchPlacesCache = async () => {
  if (!PLACES_PREFETCH_ENABLED || !isPlacesApiEnabled() || prefetchRunning) return;
  prefetchRunning = true;
  try {
    const companies = loadCompaniesData();
    const placeIds = [...new Set(companies.map((company) => (
      String(company.placeId || company.place_id || '').trim()
    )).filter(Boolean))];
    if (!placeIds.length) return;
    console.log(`Prefetching ${placeIds.length} place entries...`);
    for (const placeId of placeIds) {
      await fetchPlaceDetails(placeId);
      await fetchPlacePhoto(placeId);
      if (PREFETCH_DELAY_MS) {
        await sleep(PREFETCH_DELAY_MS);
      }
    }
  } catch (err) {
    console.warn('Prefetch places failed:', err.message);
  } finally {
    prefetchRunning = false;
  }
};

const getCompanyPlaceData = async (company) => {
  const explicitPlaceId = String(company.placeId || company.place_id || '').trim();
  const query = String(company.mapQuery || company.name || '').trim();

  // 永远先看本地缓存，避免未授权调用
  const diskCache = loadPlaceDetailsDiskCache();
  const cachedByPlaceId = explicitPlaceId ? diskCache[explicitPlaceId] : null;
  if (!isPlacesApiEnabled()) {
    // API 未开启时，只返回本地数据
    if (cachedByPlaceId) return cachedByPlaceId;
    // 尝试根据 query 找一下匹配的条目
    const match = Object.values(diskCache || {}).find((item) => item?.name === company.name);
    return match || null;
  }

  // API 开启时才允许查找/更新
  const placeId = explicitPlaceId || await fetchPlaceIdByQuery(query);
  if (!placeId) return null;
  const live = await fetchPlaceDetails(placeId, query);
  if (live) {
    diskCache[placeId] = live;
    savePlaceDetailsDiskCache();
    return live;
  }
  return diskCache[placeId] || null;
};

const buildMapEmbedUrl = (company, placeData) => {
  const embed = sanitizeUrl(company.mapEmbed);
  if (embed) return embed;
  const rawMapLink = sanitizeUrl(company.mapLink || company.mapUrl || company.map);
  if (rawMapLink) {
    try {
      const parsed = new URL(rawMapLink);
      const cid = parsed.searchParams.get('cid');
      if (cid) {
        return `https://maps.google.com/maps?q=${encodeURIComponent(`cid:${cid}`)}&z=16&output=embed`;
      }
    } catch (err) {
      // Ignore malformed map links and continue with other fallbacks.
    }
  }
  const geoLat = Number(placeData?.geometry?.location?.lat ?? company.lat);
  const geoLng = Number(placeData?.geometry?.location?.lng ?? company.lng);
  if (Number.isFinite(geoLat) && Number.isFinite(geoLng)) {
    const coords = `${geoLat},${geoLng}`;
    return `https://maps.google.com/maps?q=${encodeURIComponent(coords)}&z=16&output=embed`;
  }
  const placeId = String(placeData?.place_id || company.placeId || company.place_id || '').trim();
  const query = String(placeData?.name || company.mapQuery || '').trim();
  const q = placeId ? `place_id:${placeId}` : query;
  if (!q) return '';
  return `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed`;
};

const buildCompaniesHtml = (options = {}) => {
  const template = options.template || companiesTemplate;
  if (!template) return '';
  const allCompanies = loadCompaniesData();
  const companies = typeof options.filter === 'function'
    ? allCompanies.filter(options.filter)
    : allCompanies;
  if (!companies.length) {
    return template
      .replace('<!--COMPANY_NAV-->', '')
      .replace('<!--COMPANY_SECTIONS-->', '<p class=\"muted\">暂无企业数据。</p>');
  }

  const cityOrder = [];
  const cityIndex = new Map();
  const cityMap = new Map();

  companies.forEach((company) => {
    const city = company.city || '未分类城市';
    const industry = company.industry || '其他';
    if (!cityMap.has(city)) {
      cityMap.set(city, { count: 0, industries: new Map() });
      cityIndex.set(city, cityOrder.length);
      cityOrder.push(city);
    }
    const cityEntry = cityMap.get(city);
    cityEntry.count += 1;
    if (!cityEntry.industries.has(industry)) {
      cityEntry.industries.set(industry, []);
    }
    cityEntry.industries.get(industry).push(company);
  });

  const priorityCities = new Map([
    ['墨西哥城', 0],
    ['蒙特雷', 1],
  ]);
  const orderedCities = [...cityOrder].sort((a, b) => {
    const pa = priorityCities.has(a) ? priorityCities.get(a) : Number.POSITIVE_INFINITY;
    const pb = priorityCities.has(b) ? priorityCities.get(b) : Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa - pb;
    return cityIndex.get(a) - cityIndex.get(b);
  });

  const totalCount = companies.length;
  const navHtml = [
    `<button class=\"pill is-active\" type=\"button\" data-city=\"all\">全部 <em>${totalCount}</em></button>`,
    ...orderedCities.map((city, index) => {
      const cityEntry = cityMap.get(city);
      const slug = slugifyAscii(city);
      const id = slug ? `city-${slug}` : `city-${index + 1}`;
      return `<button class=\"pill\" type=\"button\" data-city=\"${escapeHtml(city)}\" data-city-target=\"${id}\">${escapeHtml(city)} <em>${cityEntry.count}</em></button>`;
    })
  ].join('');

  const foodIndustry = '餐饮与服务';
  const foodCategoryPriority = ['中餐', '火锅', '面馆', '烧烤', '饮品', '超市'];
  const hotpotRe = /火锅|hot\s*pot|hotpot|麻辣烫|串串香/i;
  const noodleRe = /面馆|拉面|ramen|noodle|noodles|牛肉面|兰州|刀削面|米线/i;
  const bbqRe = /烧烤|串串|烤肉|bbq|barbecue|烤鱼/i;

  const classifyFoodCategory = (company) => {
    const existing = String(company.category || '').trim();
    if (existing) return existing;
    const text = `${company.name || ''} ${company.summary || ''}`.toLowerCase();
    if (hotpotRe.test(text)) return '火锅';
    if (noodleRe.test(text)) return '面馆';
    if (bbqRe.test(text)) return '烧烤';
    return '中餐';
  };

  const renderCompanyCards = (items) => items.map((company) => {
    const safeName = escapeHtml(company.name);
    const safeSummary = escapeHtml(company.summary);
    const placeId = String(company.placeId || company.place_id || '').trim();
    const contactValue = String(company.contact || '').trim();
    const safeContact = escapeHtml(contactValue);
    const hasContact = contactValue && !/未提供|暂无/i.test(contactValue);
    const safeSlug = encodeURIComponent(String(company.slug || ''));
    const safeCover = resolveCompanyCoverUrl(company, placeId);
    const coverStyle = safeCover
      ? ` style=\"background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.12), rgba(15, 23, 42, 0.35)), url('${safeCover}')\"`
      : '';
    const coverClass = safeCover ? ' company-cover' : '';
    const lat = Number(company.lat);
    const lng = Number(company.lng);
    const coordsAttr = Number.isFinite(lat) && Number.isFinite(lng)
      ? ` data-lat=\"${lat}\" data-lng=\"${lng}\"`
      : '';
    const industry = String(company.industry || '').trim();
    const industryAttr = industry ? ` data-industry=\"${escapeHtml(industry)}\"` : '';
    const resolvedCategory = industry === foodIndustry ? classifyFoodCategory(company) : '';
    const categoryAttr = resolvedCategory ? ` data-category=\"${escapeHtml(resolvedCategory)}\"` : '';
    return (
      `<a class=\"company-card company-link${coverClass}\" href=\"/company/${safeSlug}\"${coverStyle}${coordsAttr}${industryAttr}${categoryAttr}>` +
      `<h4>${safeName}</h4>` +
      `<p class=\"company-desc\">${safeSummary}</p>` +
      `<div class=\"company-distance\" data-distance hidden></div>` +
      (hasContact ? `<div class=\"company-contact\"><span>微信/WhatsApp：${safeContact}</span></div>` : '') +
      `</a>`
    );
  }).join('');

  const categoryPriority = new Map(foodCategoryPriority.map((name, index) => [name, index]));

  const buildCityToolsHtml = (cityEntry, industryEntries) => {
    const foodItems = cityEntry.industries.get(foodIndustry) || [];
    const categoryCounts = new Map();
    foodItems.forEach((company) => {
      const category = classifyFoodCategory(company);
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    });
    const categoryButtons = foodCategoryPriority
      .filter((category) => categoryCounts.has(category))
      .map((category) => (
        `<button class=\"filter-pill\" type=\"button\" data-filter=\"${escapeHtml(category)}\" data-filter-scope=\"category\">${escapeHtml(category)}</button>`
      ))
      .join('');
    const industryButtons = industryEntries
      .map(([industry, items]) => ({ industry, count: items.length }))
      .filter((entry) => entry.industry !== foodIndustry)
      .map((entry) => (
        `<button class=\"filter-pill\" type=\"button\" data-filter=\"${escapeHtml(entry.industry)}\" data-filter-scope=\"industry\">${escapeHtml(entry.industry)}</button>`
      ))
      .join('');
    return (
      `<div class=\"city-tools\" data-city-tools data-food-industry=\"${escapeHtml(foodIndustry)}\">` +
      `<div class=\"industry-sort\" role=\"group\" aria-label=\"排序\">` +
      `<span class=\"tools-label\">排序</span>` +
      `<button class=\"sort-pill is-active\" type=\"button\" data-sort=\"default\">默认</button>` +
      `<button class=\"sort-pill\" type=\"button\" data-sort=\"distance\">离我最近</button>` +
      `</div>` +
      `<div class=\"industry-filters\" role=\"group\" aria-label=\"门店筛选\">` +
      `<span class=\"tools-label\">筛选</span>` +
      `<button class=\"filter-pill is-active\" type=\"button\" data-filter=\"all\">全部</button>` +
      categoryButtons +
      industryButtons +
      `</div>` +
      `</div>`
    );
  };

  const buildCityServiceHtml = () => (
    `<div class=\"city-service\">` +
    `<div class=\"city-service-head\">` +
    `<h3>企业服务</h3>` +
    `<span>企业广告招租</span>` +
    `</div>` +
    `<div class=\"city-service-grid\">` +
    `<div class=\"service-card\"><strong>企业广告招租</strong><p>把你的企业放上来</p></div>` +
    `<div class=\"service-card\"><strong>企业广告招租</strong><p>把你的企业放上来</p></div>` +
    `<div class=\"service-card\"><strong>企业广告招租</strong><p>把你的企业放上来</p></div>` +
    `</div>` +
    `</div>`
  );

  const sectionsHtml = orderedCities.map((city, index) => {
    const cityEntry = cityMap.get(city);
    const industryEntries = Array.from(cityEntry.industries.entries());
    const slug = slugifyAscii(city);
    const id = slug ? `city-${slug}` : `city-${index + 1}`;
    const cityToolsHtml = buildCityToolsHtml(cityEntry, industryEntries);
    const cityServiceHtml = buildCityServiceHtml();

  const industriesHtml = industryEntries.map(([industry, items]) => {
    if (industry === foodIndustry) {
      const categoryOrder = [];
      const categoryIndex = new Map();
      const categoryMap = new Map();

      items.forEach((company) => {
        const category = classifyFoodCategory(company) || '其他';
        if (!categoryMap.has(category)) {
          categoryMap.set(category, []);
          categoryIndex.set(category, categoryOrder.length);
          categoryOrder.push(category);
        }
        categoryMap.get(category).push(company);
      });

      const orderedCategories = [...categoryOrder].sort((a, b) => {
        const pa = categoryPriority.has(a) ? categoryPriority.get(a) : Number.POSITIVE_INFINITY;
        const pb = categoryPriority.has(b) ? categoryPriority.get(b) : Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        return categoryIndex.get(a) - categoryIndex.get(b);
      });

      const categoriesHtml = orderedCategories.map((category) => {
        const categoryItems = categoryMap.get(category) || [];
        const cardsHtml = renderCompanyCards(categoryItems);
        return (
          `<div class=\"industry-subgroup\" data-category=\"${escapeHtml(category)}\">` +
          `<div class=\"industry-subhead\">` +
          `<h4>${escapeHtml(category)}</h4>` +
          `<span class=\"industry-count\">${categoryItems.length} 家</span>` +
          `</div>` +
          `<div class=\"company-grid\">${cardsHtml}</div>` +
          `</div>`
        );
      }).join('');

      return (
        `<div class=\"industry-block\" data-industry=\"${escapeHtml(industry)}\">` +
        `<div class=\"industry-head\">` +
        `<h3>${escapeHtml(industry)}</h3>` +
        `<span class=\"industry-count\">${items.length} 家</span>` +
        `</div>` +
        `<div class=\"industry-subgroups\">${categoriesHtml}</div>` +
        `</div>`
      );
    }

    const cardsHtml = renderCompanyCards(items);
    return (
      `<div class=\"industry-block\" data-industry=\"${escapeHtml(industry)}\">` +
      `<div class=\"industry-head\">` +
      `<h3>${escapeHtml(industry)}</h3>` +
      `<span class=\"industry-count\">${items.length} 家</span>` +
      `</div>` +
      `<div class=\"company-grid\">${cardsHtml}</div>` +
      `</div>`
    );
  }).join('');

    return (
      `<section class=\"city-section\" id=\"${id}\" data-city=\"${escapeHtml(city)}\">` +
      `<div class=\"city-head\">` +
      `<h2>${escapeHtml(city)}</h2>` +
      `</div>` +
      cityToolsHtml +
      cityServiceHtml +
      `<div class=\"city-body\">${industriesHtml}</div>` +
      `</section>`
    );
  }).join('');

  return template
    .replace('<!--COMPANY_NAV-->', navHtml)
    .replace('<!--COMPANY_SECTIONS-->', sectionsHtml);
};

const isRestaurantCompany = (company) => String(company?.industry || '').trim() === '餐饮与服务';
const isEnterpriseCompany = (company) => String(company?.industry || '').trim() === '中资企业';

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

const WEBSITE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10" stroke="currentColor" fill="none" stroke-width="2"></circle><path fill="currentColor" d="M2 12h20M12 2a15.97 15.97 0 00-4 12 15.97 15.97 0 004 12M12 2a15.97 15.97 0 014 12 15.97 15.97 0 01-4 12M8.5 4.75a12.86 12.86 0 00-2 7.25 12.86 12.86 0 002 7.25m7-14.5a12.86 12.86 0 012 7.25 12.86 12.86 0 01-2 7.25"></path></svg>';
const PHONE_ICON_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M6.62 10.79a15.053 15.053 0 006.59 6.59l2.2-2.2a1 1 0 011.11-.21 11.72 11.72 0 003.66.58 1 1 0 011 1V20a1 1 0 01-1 1A16 16 0 013 5a1 1 0 011-1h3.8a1 1 0 011 1 11.72 11.72 0 00.58 3.66 1 1 0 01-.21 1.11z"></path></svg>';
const formatWebsiteLabel = (value) => {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return parsed.hostname.replace(/^www\\./i, '') || parsed.hostname;
  } catch (err) {
    return value;
  }
};

const renderPage = (fileName, options = {}) => {
  const filePath = path.join(__dirname, fileName);
  const page = fs.readFileSync(filePath, 'utf8');
  const companiesHtml = options.companiesHtml || buildCompaniesHtml(options.companies);
  const dataScript = options.dataScript || '';
  return page
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--COMPANIES-->', companiesHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace('<!--DATA-->', dataScript || '');
};

const renderEnterprisesPage = () => {
  if (!enterprisesPageTemplate || !enterprisesTemplate) return '';
  const enterprisesHtml = buildCompaniesHtml({
    template: enterprisesTemplate,
    filter: isEnterpriseCompany,
  });
  return enterprisesPageTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--COMPANIES-->', enterprisesHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '');
};

const renderRestaurantsPage = () => {
  if (!restaurantsPageTemplate || !restaurantsTemplate) return '';
  const restaurantsHtml = buildCompaniesHtml({
    template: restaurantsTemplate,
    filter: isRestaurantCompany,
  });
  return restaurantsPageTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--COMPANIES-->', restaurantsHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '');
};

const renderDirectoryPage = (dataScript = '') => {
  if (!directoryPageTemplate || !directoryTemplate) return '';
  return directoryPageTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--COMPANIES-->', directoryTemplate || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace('<!--DATA-->', dataScript || '');
};

const renderCompanyPage = async (company) => {
  if (!companyTemplate) return '';
  const placeData = await getCompanyPlaceData(company);
  const safeName = escapeHtml(company.name);
  const safeSlug = escapeHtml(company.slug || '');
  const safeIndustry = escapeHtml(company.industry);
  const safeCity = escapeHtml(company.city);
  const contactValue = String(company.contact || '').trim();
  const safeContact = escapeHtml(contactValue);
  const safeDetail = escapeHtml(company.detail);
  const placePhone = placeData?.formatted_phone_number || company.phone || '';
  const placeWebsite = sanitizeUrl(placeData?.website || company.website);
  const safePlaceUrl = sanitizeUrl(placeData?.url);
  const safeMapLink = sanitizeUrl(company.mapLink || company.mapUrl || company.map) || safePlaceUrl;
  const mapEmbedUrl = buildMapEmbedUrl(company, placeData);
  const detailEnabled = Boolean(company.detail && company.detailPaid);
  const detailHtml = detailEnabled
    ? `<div class="company-detail-extra"><h2>详情</h2><p>${safeDetail}</p></div>`
    : `<div class="company-detail-extra locked"><h2>详情</h2><p>该企业未开通详情展示，如需展示请联系站长。</p></div>`;
  const placeId = String(placeData?.place_id || company.placeId || company.place_id || '').trim();
  const seo = buildCompanySeo(company, placeData);
  const safeCover = resolveCompanyCoverUrl(company, placeId);
  const galleryImages = new Set();
  const addGalleryImage = (value) => {
    const raw = String(value || '').trim();
    if (raw) galleryImages.add(raw);
  };
  addGalleryImage(safeCover);
  const heroStyle = safeCover
    ? ` style="background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.1), rgba(15, 23, 42, 0.35)), url('${safeCover}')"`
    : '';
  const localPhotoCount = countLocalPlacePhotos(placeId);
  const photoCount = localPhotoCount || (Array.isArray(placeData?.photos) ? placeData.photos.length : 0);
  const mapLinkForPhotos = safeMapLink || safePlaceUrl;
  const thumbTiles = [];
  if (placeId && photoCount > 1) {
    const maxThumbs = Math.min(4, Math.max(1, photoCount - 1));
    for (let i = 1; i <= maxThumbs; i += 1) {
      const thumbUrl = buildPlacePhotoUrl(placeId, i);
      if (!thumbUrl) continue;
      addGalleryImage(thumbUrl);
      if (mapLinkForPhotos) {
        thumbTiles.push(
          `<a class="company-hero-thumb company-hero-link" href="${mapLinkForPhotos}" target="_blank" rel="noopener" aria-label="在 Google 地图中查看" style="background-image: url('${thumbUrl}')"></a>`
        );
      } else {
        thumbTiles.push(`<div class="company-hero-thumb" style="background-image: url('${thumbUrl}')"></div>`);
      }
    }
  }
  const thumbHtml = thumbTiles.length
    ? `<div class="company-hero-thumbs">${thumbTiles.join('')}</div>`
    : '';
  const heroTile = mapLinkForPhotos
    ? `<a class="company-hero company-hero-link"${heroStyle} href="${mapLinkForPhotos}" target="_blank" rel="noopener" aria-label="在 Google 地图中查看"></a>`
    : `<div class="company-hero"${heroStyle}></div>`;
  const galleryAttr = galleryImages.size ? ` data-gallery="${escapeHtml(Array.from(galleryImages).join('|'))}"` : '';
  const galleryButtonHtml = galleryImages.size > 1
    ? ''
    : '';
  const heroHtml = `<div class="company-hero-grid${thumbTiles.length ? '' : ' company-hero-grid--single'}"${galleryAttr}>${heroTile}${thumbHtml}${galleryButtonHtml}</div>`;
  const valueLineHtml = buildValueLineHtml(company, placeData);
  const valueSublineHtml = buildValueSublineHtml(placeData);
  const summaryLinesHtml = buildSummaryLinesHtml(company.summary);
  const sourceLineHtml = '';
  const hasContact = Boolean(contactValue) && !/未提供|暂无/i.test(contactValue);
  const encodedContact = hasContact ? encodeURIComponent(contactValue) : '';
  const telLink = placePhone ? `tel:${placePhone.replace(/\s+/g, '')}` : '';
  const actionButtons = [];
  const primaryAction = safeMapLink ? 'map' : (placeWebsite ? 'website' : '');
  if (placeWebsite) {
    actionButtons.push(
      `<a class="action-btn${primaryAction === 'website' ? ' primary' : ''}" href="${placeWebsite}" target="_blank" rel="noopener">打开官网</a>`
    );
  }
  if (safeMapLink) {
    actionButtons.push(
      `<a class="action-btn${primaryAction === 'map' ? ' primary' : ''}" href="${safeMapLink}" target="_blank" rel="noopener">打开 Google 地图</a>`
    );
  }
  if (hasContact) {
    actionButtons.push(`<button class="action-btn" type="button" data-copy="${encodedContact}">复制微信/WhatsApp</button>`);
  }
  const contactLinkItems = [];
  if (placePhone) {
    const encodedPhone = encodeURIComponent(placePhone);
    contactLinkItems.push(
      `<div class="company-contact-card company-contact-card--phone">` +
      `<div class="company-contact-card__text">` +
      `<span class="company-contact-card__label">电话</span>` +
      `<strong>${escapeHtml(placePhone)}</strong>` +
      `</div>` +
      `<button class="company-contact-card__btn" type="button" data-copy="${encodedPhone}">复制</button>` +
      `</div>`
    );
  }
  const contactLinksHtml = contactLinkItems.length
    ? `<div class="company-contact-links">${contactLinkItems.join('')}</div>`
    : '';
  const actionCardHtml = (
    `<div class="company-detail-contact">` +
    `<h2>快速行动</h2>` +
    `<div class="action-buttons">${actionButtons.join('')}</div>` +
    `${contactLinksHtml}` +
    `<div class="action-meta">` +
    (hasContact ? `<div><span>微信/WhatsApp</span><strong>${safeContact}</strong></div>` : '') +
    `</div>` +
    `</div>`
  );
  const mapMetaBlocks = [];
  if (placeData?.rating) {
    const ratingCount = placeData.user_ratings_total ? ` (${placeData.user_ratings_total})` : '';
    mapMetaBlocks.push(
      `<div class="map-meta-block"><span>评分</span><strong>${escapeHtml(`${placeData.rating} ★${ratingCount}`)}</strong></div>`
    );
  }
  if (placeData?.formatted_address) {
    mapMetaBlocks.unshift(
      `<div class="map-meta-block map-meta-address"><span>地址</span><strong>${escapeHtml(placeData.formatted_address)}</strong></div>`
    );
  }
  const openNow = placeData?.opening_hours?.open_now;
  const todayHours = getTodayHours(placeData?.opening_hours);
  if (todayHours) {
    mapMetaBlocks.push(
      `<div class="map-meta-block"><span>营业</span>` +
      `${todayHours ? `<em>${escapeHtml(todayHours)}</em>` : ''}` +
      `</div>`
    );
  }
  const mapMetaHtml = mapMetaBlocks.length
    ? `<div class="map-meta-grid">${mapMetaBlocks.join('')}</div>`
    : '';
  const mapActions = [
    safeMapLink ? `<a class="map-link" href="${safeMapLink}" target="_blank" rel="noopener">打开 Google 地图</a>` : '',
    mapEmbedUrl ? `<button class="map-toggle" type="button" data-map-toggle data-map-label="展开地图">展开地图</button>` : '',
  ].filter(Boolean).join('');
  const mapHtml = (safeMapLink || mapEmbedUrl || mapMetaHtml)
    ? (
      `<div class="company-map">` +
      `<div class="map-head"><h2>位置</h2>${mapActions ? `<div class="map-actions">${mapActions}</div>` : ''}</div>` +
      mapMetaHtml +
      (mapEmbedUrl
        ? `<div class="map-embed map-embed--open" data-map-embed><button class="map-close" type="button" data-map-toggle data-map-label="收起地图">收起地图</button><iframe title="Google Maps" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${mapEmbedUrl}"></iframe></div>`
        : '') +
      `</div>`
    )
    : '';
  const actionBarHtml = (
    `<div class="company-action-bar">` +
    (placePhone
      ? `<a class="action-pill primary" href="${telLink}">联系商家</a>`
      : '<span class="action-pill disabled">联系商家</span>') +
    (safeMapLink
      ? `<a class="action-pill" href="${safeMapLink}" target="_blank" rel="noopener">导航前往</a>`
      : '<span class="action-pill disabled">导航前往</span>') +
    `<button class="action-pill" type="button" data-share>分享</button>` +
    `<button class="action-pill" type="button" data-favorite>收藏</button>` +
    `</div>`
  );
  const mergedHeadHtml = `${headHtml || ''}\n${seo.headHtml || ''}`.trim();
  return companyTemplate
    .replace('<!--HEAD-->', mergedHeadHtml)
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace(/<!--COMPANY_NAME-->/g, safeName)
    .replace('<!--COMPANY_TITLE-->', escapeHtml(seo.title || safeName))
    .replace('<!--COMPANY_SLUG-->', safeSlug)
    .replace('<!--COMPANY_INDUSTRY-->', safeIndustry)
    .replace('<!--COMPANY_CITY-->', safeCity)
    .replace('<!--COMPANY_VALUE_LINE-->', valueLineHtml)
    .replace('<!--COMPANY_VALUE_SUBLINE-->', valueSublineHtml)
    .replace('<!--COMPANY_SOURCE_LINE-->', sourceLineHtml)
    .replace('<!--COMPANY_SUMMARY_LINES-->', summaryLinesHtml)
    .replace('<!--COMPANY_ACTION_CARD-->', actionCardHtml)
    .replace('<!--COMPANY_HERO_SECTION-->', heroHtml)
    .replace('<!--COMPANY_MAP_SECTION-->', mapHtml)
    .replace('<!--COMPANY_DETAIL_SECTION-->', detailHtml)
    .replace('<!--COMPANY_ACTION_BAR-->', actionBarHtml);
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

app.get('/api/forum-posts', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  db.all(
    `SELECT id, title, content, category, city, contact, created_at
     FROM forum_posts
     ORDER BY datetime(created_at) DESC
     LIMIT ?`,
    [limit],
    (err, rows) => {
      if (err) {
        console.error('Forum read error:', err);
        return res.status(500).json({ ok: false, message: '读取失败' });
      }
      return res.json({ ok: true, data: rows });
    }
  );
});

app.post('/api/forum-posts', (req, res) => {
  const honeypot = String(req.body.website || '').trim();
  if (honeypot) {
    return res.status(400).json({ ok: false, message: '提交失败' });
  }

  const rate = checkForumRateLimit(req.ip || '');
  if (!rate.ok) {
    const retrySeconds = Math.max(1, Math.ceil((rate.retryIn || 1000) / 1000));
    return res.status(429).json({ ok: false, message: `发布太频繁，请 ${retrySeconds} 秒后再试` });
  }

  const title = String(req.body.title || '').trim();
  const content = String(req.body.content || '').trim();
  const category = String(req.body.category || '').trim();
  const city = String(req.body.city || '').trim();
  const contact = String(req.body.contact || '').trim();

  if (title.length < 2 || title.length > 80) {
    return res.status(400).json({ ok: false, message: '标题需要 2-80 个字' });
  }
  if (content.length < 10 || content.length > 2000) {
    return res.status(400).json({ ok: false, message: '内容需要 10-2000 个字' });
  }

  const ipHash = hashIp(req.ip || req.connection?.remoteAddress || '');
  const userAgent = String(req.get('user-agent') || '').slice(0, ANALYTICS_UA_MAX_LENGTH);

  const stmt = db.prepare(
    `INSERT INTO forum_posts (title, content, category, city, contact, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  stmt.run([title, content, category, city, contact, ipHash, userAgent], function (err) {
    if (err) {
      console.error('Forum insert error:', err);
      return res.status(500).json({ ok: false, message: '存储失败' });
    }
    return res.json({ ok: true, id: this.lastID });
  });
});

app.get('/api/analytics', (req, res) => {
  if (!isAnalyticsAuthorized(req)) {
    return res.status(401).json({ ok: false, message: '未授权' });
  }
  const date = normalizeDateParam(req.query.date);
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const byPageSql = `
    SELECT path, COUNT(*) AS pv, COUNT(DISTINCT visitor_id) AS uv
    FROM page_views
    WHERE date(created_at, 'localtime') = ?
    GROUP BY path
    ORDER BY pv DESC
  `;
  const byHourSql = `
    SELECT strftime('%H:00', datetime(created_at, 'localtime')) AS hour,
           COUNT(*) AS pv,
           COUNT(DISTINCT visitor_id) AS uv
    FROM page_views
    WHERE date(created_at, 'localtime') = ?
    GROUP BY hour
    ORDER BY hour ASC
  `;
  const recentSql = `
    SELECT datetime(created_at, 'localtime') AS time,
           path,
           referrer,
           visitor_id
    FROM page_views
    WHERE date(created_at, 'localtime') = ?
    ORDER BY datetime(created_at, 'localtime') DESC
    LIMIT ?
  `;

  db.all(byPageSql, [date], (err, byPage) => {
    if (err) {
      console.error('Analytics query failed:', err);
      return res.status(500).json({ ok: false, message: '统计失败' });
    }
    return db.all(byHourSql, [date], (hourErr, byHour) => {
      if (hourErr) {
        console.error('Analytics query failed:', hourErr);
        return res.status(500).json({ ok: false, message: '统计失败' });
      }
      return db.all(recentSql, [date, limit], (recentErr, recent) => {
        if (recentErr) {
          console.error('Analytics query failed:', recentErr);
          return res.status(500).json({ ok: false, message: '统计失败' });
        }
        return res.json({
          ok: true,
          date,
          byPage,
          byHour,
          recent,
        });
      });
    });
  });
});

app.get('/', (_req, res) => {
  res.send(renderPage('home.html', { dataScript: buildDirectoryDataScript() }));
});

app.get(['/home', '/home.html'], (_req, res) => {
  res.send(renderPage('home.html', { dataScript: buildDirectoryDataScript() }));
});

app.get(['/contact', '/contact.html', '/index.html'], (_req, res) => {
  res.send(renderPage('index.html'));
});

app.get(['/forum', '/forum.html'], (_req, res) => {
  res.send(renderPage('forum.html'));
});

app.get(['/companies', '/companies.html'], (_req, res) => {
  res.send(renderPage('companies.html'));
});

app.get(['/restaurants', '/restaurants.html'], (_req, res) => {
  const html = renderRestaurantsPage();
  if (!html) {
    return res.status(500).send('Restaurants template missing');
  }
  return res.send(html);
});

app.get(['/enterprises', '/enterprises.html'], (_req, res) => {
  const html = renderEnterprisesPage();
  if (!html) {
    return res.status(500).send('Enterprises template missing');
  }
  return res.send(html);
});

app.get(['/directory', '/directory.html'], (_req, res) => {
  const html = renderDirectoryPage(buildDirectoryDataScript());
  if (!html) {
    return res.status(500).send('Directory template missing');
  }
  return res.send(html);
});

app.get('/company/:slug', async (req, res) => {
  const companies = loadCompaniesData();
  const company = companies.find((item) => item.slug === req.params.slug);
  if (!company) {
    return res.status(404).send('未找到该企业信息');
  }
  const html = await renderCompanyPage(company);
  if (!html) {
    return res.status(500).send('企业详情模板缺失');
  }
  return res.send(html);
});

app.get('/api/place-photo/:placeId/:index?', async (req, res) => {
  const placeId = String(req.params.placeId || '').trim();
  const index = Number.parseInt(req.params.index || '0', 10);
  if (!placeId) {
    return res.status(404).send('Not found');
  }
  const local = getLocalPlacePhoto(placeId, Number.isNaN(index) ? 0 : index);
  if (local) {
    try {
      const buffer = fs.readFileSync(local.abs);
      res.set('Content-Type', 'image/jpeg');
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    } catch (err) {
      console.warn('Failed to read cached photo:', err.message);
    }
  }
  if (!isPlacesApiEnabled()) {
    return res.status(404).send('Not found');
  }
  const photo = await fetchPlacePhoto(placeId, Number.isNaN(index) ? 0 : index);
  if (!photo) {
    return res.status(404).send('Not found');
  }
  try {
    const safeId = String(placeId).trim();
    const fileName = Number.isNaN(index) || index <= 0 ? `${safeId}.jpg` : `${safeId}-${index}.jpg`;
    const abs = path.join(PLACE_PHOTO_DIR, fileName);
    fs.writeFileSync(abs, photo.buffer);
  } catch (err) {
    console.warn('Failed to cache place photo:', err.message);
  }
  res.set('Content-Type', photo.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(photo.buffer);
});

// Serve the static pages and assets so frontend and backend share the same origin.
app.use(express.static(path.join(__dirname)));

app.get('*', (_req, res) => {
  res.send(renderPage('home.html', { dataScript: buildDirectoryDataScript() }));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB file at ${DB_PATH}`);
  if (PLACES_PREFETCH_ENABLED && isPlacesApiEnabled()) {
    setTimeout(() => {
      prefetchPlacesCache();
      setInterval(prefetchPlacesCache, PREFETCH_INTERVAL_MS);
    }, PREFETCH_START_DELAY_MS);
  }
});
