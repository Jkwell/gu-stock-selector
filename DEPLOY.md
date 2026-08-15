# 📱 部署到手机使用指南

> 让选股工具在**手机浏览器直接使用**，并可"添加到主屏幕"变成 App。

## ⚠️ 网络情况提醒

- **公网部署**（Cloudflare/Vercel/GitHub Pages）需要能访问国外站点；**国内云**（腾讯云/阿里云）需要实名账号。
- 如果这些都没有，用下面的**局域网方案**（零成本、立即能用，电脑需开机）。

---

## 🏠 方案 A：局域网访问（推荐，立即能用）

电脑和手机连**同一个 WiFi**，手机浏览器访问电脑上的工具。数据实时、功能完整。

### 1. 电脑上启动（一个命令）
```bash
cd d:\项目\gu
npm run mobile   # 同时启动 代理(8787) + 开发服务器(5173)
```
启动后终端会显示类似：
```
Network: http://172.24.124.149:5173/
```

### 2. 查电脑局域网 IP
终端里 `Network:` 那行就是，形如 `172.24.x.x`（不同 WiFi 不同）。

### 3. 手机访问
1. 手机连**同一个 WiFi**
2. 浏览器打开 `http://172.24.x.x:5173`
3. Safari/Chrome → "添加到主屏幕" → 变 App 图标

### 4. 防火墙放行（第一次手机可能打不开）
Windows 可能拦截 5173 端口。放行方法：
- 打开 **Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙**
- 找到 **Node.js**，勾选"专用网络"（或临时关闭防火墙测试）

### 🤖 使用「AI 研报」还需要启动 AI 服务
「AI 研报」Tab 由独立的 Python 服务提供（FastAPI，端口 8000）：
```bash
# 第二个终端：启动 AI 服务（需已安装依赖并配置 ai-server/.env 的 DEEPSEEK_API_KEY）
npm run ai-server
```
手机访问 AI 研报时，请求会打到 `http://电脑IP:8000`，需在 Windows 防火墙**放行 8000 端口**（方法同下方 5173 的放行步骤，找 Python 程序）。
电脑需保持开机、`npm run mobile` 和 `npm run ai-server` 均在运行中。

### 注意事项
- 电脑需保持开机、`npm run mobile` 运行中
- 手机和电脑必须在**同一局域网**（同一 WiFi/路由器）
- 手机端推荐用 Chrome/Safari，添加主屏幕后体验更好

---

## 🌐 方案 B：公网部署（手机随时随地，不依赖电脑）

需要**能访问国外站点**或**国内云账号**，二选一。

### B1：能翻墙 → Cloudflare Pages（免费）
前端已改为直连数据源，部署只需静态托管：
```
npm run build        # 生成 dist/
# 上传 dist/ 到 Cloudflare Pages 或 Vercel
# 手机访问 https://你的项目.pages.dev
```

### B2：有国内云账号 → 腾讯云/阿里云对象存储
- 腾讯云 COS / 阿里云 OSS：静态网站托管 + CDN，国内访问快
- 免费额度够个人用，需实名认证

---

## 原理说明

前端已改为**直连数据源**（腾讯/新浪/东财接口均允许跨域），所以：
- 局域网方案：手机 → 电脑(5173) → 代理(8787) → 数据源
- 公网方案：手机 → 静态托管 → 直连 → 数据源

## 方案一：Cloudflare Pages（推荐，免费）

### 1. 本地构建
```bash
cd d:\项目\gu
npm install
npm run build
# 生成 dist/ 文件夹
```

### 2. 上传部署
1. 打开 [Cloudflare Pages](https://pages.cloudflare.com/)（需注册免费账号）
2. 点 **Create a project** → **Upload assets**
3. 把 `dist/` 文件夹里**所有文件**拖进去（或选择文件夹）
4. 点 **Deploy site**
5. 完成后得到地址：`https://你的项目名.pages.dev`

### 3. 手机使用
1. 手机浏览器打开 `https://你的项目名.pages.dev`
2. Safari/Chrome 菜单 → **"添加到主屏幕"**（Add to Home Screen）
3. 桌面出现 App 图标，点击全屏运行，像原生 App

## 方案二：Vercel（备选）

1. [vercel.com](https://vercel.com) 注册
2. `npx vercel` 在项目目录运行，或网页上传 `dist/`
3. 得到 `https://你的项目.vercel.app`
4. 手机访问 + 添加到主屏幕

## 方案三：GitHub Pages（✅ 本机已验证可用）

当前线上地址：**https://jkwell.github.io/gu-stock-selector/**（仓库 `Jkwell/gu-stock-selector`）

### 首次部署步骤（已执行，记录备用）
1. 安装 gh CLI（`gh_2.97.0_windows_amd64.zip` 解压到 `.tools/`，免管理员）
2. `gh auth login --web` → 浏览器设备码授权（VPN/科学上网需开启）
3. `git config http.proxy http://127.0.0.1:7890`（VPN 代理模式下 git 推送必须走本地代理，端口看本机 Clash 实际值）
4. `git init -b main` + 提交源码 → `gh repo create gu-stock-selector --public --source=. --push`
5. 构建：`npm run build`（已配 `base: './'`，产物相对路径适配子路径）
6. 推 dist 到 `gh-pages` 分支（用临时 worktree 隔离，详见下方"更新部署"）
7. 启用 Pages：`gh api --method POST repos/<owner>/<repo>/pages -f "source[branch]=gh-pages" -f "source[path]=/"`

### 更新部署（改代码后）
```bash
npm run build
git worktree add .gh-pages-tmp gh-pages   # 检出 gh-pages 分支到临时目录
rm -rf .gh-pages-tmp/* && cp -r dist/. .gh-pages-tmp/
cd .gh-pages-tmp && git add -A && git commit -m "deploy: <描述>" && git push origin gh-pages
cd .. && git worktree remove --force .gh-pages-tmp   # 删不掉就手动删残留目录
```

### 注意事项
- GitHub Pages 免费版要求仓库**公开**（私有仓库 Pages 收费）
- PWA 已适配子路径：SW 用相对注册 + `self.registration.scope` 动态缓存路径，手机上仍可"添加到主屏幕"
- 「🤖 AI 研报」依赖本地 FastAPI(8000)，公网站点上该 Tab 无后端可用（需要另行托管后端才支持）

## 注意事项

### 构建命令
```bash
npm run build   # 生成 dist（生产模式，自动直连数据源）
```

### 本地开发不受影响
```bash
npm run proxy   # 终端1
npm run dev     # 终端2 → http://localhost:5173
```
本地开发仍走代理（有缓存降级），生产构建直连，两者自动切换（代码已处理）。

### 更新部署
每次改了代码，重新 `npm run build`，把新的 `dist/` 重新上传覆盖即可。

### 常见问题
| 问题 | 解决 |
|------|------|
| 手机打不开 | 确认地址正确、网络正常；数据源接口偶尔限流，稍等重试 |
| 行情中文乱码 | 生产环境浏览器会自动 GBK 解码，若异常清浏览器缓存 |
| 添加主屏幕没图标 | 用 Safari/Chrome 打开后操作，图标已内置 |
| 推送部署地址后不好记 | 可绑自定义域名（免费）或收藏到浏览器书签 |
