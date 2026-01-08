const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'partials', 'companies.html');
const dataPath = path.join(root, 'data', 'companies.json');

const html = fs.readFileSync(htmlPath, 'utf8');
const lines = html.split('\n');

let currentCity = '';
let currentIndustry = '';
const companies = [];
const out = [];

const slugify = (value) => String(value || '')
  .toLowerCase()
  .replace(/\s+/g, '-')
  .replace(/[^a-z0-9-]/g, '')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  const cityMatch = line.match(/<h2>([^<]+)<\/h2>/);
  if (cityMatch) {
    currentCity = cityMatch[1].trim();
  }

  const industryMatch = line.match(/<h3>([^<]+)<\/h3>/);
  if (industryMatch) {
    currentIndustry = industryMatch[1].trim();
  }

  if (line.includes('<article class="company-card')) {
    const indent = line.match(/^\s*/)[0];
    const block = [line];
    let j = i + 1;
    while (j < lines.length) {
      block.push(lines[j]);
      if (lines[j].includes('</article>')) break;
      j += 1;
    }

    const blockText = block.join('\n');
    const nameMatch = blockText.match(/<h4>([^<]+)<\/h4>/);
    const summaryMatch = blockText.match(/<p class="company-desc">([\s\S]*?)<\/p>/);
    const contactMatch = blockText.match(/微信\/WhatsApp：\s*([^<\s]+)/);

    const name = nameMatch ? nameMatch[1].trim() : '';
    const summary = summaryMatch ? summaryMatch[1].trim() : '';
    const contact = contactMatch ? contactMatch[1].trim() : '';
    const slug = contact || slugify(name) || `company-${companies.length + 1}`;

    const entry = {
      slug,
      name,
      industry: currentIndustry,
      city: currentCity,
      summary,
      contact: contact || slug,
    };

    if (slug === 'yunhai-mx') {
      entry.cover = '/assets/pexels-rickyrecap-1720086.jpg';
    }

    companies.push(entry);

    out.push(`${indent}<a class="company-card company-link" href="/company/${slug}">`);
    for (let k = 1; k < block.length - 1; k += 1) {
      out.push(block[k]);
    }
    out.push(`${indent}</a>`);

    i = j;
    continue;
  }

  out.push(line);
}

fs.writeFileSync(htmlPath, out.join('\n'));
fs.writeFileSync(dataPath, `${JSON.stringify(companies, null, 2)}\n`);

console.log(`Updated ${companies.length} companies.`);
