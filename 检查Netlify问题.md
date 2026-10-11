# 🔍 Netlify部署检查清单

## 第一步：确认部署成功

访问你的Netlify URL，按F12打开控制台

### 检查点1：页面是否正常打开？
- [ ] 页面能打开
- [ ] 样式正常
- [ ] 没有404错误

### 检查点2：控制台有什么错误？
```
F12 → Console标签
复制所有红色错误信息
```

### 检查点3：Network请求情况
```
F12 → Network标签
点击"今日推荐" → "生成推荐"
看哪些请求失败了（红色）
```

---

## 第二步：检查代理是否工作

在Network标签，找到类似的请求：

```
/.netlify/functions/proxy?url=...
```

**点击这个请求，查看：**

### Status（状态码）
- [ ] 200 - 成功 ✅
- [ ] 404 - 找不到函数 ❌
- [ ] 500 - 函数内部错误 ❌
- [ ] 其他？

### Response（返回内容）
```
点击Response标签
复制返回的内容
```

### Headers（请求头）
```
检查是否有CORS错误
```

---

## 第三步：测试代理函数

直接在浏览器访问：

```
https://你的域名.netlify.app/.netlify/functions/proxy?url=https://www.baidu.com
```

**应该返回：**
- ✅ 百度的HTML
- ❌ 如果返回404/500，说明函数有问题

---

## 第四步：检查Functions日志

在Netlify Dashboard：

1. 点击你的网站
2. 点击 **"Functions"** 标签
3. 点击 **"proxy"** 函数
4. 查看 **"Function log"**

**复制最近的日志内容**

---

## 常见问题诊断

### 问题A：404 - Function not found

**原因：** Functions没有正确部署

**检查：**
1. Netlify Dashboard → Functions 标签
2. 看是否有 `proxy` 函数

**解决：**
- 确认 `netlify.toml` 中 `functions = "netlify/functions"`
- 重新部署

### 问题B：500 - Internal Server Error

**原因：** 函数代码有错误

**检查：**
- Functions → proxy → Function log
- 看具体错误信息

**可能原因：**
1. 代码语法错误
2. fetch API不可用
3. URL解析失败

### 问题C：CORS错误

**原因：** 代理函数返回的Headers不对

**检查：**
- Network → proxy请求 → Response Headers
- 看是否有 `Access-Control-Allow-Origin`

### 问题D：请求超时

**原因：** 
1. 冷启动（首次访问慢）
2. 上游接口慢
3. Netlify Functions限制

**解决：**
- 多刷新几次
- 等待30秒
- 检查上游接口是否可用

---

## 请告诉我

1. **Netlify URL是什么？**
   ```
   https://???.netlify.app
   ```

2. **控制台的错误信息？**
   ```
   复制粘贴所有红色错误
   ```

3. **/.netlify/functions/proxy 的Status？**
   - [ ] 200
   - [ ] 404
   - [ ] 500
   - [ ] 其他：____

4. **直接访问代理函数的结果？**
   ```
   访问：https://你的域名/.netlify/functions/proxy?url=https://www.baidu.com
   返回什么？
   ```

5. **Functions日志显示什么？**
   ```
   复制Function log的内容
   ```

---

## 快速测试代码

在控制台运行这段代码测试代理：

```javascript
// 在你的Netlify网站控制台运行
fetch('/.netlify/functions/proxy?url=' + encodeURIComponent('https://www.baidu.com'))
  .then(r => r.text())
  .then(t => {
    console.log('✅ 代理工作！返回长度:', t.length);
  })
  .catch(e => {
    console.error('❌ 代理失败:', e.message);
  });
```

**运行后告诉我结果！**
