import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  base: './', // 相对路径，适配 GitHub Pages 子路径部署（username.github.io/repo/）
  plugins: [react()],
  server: {
    port: 5173,
    host: true, // 监听所有网卡，手机同一 WiFi 可访问
    proxy: {
      // 开发环境下代理到本地代理服务，解决 CORS
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
})
