#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
if (!KEY) {
  console.error('缺少 GOOGLE_PLACES_API_KEY');
  process.exit(1);
}

const PLACE_DETAILS_PATH = path.join(__dirname, '..', 'data', 'place-details.json');
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(PLACE_DETAILS_PATH, 'utf8'));
} catch (err) {
  cache = {};
}

const PLACE_IDS = [
  'ChIJwYGkH2yNYoYRIsWYQffiFfc',
  'ChIJ37ZnHOeLYoYR1aHbYb9qXj4',
  'ChIJZb6uRJKLYoYR3tz8LOTh2I8',
  'ChIJRYUpMK_uYoYRHkpjt5fUHeI',
  'ChIJjxZvEQDvYoYRNbtIBBIZW5s',
  'ChIJtbCy0UqZYoYRrGWSIwDXVjs',
  'ChIJWRJcItnpYoYRsySGMuNVB-M',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json();
};

const fetchDetails = async (placeId) => {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'place_id,name,formatted_address,formatted_phone_number,website,url,geometry,opening_hours,rating,user_ratings_total,photos');
  url.searchParams.set('language', 'en');
  url.searchParams.set('key', KEY);
  const data = await fetchJson(url.toString());
  if (data.status !== 'OK') {
    throw new Error(`${data.status} ${data.error_message || ''}`);
  }
  return data.result;
};

const main = async () => {
  for (const placeId of PLACE_IDS) {
    try {
      const details = await fetchDetails(placeId);
      cache[placeId] = details;
      console.log(`已更新 ${placeId}`);
    } catch (err) {
      console.warn(`${placeId} 获取失败：${err.message}`);
    }
    await sleep(250);
  }
  fs.writeFileSync(PLACE_DETAILS_PATH, JSON.stringify(cache, null, 2), 'utf8');
  console.log(`保存到 ${PLACE_DETAILS_PATH}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
