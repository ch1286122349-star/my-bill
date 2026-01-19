const fs = require('fs');
const path = require('path');

const baseUrl = (process.env.SITE_ORIGIN || 'https://mxchino.com').replace(/\/$/, '');
const companiesPath = path.join(__dirname, '..', 'data', 'companies.json');
const outputPath = path.join(__dirname, '..', 'sitemap.xml');

const loadCompanies = () => {
  try {
    const raw = fs.readFileSync(companiesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error('Failed to read companies.json:', err.message);
    return [];
  }
};

const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&apos;');

const buildUrl = (slug) => `${baseUrl}/company/${encodeURIComponent(slug)}`;
const RESTAURANT_CITY_DEFS = [
  {
    slug: 'mexico-city',
    aliases: ['墨西哥城', '墨西哥市', 'Mexico City', 'Ciudad de Mexico', 'Ciudad de México', 'CDMX'],
  },
  { slug: 'monterrey', aliases: ['蒙特雷', 'Monterrey'] },
  { slug: 'guadalajara', aliases: ['瓜达拉哈拉', 'Guadalajara'] },
  { slug: 'puebla', aliases: ['普埃布拉', 'Puebla'] },
];
const normalizeCityName = (value) => String(value || '').trim().toLowerCase();
const RESTAURANT_CITY_ALIAS_MAP = new Map();
RESTAURANT_CITY_DEFS.forEach((city) => {
  city.aliases.forEach((alias) => {
    RESTAURANT_CITY_ALIAS_MAP.set(normalizeCityName(alias), city.slug);
  });
});
const resolveRestaurantCitySlug = (value) => RESTAURANT_CITY_ALIAS_MAP.get(normalizeCityName(value)) || '';
const isRestaurantCompany = (company) => {
  const industry = String(company.industry || '').trim();
  if (industry === '餐饮与服务') return true;
  const category = String(company.category || '').trim();
  const summary = String(company.summary || '').trim();
  const name = String(company.name || '').trim();
  const combined = `${name} ${summary} ${category}`.toLowerCase();
  return /中餐|火锅|面馆|烧烤|饮品|茶|咖啡|川菜|湘菜|粤菜|烤鸭|饺子|包子|牛肉面|拉面/.test(combined);
};

const allCompanies = loadCompanies();
const companies = allCompanies
  .filter((company) => company && company.slug)
  .map((company) => String(company.slug).trim())
  .filter(Boolean)
  .sort((a, b) => a.localeCompare(b));

const restaurantCounts = new Map(RESTAURANT_CITY_DEFS.map((city) => [city.slug, 0]));
allCompanies.forEach((company) => {
  if (!company) return;
  if (!isRestaurantCompany(company)) return;
  const slug = resolveRestaurantCitySlug(company.city);
  if (!slug) return;
  restaurantCounts.set(slug, (restaurantCounts.get(slug) || 0) + 1);
});
const restaurantCitySlugs = Array.from(restaurantCounts.entries())
  .filter(([, count]) => count > 0)
  .map(([slug]) => slug);

const today = new Date().toISOString().split('T')[0];
const urls = [
  { loc: `${baseUrl}/`, priority: '1.0', changefreq: 'weekly' },
  { loc: `${baseUrl}/companies`, priority: '0.8', changefreq: 'weekly' },
  { loc: `${baseUrl}/directory`, priority: '0.8', changefreq: 'weekly' },
  { loc: `${baseUrl}/enterprises`, priority: '0.8', changefreq: 'weekly' },
  { loc: `${baseUrl}/forum`, priority: '0.7', changefreq: 'daily' },
  { loc: `${baseUrl}/restaurants`, priority: '0.8', changefreq: 'weekly' },
  ...restaurantCitySlugs.map((slug) => ({
    loc: `${baseUrl}/restaurants/${slug}`,
    priority: '0.7',
    changefreq: 'weekly',
  })),
  ...companies.map((slug) => ({
    loc: buildUrl(slug),
    priority: '0.6',
    changefreq: 'monthly',
  })),
];

const urlset = urls.map((entry) => (
  `  <url>\n` +
  `    <loc>${escapeXml(entry.loc)}</loc>\n` +
  `    <lastmod>${today}</lastmod>\n` +
  `    <changefreq>${entry.changefreq}</changefreq>\n` +
  `    <priority>${entry.priority}</priority>\n` +
  `  </url>`
)).join('\n');

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
  `${urlset}\n` +
  `</urlset>\n`;

fs.writeFileSync(outputPath, sitemap);
console.log(`Sitemap generated at ${outputPath} with ${urls.length} URLs.`);
