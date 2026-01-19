# 主页改造 + 统一总览页 /directory 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在首页提供三板块预览与城市筛选，并新增统一总览页 `/directory` 支持 Tab+筛选，列表卡片直达详情页。

**Architecture:** 服务端读取 `data/companies.json` 构建精简数据注入页面；前端 JS 负责筛选/Tab/渲染卡片与数量。首页与总览页共享数据结构与卡片样式。

**Tech Stack:** Node.js/Express、原生 HTML/CSS/JS、静态模板+内联脚本。

---

### Task 1: 新增 /directory 页面骨架与路由

**Files:**
- Create: `directory.html`
- Create: `partials/directory.html`
- Modify: `server.js`

**Step 1: Write the failing test**

手动预检（当前应返回 404）：

```bash
curl -I http://localhost:3000/directory
```

**Step 2: Run test to verify it fails**

Expected: `404` or “Not Found”.

**Step 3: Write minimal implementation**

- `directory.html`：提供 `<!--HEAD-->` / `<!--HEADER-->` / `<!--COMPANIES-->` / `<!--FOOTER-->` / `<!--DATA-->` 占位。
- `partials/directory.html`：放置标题区、城市筛选容器、Tab 容器、分类筛选容器、卡片网格容器。
- `server.js`：读取模板并新增渲染函数与路由。

示例片段：

```js
const DIRECTORY_TEMPLATE_PATH = path.join(__dirname, 'partials', 'directory.html');
let directoryTemplate = '';
// ... read file

const DIRECTORY_PAGE_TEMPLATE_PATH = path.join(__dirname, 'directory.html');
let directoryPageTemplate = '';

const renderDirectoryPage = (dataScript = '') => {
  if (!directoryPageTemplate || !directoryTemplate) return '';
  return directoryPageTemplate
    .replace('<!--HEAD-->', headHtml || '')
    .replace('<!--HEADER-->', headerHtml || '')
    .replace('<!--COMPANIES-->', directoryTemplate || '')
    .replace('<!--FOOTER-->', footerHtml || '')
    .replace('<!--DATA-->', dataScript || '');
};

app.get(['/directory', '/directory.html'], (_req, res) => {
  const html = renderDirectoryPage();
  if (!html) return res.status(500).send('Directory template missing');
  res.send(html);
});
```

**Step 4: Run test to verify it passes**

```bash
npm start
```

Open: `http://localhost:3000/directory` -> 页面可访问（结构容器可见）。

**Step 5: Commit**

```bash
git add directory.html partials/directory.html server.js
git commit -m "feat: add directory page skeleton"
```

---

### Task 2: 注入统一数据脚本（首页 + /directory）

**Files:**
- Modify: `server.js`
- Modify: `home.html`
- Modify: `directory.html`

**Step 1: Write the failing test**

```bash
node -e "console.log(Boolean(window && window.__DIRECTORY_DATA__))" 2>/dev/null
```

Expected: 无法访问（当前页面没有数据脚本）。

**Step 2: Run test to verify it fails**

Expected: `ReferenceError: window is not defined`（说明还没注入）。

**Step 3: Write minimal implementation**

- 在 `server.js` 中构建数据对象并序列化注入：

```js
const foodIndustry = '餐饮与服务';
const classifyFoodCategory = (company) => { /* 复用现有逻辑 */ };

const buildDirectoryData = () => {
  const companies = loadCompaniesData();
  return companies.map((company) => ({
    slug: company.slug,
    name: company.name,
    summary: company.summary,
    cover: resolveCompanyCoverUrl(company, company.placeId || company.place_id),
    city: company.city || '未分类城市',
    industry: company.industry || '其他',
    category: (company.industry === foodIndustry) ? classifyFoodCategory(company) : '',
  })).filter((item) => item.slug && item.name);
};

const buildDirectoryDataScript = () => {
  const payload = { items: buildDirectoryData() };
  return `<script>window.__DIRECTORY_DATA__=${JSON.stringify(payload)};</script>`;
};
```

- `home.html` 与 `directory.html` 增加 `<!--DATA-->` 占位。
- 为首页路由与 `/directory` 路由注入 `dataScript`。

**Step 4: Run test to verify it passes**

```bash
npm start
```

在控制台检查 `window.__DIRECTORY_DATA__` 存在且包含 `items`。

**Step 5: Commit**

```bash
git add server.js home.html directory.html
git commit -m "feat: inject directory data script"
```

---

### Task 3: /directory 前端渲染 + Tab + 城市/分类筛选

**Files:**
- Modify: `partials/directory.html`

**Step 1: Write the failing test**

手动预检：访问 `/directory` 时应为空容器。

**Step 2: Run test to verify it fails**

Expected: 无卡片显示。

**Step 3: Write minimal implementation**

在 `partials/directory.html` 中加入脚本：
- 读取 `window.__DIRECTORY_DATA__`。
- Tab 切换（restaurants / enterprises / suppliers），支持 URL 参数 `?tab=`。
- 城市筛选（默认 all），支持 URL 参数 `?city=` 和 `localStorage` 记忆。
- 餐饮 Tab 显示分类筛选（中餐/超市/火锅/面馆/饮品/烧烤），企业/供应商隐藏。
- 渲染卡片网格（链接到 `/company/:slug`）。

示例片段：

```js
const TABS = [
  { id: 'restaurants', label: '餐饮', industry: '餐饮与服务' },
  { id: 'enterprises', label: '中资企业', industry: '中资企业' },
  { id: 'suppliers', label: '供应商', industry: '供应商' },
];
```

**Step 4: Run test to verify it passes**

- 访问 `/directory?tab=restaurants&city=all`，确认卡片可见。
- 切换 Tab 与城市后，卡片与数量更新。

**Step 5: Commit**

```bash
git add partials/directory.html
git commit -m "feat: render directory filters and cards"
```

---

### Task 4: 首页布局 + 预览卡渲染

**Files:**
- Modify: `home.html`

**Step 1: Write the failing test**

手动预检：首页仍为旧 hero 布局。

**Step 2: Run test to verify it fails**

Expected: 仍看到旧版首页结构。

**Step 3: Write minimal implementation**

- 重写 `home.html` 主体结构：
  - 小标题区 `墨西哥华人商家与中资企业导航`
  - 城市筛选条容器
  - 左列（餐饮/供应商）与右列（中资企业）板块
- 增加脚本：
  - 默认“全部”，读取 `localStorage`
  - 过滤后取“最后两条”渲染预览卡
  - “查看更多”分别链接 `/directory?tab=restaurants` 与 `/directory?tab=enterprises`
  - 供应商块显示占位 + CTA 卡

**Step 4: Run test to verify it passes**

- 首页默认显示三板块且每块 3 卡
- 切换城市后，餐饮/企业预览变化

**Step 5: Commit**

```bash
git add home.html
git commit -m "feat: rebuild homepage preview layout"
```

---

### Task 5: 样式支持（首页 + /directory）

**Files:**
- Modify: `site.css`

**Step 1: Write the failing test**

手动预检：新结构缺少样式（未对齐、无网格）。

**Step 2: Run test to verify it fails**

Expected: 视觉错乱。

**Step 3: Write minimal implementation**

新增样式块：
- `.home-directory` / `.home-columns` / `.home-block` / `.home-grid`
- `.directory-shell` / `.directory-tabs` / `.directory-grid` / `.category-filters`
- 复用 `.pill` 并扩展轻量变体（更精致的胶囊）
- 响应式：移动端改为单列

**Step 4: Run test to verify it passes**

在桌面与移动宽度下检查布局与可读性。

**Step 5: Commit**

```bash
git add site.css
git commit -m "style: add homepage and directory layout"
```

---

### Task 6: 更新 sitemap + 链接补充

**Files:**
- Modify: `scripts/generate_sitemap.js`
- Modify: `sitemap.xml`

**Step 1: Write the failing test**

运行 sitemap 生成前，未包含 `/directory`。

**Step 2: Run test to verify it fails**

```bash
rg "/directory" sitemap.xml
```

Expected: 无匹配。

**Step 3: Write minimal implementation**

- 在 `urls` 中加入 `{ loc: `${baseUrl}/directory`, priority: '0.8', changefreq: 'weekly' }`。
- 运行 `npm run sitemap` 生成新 sitemap。

**Step 4: Run test to verify it passes**

```bash
npm run sitemap
rg "/directory" sitemap.xml
```

Expected: 存在 `/directory`。

**Step 5: Commit**

```bash
git add scripts/generate_sitemap.js sitemap.xml
git commit -m "chore: add directory to sitemap"
```

---

## Open Questions
- 供应商 CTA 链接最终指向：`/contact` 还是未来 `/suppliers`？

