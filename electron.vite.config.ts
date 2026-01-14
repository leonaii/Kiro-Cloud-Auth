import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'
import obfuscator from 'vite-plugin-javascript-obfuscator'

export default defineConfig(({ mode }) => {
  // 加载环境变量
  const env = loadEnv(mode, process.cwd(), '')

  // 远程服务器 URL（用于打包指向远程后端的客户端）
  // 从环境变量读取，构建时通过 cross-env 设置
  const remoteServerUrl = process.env.ELECTRON_WEB_SERVER_URL || env.VITE_API_BASE || ''
  
  console.log('[Build] ==================== Build Configuration ====================')
  console.log('[Build] Mode:', mode)
  console.log('[Build] ELECTRON_WEB_SERVER_URL:', remoteServerUrl || '(not set)')
  console.log('[Build] ================================================================')

  return {
    main: {
      plugins: [
        externalizeDepsPlugin(),
        // 生产环境启用代码混淆（温和配置，确保应用可运行）
        mode === 'production' || mode === 'build' ? obfuscator({
          options: {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.5,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.2,
            debugProtection: false,
            debugProtectionInterval: 0,
            disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal',
            log: false,
            numbersToExpressions: false,
            renameGlobals: false,
            selfDefending: false,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 10,
            stringArray: true,
            stringArrayCallsTransform: true,
            stringArrayCallsTransformThreshold: 0.5,
            stringArrayEncoding: ['base64'],
            stringArrayIndexShift: true,
            stringArrayRotate: true,
            stringArrayShuffle: true,
            stringArrayWrappersCount: 1,
            stringArrayWrappersChainedCalls: true,
            stringArrayWrappersParametersMaxCount: 2,
            stringArrayWrappersType: 'function',
            stringArrayThreshold: 0.5,
            transformObjectKeys: false,
            unicodeEscapeSequence: false
          }
        }) : undefined
      ].filter(Boolean),
      define: {
        'process.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE || ''),
        'process.env.ELECTRON_WEB_SERVER_URL': JSON.stringify(remoteServerUrl)
      }
    },
    preload: {
      plugins: [
        externalizeDepsPlugin(),
        // 生产环境启用代码混淆（温和配置，确保应用可运行）
        mode === 'production' || mode === 'build' ? obfuscator({
          options: {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.5,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.2,
            debugProtection: false,
            debugProtectionInterval: 0,
            disableConsoleOutput: false,
            identifierNamesGenerator: 'hexadecimal',
            log: false,
            numbersToExpressions: false,
            renameGlobals: false,
            selfDefending: false,
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 10,
            stringArray: true,
            stringArrayCallsTransform: true,
            stringArrayCallsTransformThreshold: 0.5,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.5,
            transformObjectKeys: false,
            unicodeEscapeSequence: false
          }
        }) : undefined
      ].filter(Boolean)
    },
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src'),
          '@': resolve('src/renderer/src')
        }
      },
      plugins: [react(), tailwindcss()],
      define: {
        'import.meta.env.VITE_API_BASE': JSON.stringify(env.VITE_API_BASE || '')
      },
      server: {
        hmr: {
          // 禁用 HMR 超时后的全页面刷新
          timeout: 60000,
          overlay: false
        }
      }
    }
  }
})
