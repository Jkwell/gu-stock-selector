#!/bin/bash

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📱 手机端开发服务器"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# 获取本机IP
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS
    IP=$(ipconfig getifaddr en0 || ipconfig getifaddr en1)
else
    # Linux
    IP=$(hostname -I | awk '{print $1}')
fi

echo "✅ 服务器启动中..."
echo ""
echo "🖥️  电脑访问: http://localhost:5173"
echo "📱 手机访问: http://$IP:5173"
echo ""
echo "💡 提示:"
echo "  1. 确保手机和电脑在同一WiFi下"
echo "  2. 手机浏览器输入上面的地址"
echo "  3. 按 Ctrl+C 停止服务器"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

npm run dev
