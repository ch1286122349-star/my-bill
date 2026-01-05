# 项目工作规范（SPEC）

## 目标
- 提供「墨西哥中文网」联系/订阅表单的单页静态站点，简洁、清晰、易填写。
- 表单提交写入本地 SQLite；若配置 Google Sheet，则同步到表格便于查看/导出。

## 技术栈
- 前端：HTML + 原生 CSS，内联样式（`index.html`）。
- 后端：Node.js + Express + SQLite（`server.js` + `data.db`）。
- 字体：Google Fonts `Noto Sans SC` + `Space Grotesk`。
- 不依赖前端框架，交互和提交使用原生 JS。

## 设计与视觉
- 主题：暖色基调（橙 `#ff6a3d`、琥珀 `#ffb400`、薄荷 `#2bbfa8`），背景奶油/暖橙渐变（非蓝色）。
- 文字：主色 `--ink: #24140f`，次色 `--muted: #5f4b45`。
- 边角与阴影：圆角 18px，阴影 `0 22px 64px rgba(36, 20, 15, 0.22)`。
- 按钮与 Logo：暖色梯度，悬浮微提升；输入聚焦态用橙色描边/阴影。
- 布局：居中窄版（约 820px），卡片包裹表单，留充足内边距；小屏单列。

## 可访问性与文案
- 每个字段有 `label for` + `id`，必填项标 `*`。
- 占位符提供示例；页面 `lang="zh-Hans"`，viewport 已设置。
- 按钮 `type="submit"`；提交用 fetch，后端接入时无需刷新页面。

## 文件结构
- `index.html`：主页面、样式与前端提交逻辑（fetch `/api/submit`）。
- `server.js`：Express 服务器，提供 API、SQLite 存储，及可选 Google Sheets 同步。
- `package.json`：依赖 express、sqlite3、cors、googleapis；`npm start` 入口。
- `data.db`：SQLite 数据文件（运行后自动生成）。

## 运行与预览
- 安装依赖（首次）：`npm install`
- 启动后端并服务前端：`npm start`，访问 `http://localhost:3000`（推荐用 Cursor 的 Simple Browser 打开，前后端同源无需额外 CORS）。
- 健康检查：`GET http://localhost:3000/api/health`

## 数据查看
- API：`GET http://localhost:3000/api/submissions`（可加 `?limit=200`）返回 JSON。
- SQLite CLI 示例：`sqlite3 data.db "select * from submissions order by created_at desc limit 20;"`。
- 数据表结构：`submissions(id, name, email, city, type, details, contact, created_at)`.
- 若开启 Google Sheet 同步：查看指定表格的 `Submissions` 工作表。
- 若开启飞书多维表格同步：查看对应表。

## Google Sheet 同步（可选）
- 需要一个服务账号 JSON，设置环境变量：
  - `GOOGLE_SERVICE_ACCOUNT_BASE64`（Base64 编码后的 JSON）或 `GOOGLE_SERVICE_ACCOUNT_JSON`（原始 JSON 字符串）
  - `GOOGLE_SHEET_ID`（目标表格的 ID）
- 将服务账号的 `client_email` 添加为表格编辑者。
- Sheets 写入范围：`Submissions!A1`，每行字段为：`[id, created_at, name, email, city, type, details, contact]`。

## 飞书多维表格同步（可选）
- 环境变量：
  - `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（自建应用凭据）
  - `FEISHU_APP_TOKEN`（多维表格应用 token）
  - `FEISHU_TABLE_ID`（表格内的表 ID）
- 将应用的 `client_email` 添加为表格编辑者。
- 写入表字段：`ID, 姓名, 邮箱, 城市, 需求, 主题, 备用联系方式, 创建时间`。

## 变更原则
- 保持暖色主题，不回退到冷色/蓝色基底。
- 交互尽量无框架；新增依赖需说明用途。
- 样式/布局/文案的重大改动，请在提交说明中写明目的与影响。

## 待办/扩展
- 丰富前端校验与提交成功/失败提示（当前为简单状态文案）。
- 需要导出 CSV 时，可加导出脚本或 `/api/submissions.csv`。
- 若要部署云端，可替换 SQLite 为托管数据库（Postgres/MySQL），在 `server.js` 中更新连接配置。 
