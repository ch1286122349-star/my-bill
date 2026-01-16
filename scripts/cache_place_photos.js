#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SERPAPI_KEY = (process.env.SERPAPI_KEY || '').trim();
const SEARCHAPI_KEY = (process.env.SEARCHAPI_KEY || '').trim();
const PLACES_PROVIDER = String(
  process.env.PLACES_PROVIDER
  || (SEARCHAPI_KEY ? 'searchapi' : (SERPAPI_KEY ? 'serpapi' : 'google'))
).trim().toLowerCase();
const PLACES_API_KEY = PLACES_PROVIDER === 'searchapi' ? SEARCHAPI_KEY : SERPAPI_KEY;
if (!PLACES_API_KEY) {
  console.error(PLACES_PROVIDER === 'searchapi' ? 'Missing SEARCHAPI_KEY.' : 'Missing SERPAPI_KEY.');
  process.exit(1);
}

const COMPANIES_PATH = path.join(__dirname, '..', 'data', 'companies.json');
const PHOTO_DIR = path.join(__dirname, '..', 'image', 'place-photos');
const MIN_BYTES = Number.parseInt(process.env.PLACE_PHOTO_MIN_BYTES || '120000', 10);
const SERP_INTERVAL_MS = Number.parseInt(
  process.env.PLACES_API_INTERVAL_MS
  || process.env.SEARCHAPI_INTERVAL_MS
  || process.env.SERPAPI_INTERVAL_MS
  || '900',
  10
);

fs.mkdirSync(PHOTO_DIR, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url, attempt = 0) => {
  const res = await fetch(url);
  if (res.ok) return res.json();
  const text = await res.text();
  if (res.status === 429 && attempt < 3) {
    await sleep((attempt + 1) * 2000);
    return fetchJson(url, attempt + 1);
  }
  throw new Error(`HTTP ${res.status} ${text}`);
};

let lastSerpCall = 0;
const fetchSerpApiJson = async (params) => {
  const now = Date.now();
  const wait = SERP_INTERVAL_MS - (now - lastSerpCall);
  if (wait > 0) await sleep(wait);
  const endpoint = PLACES_PROVIDER === 'searchapi'
    ? 'https://www.searchapi.io/api/v1/search'
    : 'https://serpapi.com/search.json';
  const url = new URL(endpoint);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  url.searchParams.set('api_key', PLACES_API_KEY);
  lastSerpCall = Date.now();
  return fetchJson(url.toString());
};

const parseSizeFromUrl = (url) => {
  const match = String(url || '').match(/=w(\d+)-h(\d+)/);
  if (match) return { width: Number(match[1]), height: Number(match[2]) };
  const sMatch = String(url || '').match(/=s(\d+)/);
  if (sMatch) return { width: Number(sMatch[1]), height: Number(sMatch[1]) };
  return { width: 0, height: 0 };
};

const upgradeGoogleusercontentUrl = (url, width = 1600, height = 1200) => {
  const raw = String(url || '');
  if (/streetviewpixels-pa\.googleapis\.com/.test(raw)) {
    try {
      const parsed = new URL(raw);
      if (parsed.searchParams.has('w')) parsed.searchParams.set('w', String(width));
      if (parsed.searchParams.has('h')) parsed.searchParams.set('h', String(height));
      return parsed.toString();
    } catch (err) {
      return raw;
    }
  }
  if (!/googleusercontent\.com/.test(raw)) return raw;
  if (raw.includes('=s')) {
    return raw.replace(/=s\d+(-k-no)?/, `=s${width}-k-no`);
  }
  if (raw.includes('=w') && raw.includes('-h')) {
    return raw.replace(/=w\d+-h\d+(-k-no)?/, `=w${width}-h${height}-k-no`);
  }
  return raw;
};

const normalizePhotoItem = (item) => {
  if (!item) return null;
  if (typeof item === 'string') {
    return { url: item, width: 0, height: 0 };
  }
  const url = item.image || item.photo || item.thumbnail || item.url || '';
  if (!url) return null;
  const width = Number(item.width || 0);
  const height = Number(item.height || 0);
  return { url, width, height };
};

const extractCandidatesFromResult = (place) => {
  const candidates = [];
  const push = (item) => {
    const normalized = normalizePhotoItem(item);
    if (normalized?.url) candidates.push(normalized);
  };

  if (place?.thumbnail) push(place.thumbnail);
  if (Array.isArray(place?.images)) place.images.forEach(push);
  if (Array.isArray(place?.photos)) place.photos.forEach(push);

  return candidates
    .map((item) => {
      const parsed = parseSizeFromUrl(item.url);
      return { ...item, width: item.width || parsed.width, height: item.height || parsed.height };
    })
    .filter((item) => /^https?:\/\//i.test(item.url));
};

const downloadPhoto = async (url, attempt = 0) => {
  const res = await fetch(url);
  if (res.ok) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') || '' };
  }
  if (res.status === 429 && attempt < 2) {
    await sleep((attempt + 1) * 1500);
    return downloadPhoto(url, attempt + 1);
  }
  const text = await res.text();
  throw new Error(`Photo HTTP ${res.status} ${text}`);
};

const getPhotoFileName = (placeId) => `${placeId}.jpg`;

const hasLocalPhoto = (placeId) => {
  if (!placeId) return false;
  const abs = path.join(PHOTO_DIR, getPhotoFileName(placeId));
  return fs.existsSync(abs);
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
  if (!placeId) return null;
  if (PLACES_PROVIDER === 'searchapi') {
    const safeQuery = String(query || '').trim();
    if (!safeQuery) return null;
    const data = await fetchSerpApiJson({
      engine: 'google_maps',
      type: 'search',
      q: safeQuery,
      hl: 'zh-CN',
      gl: 'mx',
    });
    return pickPlaceResult(data, placeId);
  }
  const data = await fetchSerpApiJson({
    engine: 'google_maps',
    type: 'place',
    place_id: placeId,
    hl: 'zh-CN',
    gl: 'mx',
  });
  return data.place_results || data.place_result || (Array.isArray(data.local_results) ? data.local_results[0] : null);
};

const findPlaceIdByQuery = async (query) => {
  const data = await fetchSerpApiJson({
    engine: 'google_maps',
    type: 'search',
    q: query,
    hl: 'zh-CN',
    gl: 'mx',
  });
  const localResults = Array.isArray(data.local_results) ? data.local_results : [];
  const first = localResults[0] || data.place_results || null;
  return String(first?.place_id || '').trim();
};

const ensurePlacePhoto = async (placeId, memo, query = '') => {
  if (!placeId) return false;
  if (memo.has(placeId)) return memo.get(placeId);
  if (hasLocalPhoto(placeId)) {
    memo.set(placeId, true);
    return true;
  }
  let place = null;
  try {
    place = await fetchPlaceDetails(placeId, query);
  } catch (err) {
    console.warn(`Place details failed for ${placeId}:`, err.message);
    memo.set(placeId, false);
    return false;
  }
  const candidates = extractCandidatesFromResult(place);
  if (!candidates.length) {
    memo.set(placeId, false);
    return false;
  }
  const sorted = candidates.sort((a, b) => (b.width * b.height) - (a.width * a.height));
  const abs = path.join(PHOTO_DIR, getPhotoFileName(placeId));
  for (let i = 0; i < Math.min(sorted.length, 6); i += 1) {
    const candidate = sorted[i];
    const photoUrl = upgradeGoogleusercontentUrl(candidate.url);
    try {
      const photo = await downloadPhoto(photoUrl);
      if (!photo?.buffer || photo.buffer.length < MIN_BYTES) continue;
      fs.writeFileSync(abs, photo.buffer);
      memo.set(placeId, true);
      return true;
    } catch (err) {
      console.warn(`Photo download failed (${placeId}):`, err.message);
    }
  }
  memo.set(placeId, false);
  return false;
};

const run = async () => {
  const companies = JSON.parse(fs.readFileSync(COMPANIES_PATH, 'utf8'));
  const memo = new Map();
  const missing = [];
  let updated = 0;
  let resolvedPlaceIds = 0;

  for (const company of companies) {
    if (!company.placeId && !company.place_id) {
      const query = String(company.mapQuery || company.name || '').trim();
      if (query) {
        try {
          const found = await findPlaceIdByQuery(query);
          if (found) {
            company.placeId = found;
            resolvedPlaceIds += 1;
          }
        } catch (err) {
          console.warn(`Search failed for ${company.name}:`, err.message);
        }
      }
    }

    const primaryId = String(company.placeId || company.place_id || '').trim();
    const fallbackId = String(company.buildingPlaceId || '').trim();
    let coverId = '';

  const query = String(company.mapQuery || company.name || '').trim();
  if (await ensurePlacePhoto(primaryId, memo, query)) {
    coverId = primaryId;
  } else if (await ensurePlacePhoto(fallbackId, memo, query)) {
    coverId = fallbackId;
  } else {
      coverId = primaryId || fallbackId;
    }

    if (coverId) {
      company.cover = `/api/place-photo/${coverId}`;
      updated += 1;
    } else {
      company.cover = '';
      missing.push(company.name || company.slug || 'unknown');
    }
  }

  fs.writeFileSync(COMPANIES_PATH, JSON.stringify(companies, null, 2) + '\n');
  console.log(`Updated covers: ${updated}`);
  console.log(`Resolved place ids: ${resolvedPlaceIds}`);
  if (missing.length) {
    console.log('Missing cover ids:');
    missing.forEach((name) => console.log(`- ${name}`));
  }
};

run().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
