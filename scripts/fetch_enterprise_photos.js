#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
if (!KEY) {
  console.error('缺少 GOOGLE_PLACES_API_KEY，终止。');
  process.exit(1);
}

const photoDir = path.join(__dirname, '..', 'image', 'place-photos');
fs.mkdirSync(photoDir, { recursive: true });

const placeIds = [
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
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res.json();
};

const fetchPlacePhotos = async (placeId) => {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'place_id,photos');
  url.searchParams.set('language', 'en');
  url.searchParams.set('key', KEY);
  const data = await fetchJson(url.toString());
  if (data.status !== 'OK') {
    throw new Error(`Details ${data.status} ${data.error_message || ''}`);
  }
  return data.result?.photos || [];
};

const fetchPhoto = async (photoRef) => {
  const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
  url.searchParams.set('maxwidth', '1600');
  url.searchParams.set('photo_reference', photoRef);
  url.searchParams.set('key', KEY);
  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Photo HTTP ${res.status} ${body}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return buffer;
};

const main = async () => {
  for (const placeId of placeIds) {
    const fileName = `${placeId}.jpg`;
    const filePath = path.join(photoDir, fileName);
    if (fs.existsSync(filePath)) {
      console.log(`跳过已有照片 ${fileName}`);
      continue;
    }
    try {
      const photos = await fetchPlacePhotos(placeId);
      if (!photos.length || !photos[0].photo_reference) {
        throw new Error('无可用 photo_reference');
      }
      const buffer = await fetchPhoto(photos[0].photo_reference);
      fs.writeFileSync(filePath, buffer);
      console.log(`保存封面 ${fileName} (${buffer.length} bytes)`);
    } catch (err) {
      console.warn(`${placeId} 下载失败：${err.message}`);
    }
    await sleep(250);
  }
};

main().catch((err) => {
  console.error('运行出错：', err);
  process.exit(1);
});
