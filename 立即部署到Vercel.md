# 🚀 立即部署到Vercel - 5分钟搞定

## ✅ 代码已准备好

我已经帮你完成了所有代码修改：

1. ✅ **api/proxy.js** - Serverless代理（线上版的proxy/index.mjs）
2. ✅ **vercel.json** - Vercel配置
3. ✅ **src/data/api.ts** - 自动使用代理
4. ✅ **src/config/factors.ts** - 性能优化
5. ✅ **代码已提交** - commit: 23f55a8

**下一步：推送到GitHub + 部署到Vercel**

---

## 第一步：推送代码到GitHub

打开Git Bash或命令行，运行：

```bash
git push origin main
```

如果提示需要登录，输入你的GitHub用户名和密码（或Personal Access Token）。

**可能的问题：**

如果遇到网络问题（连接失败），可以：
1. 检查网络连接
2. 或者使用GitHub Desktop推送
3. 或者等网络好了再推送

---

## 第二步：访问Vercel

打开浏览器，访问：

```
https://vercel.com
```

---

## 第三步：登录Vercel

1. 点击右上角 **"Sign Up"** 或 **"Login"**
2. 选择 **"Continue with GitHub"**
3. 授权Vercel访问你的GitHub账号
4. ✅ 登录成功！

---

## 第四步：导入项目

### 4.1 点击 "Add New..."

在Vercel Dashboard，点击右上角：

```
Add New... → Project
```

### 4.2 选择仓库

找到你的仓库：

```
gu-stock-selector
```

如果看不到，点击：
```
Adjust GitHub App Permissions → Select repositories → 选择 gu-stock-selector
```

### 4.3 点击 "Import"

点击仓库右边的 **"Import"** 按钮

---

## 第五步：配置项目

Vercel会自动检测到这是一个Vite项目，配置应该已经自动填好：

### 检查配置（一般不需要改）

**Framework Preset**: 
```
Vite
```

**Root Directory**: 
```
./
```

**Build Command**: 
```
npm run build
```

**Output Directory**: 
```
dist
```

**Install Command**: 
```
npm install
```

### ⚠️ 如果配置不对，手动填写上面的值

---

## 第六步：部署！

点击底部的蓝色按钮：

```
Deploy
```

---

## 第七步：等待部署（2-3分钟）

你会看到：

1. **Building** - 正在构建（约1-2分钟）
   - Installing dependencies...
   - Building...
   - ✓ Build completed

2. **Deploying** - 正在部署（约30秒）
   - Uploading files...
   - ✓ Deployed

3. **Ready** - 部署成功！🎉

---

## 第八步：获取URL并访问

部署成功后，Vercel会显示：

```
🎉 Congratulations!

Your project is live at:
https://gu-stock-selector.vercel.app

或
https://gu-stock-selector-你的用户名.vercel.app
```

**点击这个URL**，打开你的网站！

---

## 第九步：验证功能

### 9.1 打开控制台

访问你的Vercel URL后，按 **F12** 打开控制台

### 9.2 测试选股

1. 点击 **"今日推荐"**
2. 选择策略（如"缩量蓄势突破"）
3. 点击 **"生成推荐"**
4. 观察进度：
   - 获取股票列表...
   - 拉取K线...
   - 拉取资金流...
   - 打分中...

### 9.3 检查结果

**成功的标志**：
- ✅ 能获取股票列表
- ✅ 能拉取K线数据
- ✅ 能拉取资金流数据
- ✅ 最终显示推荐的股票
- ✅ 控制台无红色错误

### 9.4 检查代理

在 **Network** 标签：

找到类似的请求：
```
/api/proxy?url=https%3A%2F%2Fpush2.eastmoney.com...
```

**Status**: 200 ✅

这说明代理正常工作！

---

## 🎉 完成！

现在你有两个地址：

1. **Vercel**（推荐）：
   ```
   https://gu-stock-selector.vercel.app
   ```
   - ✅ 有代理，能获取数据
   - ✅ 速度快
   - ✅ 自动部署

2. **GitHub Pages**（备用）：
   ```
   https://jkwell.github.io/gu-stock-selector/
   ```
   - ❌ 没有代理，无法获取数据
   - 仅作为静态展示

**以后就用Vercel地址！**

---

## 📱 添加到手机主屏幕

访问Vercel地址：

**iOS**：
1. Safari打开
2. 点击"分享"
3. "添加到主屏幕"

**Android**：
1. Chrome打开
2. 点击"⋮"
3. "添加到主屏幕"

---

## 🔄 以后如何更新

### 自动部署（推荐）

以后只需要：

```bash
git add .
git commit -m "更新说明"
git push origin main
```

Vercel会**自动检测**并重新部署，约2分钟后生效！

### 手动重新部署

如果需要手动重新部署：

1. 登录 Vercel Dashboard
2. 选择项目
3. 点击 **Deployments**
4. 点击最新部署右边的 **"⋯"**
5. 选择 **"Redeploy"**

---

## 🔧 查看部署日志

如果部署失败：

1. Vercel Dashboard → 你的项目
2. 点击 **Deployments**
3. 点击失败的部署
4. 查看 **"Build Logs"**
5. 复制错误信息给我

---

## 🌐 自定义域名（可选）

如果你有自己的域名：

1. Vercel Dashboard → 你的项目
2. **Settings** → **Domains**
3. 点击 **"Add"**
4. 输入你的域名（如 `stock.yourdomain.com`）
5. 按提示配置DNS：
   ```
   Type: CNAME
   Name: stock
   Value: cname.vercel-dns.com
   ```
6. 等待DNS生效（几分钟到几小时）

---

## ❓ 常见问题

### Q1: 部署失败，显示构建错误

**A**: 查看Build Logs，通常是：

1. **依赖安装失败**：
   ```bash
   # 本地测试
   rm -rf node_modules package-lock.json
   npm install
   npm run build
   ```

2. **TypeScript错误**：
   - 检查代码是否有编译错误
   - 本地运行 `npm run build` 看具体错误

### Q2: 部署成功但还是获取不到数据

**A**: 检查：

1. **控制台错误**：F12 → Console，看是什么错误
2. **Network请求**：F12 → Network，看 `/api/proxy` 的Status
3. **如果是404**：说明路由配置有问题，检查 `vercel.json`
4. **如果是500**：说明代理函数有错误，查看Function Logs

### Q3: 部署后访问很慢

**A**: 

1. Vercel自动使用全球CDN，应该很快
2. 如果慢，可能是：
   - 首次访问（冷启动）
   - 网络问题
   - 尝试刷新

### Q4: GitHub推送失败

**A**: 

1. **网络问题**：
   - 检查网络连接
   - 或使用GitHub Desktop

2. **认证问题**：
   - 需要Personal Access Token
   - GitHub Settings → Developer settings → Personal access tokens → Generate new token

3. **代理问题**：
   ```bash
   # 如果有代理
   git config --global http.proxy http://127.0.0.1:代理端口
   
   # 取消代理
   git config --global --unset http.proxy
   ```

---

## 📊 完成检查清单

部署完成后，确认：

- [ ] 代码已推送到GitHub
- [ ] Vercel账号已注册
- [ ] 项目已导入到Vercel
- [ ] 部署成功（显示绿色的Ready）
- [ ] 获得Vercel URL
- [ ] 访问URL能打开页面
- [ ] F12无红色错误
- [ ] "今日推荐"功能正常
- [ ] 能获取股票数据
- [ ] Network看到 `/api/proxy` 请求成功

---

## 🎯 下一步

部署成功后：

1. **分享链接**：把Vercel URL分享给需要的人
2. **添加到主屏幕**：手机上添加，像App一样使用
3. **继续开发**：推送代码，Vercel自动部署

---

## 💡 小贴士

1. **自动部署很方便**：推送代码就自动上线，不需要手动构建
2. **分支部署**：每个分支都有独立的预览URL
3. **回滚很简单**：在Deployments里点击旧版本，一键回滚
4. **免费额度够用**：每月10万次请求，个人使用绰绰有余

---

## 📞 需要帮助

如果遇到任何问题，告诉我：

1. 哪一步卡住了？
2. 错误信息是什么？
3. 截图发给我

我会继续帮你！

---

**现在开始吧！** 🚀

第一步：推送代码
```bash
git push origin main
```

第二步：访问 https://vercel.com

第三步：Import项目，点Deploy

**预计时间：5-10分钟**

**成功率：99%** ✅
