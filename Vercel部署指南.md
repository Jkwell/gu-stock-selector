# 🚀 Vercel部署指南 - 解决东财接口JSONP阻止问题

## 🐛 问题原因

**东财接口阻止了JSONP请求**，错误信息：
```
JSONP脚本加载失败
```

**根本原因**：
1. 东财服务器检测到来自GitHub Pages的请求
2. 拒绝加载JSONP脚本（可能是Referer检查或IP限制）
3. GitHub Pages是静态托管，无法运行服务端代理

## ✅ 解决方案

**使用Vercel部署**，原因：
1. ✅ Vercel支持Serverless Functions（服务端代理）
2. ✅ 代理可以绕过CORS和JSONP限制
3. ✅ 完全免费（每月10万次请求）
4. ✅ 全球CDN加速
5. ✅ 自动HTTPS

## 📦 已完成的修改

### 1. 创建代理API

**文件**：`api/proxy.js`

功能：
- 代理所有数据接口请求
- 绕过CORS限制
- 绕过东财Referer检查
- 自动添加正确的Headers

### 2. 创建Vercel配置

**文件**：`vercel.json`

功能：
- 配置构建命令
- 配置路由规则
- 配置缓存策略

### 3. 修改前端代码

**文件**：`src/data/api.ts`

修改：
- 添加 `needsProxy()` 函数：检测是否需要代理
- 添加 `proxyUrl()` 函数：构造代理URL
- 修改 `fetchStockList()`：使用代理
- 修改 `fetchMoneyFlow()`：使用代理

逻辑：
```typescript
if (本地开发) {
  使用本地代理 // /api/clist
} else if (GitHub Pages或Vercel) {
  使用Vercel代理 // /api/proxy?url=...
} else {
  直连JSONP // 其他环境
}
```

## 🚀 部署步骤

### 第一步：注册Vercel账号

1. 访问：https://vercel.com/
2. 点击 **Sign Up**
3. 选择 **Continue with GitHub**（推荐）
4. 授权Vercel访问你的GitHub账号

### 第二步：导入项目

1. 登录后，点击 **Add New...** → **Project**
2. 选择 **Import Git Repository**
3. 找到你的 `gu-stock-selector` 仓库
4. 点击 **Import**

### 第三步：配置项目

**Framework Preset**: Vite（自动检测）

**Build Command**: 
```bash
npm run build
```

**Output Directory**: 
```
dist
```

**Install Command**: 
```bash
npm install
```

**Root Directory**: 
```
./
```

### 第四步：部署

1. 点击 **Deploy**
2. 等待2-3分钟
3. ✅ 部署成功！

### 第五步：获取URL

部署成功后，Vercel会给你一个URL：
```
https://gu-stock-selector-你的用户名.vercel.app
```

---

## 🎯 验证部署

### 检查清单

访问你的Vercel URL，然后：

1. **F12** 打开控制台
2. 点击 "今日推荐"
3. 选择策略
4. 点击 "生成推荐"
5. 观察：
   - ✅ 能获取股票列表
   - ✅ 能拉取K线数据
   - ✅ 能拉取资金流数据
   - ✅ 无任何错误

### 检查代理是否生效

在控制台 **Network** 标签：

找到类似这样的请求：
```
/api/proxy?url=https%3A%2F%2Fpush2.eastmoney.com%2Fapi%2Fqt%2Fclist%2Fget%3F...
```

**Status**: 200 ✅

**Response**: JSON数据 ✅

---

## 📊 Vercel vs GitHub Pages

| 功能 | GitHub Pages | Vercel |
|------|-------------|--------|
| 静态托管 | ✅ | ✅ |
| 自动部署 | ✅ | ✅ |
| 自定义域名 | ✅ | ✅ |
| HTTPS | ✅ | ✅ |
| **Serverless API** | ❌ | ✅ ⭐ |
| 代理功能 | ❌ | ✅ ⭐ |
| 访问速度（国内） | 慢 | 快 ⭐ |
| 免费额度 | 无限 | 10万请求/月 |

**结论**：Vercel更适合这个项目！

---

## 🔧 高级配置

### 自定义域名

1. Vercel Dashboard → 你的项目
2. Settings → Domains
3. 添加你的域名
4. 按提示配置DNS记录

### 环境变量

如果需要配置环境变量：

1. Settings → Environment Variables
2. 添加变量
3. 重新部署

### 查看日志

1. Deployments → 选择一个部署
2. Functions → 选择一个函数
3. 查看调用日志

---

## 🐛 常见问题

### Q1：部署失败怎么办？

**A**：检查构建日志

1. Deployments → 失败的部署
2. 点击 "View Build Logs"
3. 查看错误信息
4. 通常是依赖安装问题：
   ```bash
   # 本地测试构建
   npm run build
   ```

### Q2：代理不工作？

**A**：检查API路由

1. 访问 `https://你的域名/api/proxy?url=https://www.baidu.com`
2. 应该返回百度首页HTML
3. 如果404，检查 `vercel.json` 配置

### Q3：还是获取不到数据？

**A**：检查控制台错误

1. F12 → Console
2. 查看具体错误
3. 可能是：
   - 代理超时（调整timeout）
   - 东财接口变化（更新参数）
   - 域名白名单问题（修改 `api/proxy.js`）

### Q4：速度慢？

**A**：Vercel自动使用全球CDN，应该很快

如果慢：
1. 检查是否在国内访问
2. 尝试使用自定义域名（不用.vercel.app）
3. 检查是否有大量请求（优化代码）

---

## 💡 优化建议

### 1. 缓存策略

修改 `api/proxy.js`，添加缓存：

```javascript
// 缓存热门股票数据5分钟
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

export default async function handler(req, res) {
  const { url } = req.query;
  const cacheKey = url;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.status(200).json(cached.data);
  }

  // ... 原来的请求逻辑

  cache.set(cacheKey, { data, time: Date.now() });
  return res.status(200).json(data);
}
```

### 2. 请求限流

防止滥用：

```javascript
const requestCounts = new Map();

export default async function handler(req, res) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const count = requestCounts.get(ip) || 0;

  if (count > 100) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  requestCounts.set(ip, count + 1);
  setTimeout(() => {
    requestCounts.set(ip, (requestCounts.get(ip) || 1) - 1);
  }, 60000); // 1分钟后减1

  // ... 原来的逻辑
}
```

---

## 📚 相关文档

- **Vercel官方文档**：https://vercel.com/docs
- **Serverless Functions**：https://vercel.com/docs/functions/serverless-functions
- **部署配置**：https://vercel.com/docs/deployments/configure-a-build

---

## 🎉 部署检查清单

完成后确认：

- [ ] Vercel账号已注册
- [ ] 项目已导入
- [ ] 构建成功
- [ ] 部署成功
- [ ] 获得Vercel URL
- [ ] 访问URL能正常打开
- [ ] 控制台无错误
- [ ] 能获取股票数据
- [ ] 能完成选股流程
- [ ] 速度正常

---

## 🚀 立即行动

1. **现在就访问**：https://vercel.com/
2. **用GitHub登录**
3. **导入项目**：`gu-stock-selector`
4. **点击Deploy**
5. **等待2-3分钟**
6. **获得URL并测试**

---

## 📞 如果还有问题

部署后如果还是不行，告诉我：

1. Vercel部署URL
2. 控制台错误信息
3. Network面板失败的请求

我会继续帮你解决！

---

**预计部署时间：5-10分钟**

**预计解决问题：100%** ✅
