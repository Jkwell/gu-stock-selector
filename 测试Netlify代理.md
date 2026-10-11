# 🔍 测试Netlify代理函数

## 第一步：直接测试代理函数

在浏览器地址栏访问：

```
https://dashing-manatee-f1873f.netlify.app/.netlify/functions/proxy?url=https://www.baidu.com
```

**预期结果**：
- ✅ 应该返回百度的HTML
- ❌ 如果404：函数没部署成功
- ❌ 如果500：函数代码有错误

**实际结果是什么？**

---

## 第二步：在控制台测试

访问你的网站，F12控制台，运行：

```javascript
fetch('/.netlify/functions/proxy?url=' + encodeURIComponent('https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=10&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6&fields=f12,f14&ut=bd1d9ddb04089700cf9c27f6f7426281'))
  .then(r => {
    console.log('Status:', r.status);
    return r.text();
  })
  .then(t => {
    console.log('Response:', t);
    try {
      const data = JSON.parse(t);
      console.log('✅ 成功！股票数:', data.data?.total);
    } catch (e) {
      console.log('❌ 不是JSON:', t.slice(0, 200));
    }
  })
  .catch(e => {
    console.error('❌ 错误:', e);
  });
```

**运行后，复制所有输出给我！**

---

## 第三步：查看Functions日志

1. 登录 Netlify Dashboard
2. 选择你的网站
3. 点击 **Functions** 标签
4. 点击 **proxy** 函数
5. 查看 **Function log**

**复制最近的日志内容！**

特别注意是否有这些错误：
- `fetch is not defined`
- `URL is not defined`
- `Cannot find module`
- 其他错误信息

---

## 常见问题

### 问题1：fetch is not defined

**原因**：Netlify Functions的Node.js版本太老

**解决**：在 `netlify.toml` 添加：
```toml
[functions]
  node_bundler = "esbuild"
```

### 问题2：代理返回空或错误

**原因**：上游接口被Netlify的IP封禁

**解决**：需要其他方案（CloudFlare Worker）

### 问题3：超时

**原因**：Netlify Functions默认10秒超时

**解决**：优化代码或升级套餐

---

## 请提供

1. **直接访问代理的结果**（浏览器地址栏）
2. **控制台测试的输出**（完整复制）
3. **Functions日志**（如果能看到）
