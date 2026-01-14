/**
 * Kiro-Cloud-Auth  - 集群模式启动
 * 充分利用多核 CPU，提高并发处理能力
 */
import cluster from 'cluster'
import os from 'os'

// 获取 CPU 核心数，默认使用全部核心，可通过环境变量限制
const numCPUs = parseInt(process.env.CLUSTER_WORKERS) || os.cpus().length

// 优雅关闭超时时间（毫秒）
const GRACEFUL_SHUTDOWN_TIMEOUT = 15000

if (cluster.isPrimary) {
  console.log(`[Cluster] Primary ${process.pid} is running`)
  console.log(`[Cluster] Starting ${numCPUs} workers...`)

  let restartCount = 0
  let isShuttingDown = false

  // Fork workers，只有第一个 Worker 启用 Token 刷新
  for (let i = 0; i < numCPUs; i++) {
    const env = { WORKER_INDEX: i }
    // 只有 Worker 0 启用 Token 刷新，其他 Worker 禁用
    if (i > 0) {
      env.DISABLE_TOKEN_REFRESH = 'true'
    } else {
      env.DISABLE_TOKEN_REFRESH = 'false'
    }
    cluster.fork(env)
  }

  cluster.on('exit', (worker, code, signal) => {
    // 如果正在关闭，不重启 worker
    if (isShuttingDown) {
      console.log(`[Cluster] Worker ${worker.process.pid} exited during shutdown`)
      // 检查是否所有 worker 都已退出
      const activeWorkers = Object.keys(cluster.workers).length
      if (activeWorkers === 0) {
        console.log('[Cluster] All workers exited, primary exiting...')
        process.exit(0)
      }
      return
    }

    console.log(`[Cluster] Worker ${worker.process.pid} died (${signal || code}). Restarting...`)
    // 重启的 Worker 用 r+序号 标识，禁用 Token 刷新
    cluster.fork({ WORKER_INDEX: `r${restartCount++}`, DISABLE_TOKEN_REFRESH: 'true' })
  })

  cluster.on('online', (worker) => {
    console.log(`[Cluster] Worker ${worker.process.pid} is online`)
  })

  // 优雅关闭函数
  const gracefulShutdown = (signal) => {
    if (isShuttingDown) {
      console.log(`[Cluster] Already shutting down, ignoring ${signal}`)
      return
    }
    isShuttingDown = true
    console.log(`[Cluster] ${signal} received, initiating graceful shutdown...`)

    // 向所有 worker 发送 SIGTERM
    for (const id in cluster.workers) {
      const worker = cluster.workers[id]
      if (worker) {
        console.log(`[Cluster] Sending SIGTERM to worker ${worker.process.pid}`)
        worker.process.kill('SIGTERM')
      }
    }

    // 设置超时强制退出
    setTimeout(() => {
      console.log(
        `[Cluster] Graceful shutdown timeout (${GRACEFUL_SHUTDOWN_TIMEOUT}ms), forcing exit...`
      )
      for (const id in cluster.workers) {
        const worker = cluster.workers[id]
        if (worker) {
          worker.process.kill('SIGKILL')
        }
      }
      process.exit(1)
    }, GRACEFUL_SHUTDOWN_TIMEOUT)
  }

  // 注册信号处理
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
  process.on('SIGINT', () => gracefulShutdown('SIGINT'))
} else {
  // Worker 进程运行实际的服务器
  import('./index.js')
}
