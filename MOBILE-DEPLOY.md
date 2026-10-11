# 📱 手机端部署指南

## 一、快速使用（推荐）⭐

你的项目已经部署在线上了！

**在线地址**：https://jkwell.github.io/gu-stock-selector/

### 手机访问方式

#### 🍎 iOS（iPhone/iPad）

1. **打开 Safari 浏览器**（必须用 Safari，不能用其他浏览器）
2. 访问：https://jkwell.github.io/gu-stock-selector/
3. 点击底部**分享按钮**（方框带向上箭头 ↑）
4. 选择 **"添加到主屏幕"**
5. 点击右上角 **"添加"**
6. 完成！手机桌面会出现 App 图标，点击即可打开

**效果**：
- ✅ 全屏显示，无浏览器地址栏
- ✅ 独立 App 图标和启动画面
- ✅ 离线缓存，无网也能打开（数据需联网）

#### 🤖 Android（小米/华为/OPPO等）

1. **打开 Chrome 浏览器**（或手机自带浏览器）
2. 访问：https://jkwell.github.io/gu-stock-selector/
3. 点击浏览器右上角 **菜单（⋮）**
4. 选择 **"添加到主屏幕"** 或 **"安装应用"**
5. 点击 **"添加"**
6. 完成！桌面出现 App 图标

**注意**：部分国产浏览器（如小米浏览器、UC浏览器）可能不支持 PWA，建议使用 Chrome。

---

## 二、本地开发与测试

### 1. 本地启动

```bash
# 安装依赖（首次运行）
npm install

# 启动开发服务器（手机可访问）
npm run dev
```

服务会启动在 `http://0.0.0.0:5173`

### 2. 手机访问本地服务

**前提**：手机和电脑在**同一 WiFi** 下

**步骤**：

1. 查看电脑本地 IP 地址

```bash
# Windows
ipconfig
# 找到 "无线局域网适配器 WLAN" 的 IPv4 地址，如 192.168.1.100

# Mac/Linux
ifconfig
# 找到 en0 或 wlan0 的 inet 地址
```

2. 手机浏览器打开

```
http://你的IP:5173
# 例如：http://192.168.1.100:5173
```

3. **测试 PWA**：手机浏览器打开后，同样可以"添加到主屏幕"

---

## 三、部署到 GitHub Pages（已完成）

你的项目已经部署了！如果需要重新部署或更新：

### 方法一：使用部署脚本（推荐）

```bash
npm run build
node scripts/deploy-gh-pages.mjs
```

### 方法二：手动部署

```bash
# 1. 构建生产版本
npm run build

# 2. 进入 dist 目录
cd dist

# 3. 初始化 git 仓库
git init
git add -A
git commit -m 'deploy'

# 4. 推送到 gh-pages 分支
git push -f git@github.com:JKwell/gu-stock-selector.git main:gh-pages

# 5. 返回项目根目录
cd ..
```

### 方法三：使用 GitHub Actions 自动部署

创建 `.github/workflows/deploy.yml`：

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - name: Install and Build
        run: |
          npm ci
          npm run build
          
      - name: Deploy
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
```

提交后，每次 push 到 main 分支会自动部署。

---

## 四、部署到其他平台

### 1. Vercel（免费，推荐）

**特点**：
- ✅ 免费
- ✅ 自动 HTTPS
- ✅ 自动部署（连接 GitHub 后推送自动上线）
- ✅ 国内可访问（速度较快）

**步骤**：

1. 访问 https://vercel.com
2. 用 GitHub 账号登录
3. 点击 **"Import Project"**
4. 选择 `gu-stock-selector` 仓库
5. 配置：
   - Framework Preset：`Vite`
   - Build Command：`npm run build`
   - Output Directory：`dist`
6. 点击 **"Deploy"**

**完成**：几分钟后得到地址，如 `https://gu-stock-selector.vercel.app`

### 2. Netlify（免费）

**特点**：
- ✅ 免费
- ✅ 自动 HTTPS
- ✅ 自动部署

**步骤**：

1. 访问 https://netlify.com
2. 用 GitHub 账号登录
3. 点击 **"Add new site"** → **"Import an existing project"**
4. 选择 GitHub 仓库
5. 配置：
   - Build command：`npm run build`
   - Publish directory：`dist`
6. 点击 **"Deploy"**

### 3. Cloudflare Pages（免费）

**特点**：
- ✅ 免费
- ✅ 全球 CDN 加速
- ✅ 国内可访问

**步骤**：

1. 访问 https://pages.cloudflare.com
2. 用 GitHub 账号登录
3. 点击 **"Create a project"**
4. 选择仓库
5. 配置：
   - Framework preset：`Vite`
   - Build command：`npm run build`
   - Build output directory：`dist`
6. 点击 **"Save and Deploy"**

---

## 五、域名绑定（可选）

如果你有自己的域名（如 `stock.example.com`）：

### GitHub Pages 绑定域名

1. 在仓库 Settings → Pages → Custom domain 填入域名
2. 在域名服务商添加 DNS 记录：

```
类型: CNAME
名称: stock（或 @）
值: jkwell.github.io
```

3. 等待 DNS 生效（几分钟到几小时）
4. GitHub 会自动签发 HTTPS 证书

### Vercel/Netlify 绑定域名

在平台设置里直接添加域名，会给你提供 DNS 配置指引。

---

## 六、移动端优化检查清单

你的项目已经做了以下优化：

- ✅ **PWA 支持**：manifest.webmanifest + Service Worker
- ✅ **响应式布局**：viewport meta 标签设置正确
- ✅ **触摸友好**：禁用双击缩放（user-scalable=no）
- ✅ **图标齐全**：192x192 和 512x512 图标
- ✅ **主题色**：#1971c2（蓝色）
- ✅ **离线缓存**：静态资源缓存，数据接口实时
- ✅ **iOS 优化**：apple-mobile-web-app-capable + apple-touch-icon

**建议补充**：

1. **添加启动画面（Splash Screen）**

在 `public/manifest.webmanifest` 补充：

```json
{
  "icons": [
    {
      "src": "icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "maskable"
    }
  ]
}
```

2. **移动端性能优化**

- 懒加载图表组件（ECharts）
- 虚拟滚动大列表
- 图片压缩和 WebP 格式

3. **安装提示横幅**

当用户第二次访问时，提示"添加到主屏幕"。

---

## 七、常见问题

### Q1：为什么手机访问显示"无法连接"？

**A**：检查以下几点：

1. 手机和电脑必须在同一 WiFi
2. 电脑防火墙可能阻止了 5173 端口
3. Windows 需要在 "Windows Defender 防火墙" 允许 Node.js

**解决方法**（Windows）：

```bash
# 管理员权限运行 PowerShell
netsh advfirewall firewall add rule name="Vite Dev Server" dir=in action=allow protocol=TCP localport=5173
```

### Q2：iOS 添加到主屏幕后，点击还是跳转 Safari？

**A**：检查 `index.html` 是否有：

```html
<meta name="apple-mobile-web-app-capable" content="yes" />
```

### Q3：Android 浏览器没有"添加到主屏幕"选项？

**A**：

- Chrome 需要满足 PWA 标准（manifest + HTTPS）
- 部分国产浏览器不支持 PWA，换用 Chrome
- 本地开发时，Chrome 允许 localhost 不用 HTTPS

### Q4：部署后图标不显示？

**A**：检查 `vite.config.ts` 的 `base` 配置：

```ts
export default defineConfig({
  base: './', // 相对路径，适配 GitHub Pages
})
```

### Q5：Service Worker 更新了但没生效？

**A**：

```bash
# 浏览器清除缓存：
# Chrome: 设置 → 隐私和安全 → 清除浏览数据 → 缓存的图片和文件

# 或者修改 sw.js 的 CACHE_NAME 版本号：
const CACHE_NAME = 'stock-selector-v3' // 改成 v3
```

---

## 八、性能测试

### 使用 Lighthouse 测试移动端性能

1. Chrome 打开你的部署地址
2. 按 F12 打开开发者工具
3. 切换到 **Lighthouse** 标签
4. 选择 **Mobile** 模式
5. 点击 **"Analyze page load"**

**目标分数**：
- Performance: >90
- Accessibility: >90
- Best Practices: >90
- SEO: >80
- PWA: 满分

---

## 九、总结

**推荐方式**：

1. **线上使用**：直接访问 https://jkwell.github.io/gu-stock-selector/，添加到主屏幕
2. **本地测试**：`npm run dev`，手机浏览器访问 `http://电脑IP:5173`
3. **快速部署**：Vercel（国内访问快，自动部署）

**一句话**：你的项目已经完美支持手机端，现在就可以用了！📱
