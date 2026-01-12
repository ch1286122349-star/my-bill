#!/usr/bin/env node
/**
 * 手动批量抓取 Google Places 照片，保存到 image/place-photos。
 * 用法：
 *   GOOGLE_PLACES_API_KEY=xxx node scripts/fetch_place_photos.js --max=4
 * 说明：
 *   - 每个 place 只调用一次详情接口，再下载前 max 张照片（默认 4），已存在文件会跳过。
 *   - 跑完后可关闭 Google API，前端会优先加载本地照片。
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const KEY = (process.env.GOOGLE_PLACES_API_KEY || '').trim();
if (!KEY) {
  console.error('缺少 GOOGLE_PLACES_API_KEY 环境变量');
  process.exit(1);
}

const companiesPath = path.join(__dirname, '..', 'data', 'companies.json');
const photoDir = path.join(__dirname, '..', 'image', 'place-photos');
const placeDetailsPath = path.join(__dirname, '..', 'data', 'place-details.json');
fs.mkdirSync(photoDir, { recursive: true });

const maxArg = process.argv.find((arg) => arg.startsWith('--max='));
const MAX_PHOTOS = maxArg ? Number.parseInt(maxArg.split('=')[1], 10) : 4;

const companies = JSON.parse(fs.readFileSync(companiesPath, 'utf8'));
const placeIds = [...new Set(companies
  .map((c) => c.placeId || c.place_id)
  .filter(Boolean)
  .map((id) => String(id).trim())
)];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = async (url) => {
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.status || ''}`);
  return data;
};

const fetchPlacePhotos = async (placeId, diskCache) => {
  const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
  url.searchParams.set('place_id', placeId);
  url.searchParams.set('fields', 'place_id,name,formatted_address,formatted_phone_number,opening_hours,rating,user_ratings_total,website,url,geometry,photos');
  url.searchParams.set('language', 'zh-CN');
  url.searchParams.set('key', KEY);
  const data = await fetchJson(url.toString());
  if (data.status !== 'OK') {
    throw new Error(`Details ${data.status} ${data.error_message || ''}`);
  }
  if (data.result) {
    diskCache[placeId] = data.result;
  }
  return data.result?.photos || [];
};

const fetchPhotoBinary = async (photoRef) => {
  const url = new URL('https://maps.googleapis.com/maps/api/place/photo');
  url.searchParams.set('maxwidth', '1600');
  url.searchParams.set('photo_reference', photoRef);
  url.searchParams.set('key', KEY);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Photo HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get('content-type') || 'image/jpeg';
  return { buffer, type };
};

const main = async () => {
  let placeDetailsCache = {};
  try {
    placeDetailsCache = JSON.parse(fs.readFileSync(placeDetailsPath, 'utf8'));
  } catch (err) {
    placeDetailsCache = {};
  }
  console.log(`发现 ${placeIds.length} 个 placeId，开始下载（每个最多 ${MAX_PHOTOS} 张，已存在跳过）...`);
  for (const placeId of placeIds) {
    try {
      const photos = await fetchPlacePhotos(placeId, placeDetailsCache);
      const slice = photos.slice(0, Math.max(1, Math.min(MAX_PHOTOS, photos.length)));
      console.log(`- ${placeId} 详情 OK，照片 ${slice.length} 张`);
      let idx = 0;
      for (const photo of slice) {
        const fileName = idx > 0 ? `${placeId}-${idx}.jpg` : `${placeId}.jpg`;
        const abs = path.join(photoDir, fileName);
        if (fs.existsSync(abs)) {
          console.log(`  · 跳过已存在 ${fileName}`);
          idx += 1;
          continue;
        }
        const { buffer } = await fetchPhotoBinary(photo.photo_reference);
        fs.writeFileSync(abs, buffer);
        console.log(`  · 保存 ${fileName} (${buffer.length} bytes)`);
        idx += 1;
        // 小间隔，避免突发 QPS
        await sleep(150);
      }
    } catch (err) {
      console.warn(`! ${placeId} 失败: ${err.message}`);
    }
    await sleep(200);
  }
  try {
    fs.writeFileSync(placeDetailsPath, JSON.stringify(placeDetailsCache, null, 2), 'utf8');
    console.log(`已更新本地详情缓存 ${placeDetailsPath}`);
  } catch (err) {
    console.warn('写入 place-details.json 失败:', err.message);
  }
  console.log('完成。可以关闭 Google API，前端会优先使用本地图片。');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
