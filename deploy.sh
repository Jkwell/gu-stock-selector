#!/bin/bash
set -e

echo "🔨 Building project..."
npm run build

echo "📦 Deploying to GitHub Pages..."

# 备份 dist
BACKUP_DIR="../gu-dist-$(date +%s)"
cp -r dist "$BACKUP_DIR"

# 切换到 gh-pages
git checkout gh-pages

# 清空并复制新内容
git rm -rf . 2>/dev/null || true
cp -r "$BACKUP_DIR"/* .

# 提交并推送
git add -A
git commit -m "Deploy: $(date '+%Y-%m-%d %H:%M:%S')"
git push origin gh-pages --force

echo "✅ Deployed successfully!"
echo "🌐 https://jkwell.github.io/gu-stock-selector/"

# 切回 main
git checkout main

# 清理
rm -rf "$BACKUP_DIR"

echo "🎉 Done!"
