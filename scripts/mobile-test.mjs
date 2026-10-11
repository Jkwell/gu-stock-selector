#!/usr/bin/env node
/**
 * 手机端测试脚本
 *
 * 功能：
 * 1. 检测当前电脑的局域网IP
 * 2. 生成手机访问的二维码
 * 3. 启动开发服务器
 */

import { createServer } from 'vite'
import { networkInterfaces } from 'os'
import QRCode from 'qrcode-terminal'

// 获取本机局域网IP
function getLocalIP() {
  const nets = networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // 跳过非IPv4和内部地址
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return 'localhost'
}

async function main() {
  const ip = getLocalIP()
  const port = 5173
  const url = `http://${ip}:${port}`

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
  console.log('📱 手机端测试服务器启动中...')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')

  // 启动Vite开发服务器
  const server = await createServer({
    server: {
      host: '0.0.0.0',
      port,
      strictPort: true,
    },
  })

  await server.listen()

  console.log('✅ 服务器已启动！\n')
  console.log(`🖥️  电脑访问：http://localhost:${port}`)
  console.log(`📱 手机访问：${url}\n`)

  console.log('📷 手机扫描二维码直接访问：\n')
  QRCode.generate(url, { small: true })

  console.log('\n💡 提示：')
  console.log('  1. 确保手机和电脑在同一WiFi下')
  console.log('  2. 如果手机无法访问，检查防火墙设置')
  console.log('  3. Windows用户可能需要允许Node.js通过防火墙\n')
  console.log('按 Ctrl+C 停止服务器\n')
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n')
}

main().catch(console.error)
