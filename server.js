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
const GOOGLE_PLACES_API_KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
const PLACES_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const placesCache = new Map();
const placeIdCache = new Map();
const placePhotoCache = new Map();
const PREFETCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const PREFETCH_START_DELAY_MS = 15 * 1000;
const PREFETCH_DELAY_MS = 250;
let prefetchRunning = false;

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

const sanitizeUrl = (value) => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(raw)) return '';
  return raw;
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
    `<li><span>${escapeHtml(item.label)}</span><strong>${escapeHtml(item.text)}</strong></li>`
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
  if (typeof placeData?.opening_hours?.open_now === 'boolean') {
    const statusClass = placeData.opening_hours.open_now ? 'status-open' : 'status-closed';
    const statusText = placeData.opening_hours.open_now ? '营业中' : '休息中';
    parts.push(`<span class="status ${statusClass}">${statusText}</span>`);
  }
  if (!parts.length) return '';
  return `<div class="company-value-subline">${parts.join('')}</div>`;
};

const buildPlacePhotoUrl = (placeId, index = 0) => {
  const safeId = String(placeId || '').trim();
  if (!safeId) return '';
  const safeIndex = Number.isInteger(index) && index > 0 ? `/${index}` : '';
  return `/api/place-photo/${safeId}${safeIndex}`;
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

const fetchPlaceIdByQuery = async (query) => {
  if (!GOOGLE_PLACES_API_KEY || !query) return '';
  const cached = getCachedValue(placeIdCache, query);
  if (cached) return cached;
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

const fetchPlaceDetails = async (placeId) => {
  if (!GOOGLE_PLACES_API_KEY || !placeId) return null;
  const cached = getCachedValue(placesCache, placeId);
  if (cached) return cached;
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', [
    'place_id',
    'name',
    'rating',
    'user_ratings_total',
    'price_level',
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
    return data.result;
  } catch (err) {
    console.warn('Places detail failed:', err.message);
    return null;
  }
};

const fetchPlacePhoto = async (placeId, index = 0) => {
  if (!GOOGLE_PLACES_API_KEY || !placeId) return null;
  const normalizedIndex = Number.isInteger(index) && index >= 0 ? index : 0;
  const cacheKey = `${placeId}:${normalizedIndex}`;
  const cached = getCachedValue(placePhotoCache, cacheKey);
  if (cached) return cached;
  const details = await fetchPlaceDetails(placeId);
  const photoRef = details?.photos?.[normalizedIndex]?.photo_reference
    || details?.photos?.[0]?.photo_reference;
  if (!photoRef) return null;
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
  if (!GOOGLE_PLACES_API_KEY || prefetchRunning) return;
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
  if (!GOOGLE_PLACES_API_KEY) return null;
  const explicitPlaceId = String(company.placeId || company.place_id || '').trim();
  const query = String(company.mapQuery || company.name || '').trim();
  const placeId = explicitPlaceId || await fetchPlaceIdByQuery(query);
  if (!placeId) return null;
  return fetchPlaceDetails(placeId);
};

const buildMapEmbedUrl = (company, placeData) => {
  const embed = sanitizeUrl(company.mapEmbed);
  if (embed) return embed;
  const placeId = String(placeData?.place_id || company.placeId || company.place_id || '').trim();
  const query = String(placeData?.name || company.mapQuery || '').trim();
  if (GOOGLE_PLACES_API_KEY && (placeId || query)) {
    const base = 'https://www.google.com/maps/embed/v1/place';
    const key = encodeURIComponent(GOOGLE_PLACES_API_KEY);
    const q = placeId ? `place_id:${placeId}` : query;
    return `${base}?key=${key}&q=${encodeURIComponent(q)}`;
  }
  if (!query) return '';
  return `https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`;
};

const buildCompaniesHtml = () => {
  if (!companiesTemplate) return '';
  const companies = loadCompaniesData();
  if (!companies.length) {
    return companiesTemplate
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

  const navHtml = orderedCities.map((city, index) => {
    const cityEntry = cityMap.get(city);
    const slug = slugifyAscii(city);
    const id = slug ? `city-${slug}` : `city-${index + 1}`;
    return `<a class=\"pill\" href=\"#${id}\">${escapeHtml(city)} <em>${cityEntry.count}</em></a>`;
  }).join('');

  const sectionsHtml = orderedCities.map((city, index) => {
    const cityEntry = cityMap.get(city);
    const industryEntries = Array.from(cityEntry.industries.entries());
    const industryCount = industryEntries.length;
    const slug = slugifyAscii(city);
    const id = slug ? `city-${slug}` : `city-${index + 1}`;

    const industriesHtml = industryEntries.map(([industry, items]) => {
      const cardsHtml = items.map((company) => {
        const safeName = escapeHtml(company.name);
        const safeSummary = escapeHtml(company.summary);
        const contactValue = String(company.contact || '').trim();
        const safeContact = escapeHtml(contactValue);
        const hasContact = contactValue && !/未提供|暂无/i.test(contactValue);
        const safeSlug = encodeURIComponent(String(company.slug || ''));
        const safeCover = sanitizeCover(company.cover);
        const coverStyle = safeCover
          ? ` style=\"background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.12), rgba(15, 23, 42, 0.35)), url('${safeCover}')\"`
          : '';
        const coverClass = safeCover ? ' company-cover' : '';
        return (
          `<a class=\"company-card company-link${coverClass}\" href=\"/company/${safeSlug}\"${coverStyle}>` +
          `<h4>${safeName}</h4>` +
          `<p class=\"company-desc\">${safeSummary}</p>` +
          (hasContact ? `<div class=\"company-contact\"><span>微信/WhatsApp：${safeContact}</span></div>` : '') +
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
  const placePhone = placeData?.formatted_phone_number || '';
  const placeWebsite = sanitizeUrl(placeData?.website);
  const safePlaceUrl = sanitizeUrl(placeData?.url);
  const safeMapLink = sanitizeUrl(company.mapLink || company.mapUrl || company.map) || safePlaceUrl;
  const mapEmbedUrl = buildMapEmbedUrl(company, placeData);
  const detailEnabled = Boolean(company.detail && company.detailPaid);
  const detailHtml = detailEnabled
    ? `<div class="company-detail-extra"><h2>详情</h2><p>${safeDetail}</p></div>`
    : `<div class="company-detail-extra locked"><h2>详情</h2><p>该企业未开通详情展示，如需展示请联系站长。</p></div>`;
  const placeId = String(placeData?.place_id || company.placeId || company.place_id || '').trim();
  const safeCover = sanitizeCover(company.cover) || buildPlacePhotoUrl(placeId, 0);
  const heroStyle = safeCover
    ? ` style="background-image: linear-gradient(140deg, rgba(15, 23, 42, 0.1), rgba(15, 23, 42, 0.35)), url('${safeCover}')"`
    : '';
  const photoCount = Array.isArray(placeData?.photos) ? placeData.photos.length : 0;
  const thumbTiles = [];
  if (placeId && photoCount > 1) {
    const firstUrl = buildPlacePhotoUrl(placeId, 1);
    if (firstUrl) {
      thumbTiles.push(`<div class="company-hero-thumb" style="background-image: url('${firstUrl}')"></div>`);
    }
    const secondUrl = buildPlacePhotoUrl(placeId, 2);
    if (secondUrl) {
      thumbTiles.push(`<div class="company-hero-thumb" style="background-image: url('${secondUrl}')"></div>`);
    }
  }
  const thumbHtml = thumbTiles.length
    ? `<div class="company-hero-thumbs">${thumbTiles.join('')}</div>`
    : '';
  const heroHtml = `<div class="company-hero-grid${thumbTiles.length ? '' : ' company-hero-grid--single'}"><div class="company-hero"${heroStyle}></div>${thumbHtml}</div>`;
  const valueLineHtml = buildValueLineHtml(company, placeData);
  const valueSublineHtml = buildValueSublineHtml(placeData);
  const summaryLinesHtml = buildSummaryLinesHtml(company.summary);
  const sourceLineHtml = placeData
    ? '<div class="company-source-line"><span>来源 Google Maps</span></div>'
    : '';
  const hasContact = Boolean(contactValue) && !/未提供|暂无/i.test(contactValue);
  const encodedContact = hasContact ? encodeURIComponent(contactValue) : '';
  const telLink = placePhone ? `tel:${placePhone.replace(/\s+/g, '')}` : '';
  const actionButtons = [];
  const primaryAction = safeMapLink ? 'map' : (placePhone ? 'phone' : '');
  if (placePhone) {
    actionButtons.push(
      `<a class="action-btn${primaryAction === 'phone' ? ' primary' : ''}" href="${telLink}">一键拨号</a>`
    );
  }
  if (safeMapLink) {
    actionButtons.push(
      `<a class="action-btn${primaryAction === 'map' ? ' primary' : ''}" href="${safeMapLink}" target="_blank" rel="noopener">打开 Google 地图</a>`
    );
  }
  if (safePlaceUrl) {
    actionButtons.push(`<a class="action-btn" href="${safePlaceUrl}" target="_blank" rel="noopener">查看全部评价</a>`);
  }
  if (hasContact) {
    actionButtons.push(`<button class="action-btn" type="button" data-copy="${encodedContact}">复制微信/WhatsApp</button>`);
  }
  const actionCardHtml = (
    `<div class="company-detail-contact">` +
    `<h2>快速行动</h2>` +
    `<div class="action-buttons">${actionButtons.join('')}</div>` +
    `<div class="action-meta">` +
    (hasContact ? `<div><span>微信/WhatsApp</span><strong>${safeContact}</strong></div>` : '') +
    `<div><span>电话</span><strong>${placePhone ? escapeHtml(placePhone) : '暂未提供'}</strong></div>` +
    (placeWebsite
      ? `<div><span>官网</span><a href="${placeWebsite}" target="_blank" rel="noopener">${escapeHtml(placeWebsite)}</a></div>`
      : '') +
    `</div>` +
    `</div>`
  );
  const mapMetaBlocks = [];
  if (placeData?.rating) {
    const ratingCount = placeData.user_ratings_total ? ` (${placeData.user_ratings_total})` : '';
    mapMetaBlocks.push(
      `<div class="map-meta-block"><span>评分</span><strong>${escapeHtml(`${placeData.rating} ★${ratingCount}`)}</strong>` +
      `${safePlaceUrl ? `<a class="map-review-link" href="${safePlaceUrl}" target="_blank" rel="noopener">查看评价</a>` : ''}` +
      `</div>`
    );
  }
  if (placeData?.formatted_address) {
    mapMetaBlocks.unshift(
      `<div class="map-meta-block map-meta-address"><span>地址</span><strong>${escapeHtml(placeData.formatted_address)}</strong></div>`
    );
  }
  const openNow = placeData?.opening_hours?.open_now;
  const todayHours = getTodayHours(placeData?.opening_hours);
  if (typeof openNow === 'boolean' || todayHours) {
    mapMetaBlocks.push(
      `<div class="map-meta-block"><span>营业</span>` +
      `${typeof openNow === 'boolean' ? `<strong class="map-open ${openNow ? 'map-open--yes' : 'map-open--no'}">${openNow ? '营业中' : '休息中'}</strong>` : '<strong>营业信息</strong>'}` +
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
        ? `<div class="map-embed" data-map-embed><button class="map-close" type="button" data-map-toggle data-map-label="收起地图">收起地图</button><iframe title="Google Maps" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${mapEmbedUrl}"></iframe></div>`
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
  return companyTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace(/<!--COMPANY_NAME-->/g, safeName)
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
  if (!placeId || !GOOGLE_PLACES_API_KEY) {
    return res.status(404).send('Not found');
  }
  const photo = await fetchPlacePhoto(placeId, Number.isNaN(index) ? 0 : index);
  if (!photo) {
    return res.status(404).send('Not found');
  }
  res.set('Content-Type', photo.contentType);
  res.set('Cache-Control', 'public, max-age=86400');
  return res.send(photo.buffer);
});

// Serve the static pages and assets so frontend and backend share the same origin.
app.use(express.static(path.join(__dirname)));

app.get('*', (_req, res) => {
  res.send(renderPage('home.html'));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`DB file at ${DB_PATH}`);
  if (GOOGLE_PLACES_API_KEY) {
    setTimeout(() => {
      prefetchPlacesCache();
      setInterval(prefetchPlacesCache, PREFETCH_INTERVAL_MS);
    }, PREFETCH_START_DELAY_MS);
  }
});
