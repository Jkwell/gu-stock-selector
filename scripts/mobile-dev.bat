@echo off
chcp 65001 >nul
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo 📱 手机端开发服务器
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

REM 获取本机IP
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
    set IP=%%a
    goto :found
)
:found
set IP=%IP:~1%

echo ✅ 服务器启动中...
echo.
echo 🖥️  电脑访问: http://localhost:5173
echo 📱 手机访问: http://%IP%:5173
echo.
echo 💡 提示:
echo   1. 确保手机和电脑在同一WiFi下
echo   2. 手机浏览器输入上面的地址
echo   3. 按 Ctrl+C 停止服务器
echo.
echo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo.

npm run dev
