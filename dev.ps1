# Kiro-Cloud-Auth  - Development Environment Script (Windows)
# Usage: .\dev.ps1 [command]
# Commands: start, stop, logs, status, clean

param([string]$Command = "start")

$ErrorActionPreference = "Stop"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Kiro-Cloud-Auth  - Dev Environment" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

function Test-Docker {
    try {
        docker info 2>&1 | Out-Null
        return $true
    } catch {
        Write-Host "[ERROR] Docker is not running!" -ForegroundColor Red
        Write-Host "Please start Docker Desktop first." -ForegroundColor Yellow
        return $false
    }
}

function Clear-TestEnvironment {
    Write-Host "[CLEAN] Cleaning up..." -ForegroundColor Yellow
    $containers = docker ps -aq --filter "name=kiro" 2>$null
    if ($containers) {
        docker stop $containers 2>$null | Out-Null
        docker rm $containers 2>$null | Out-Null
    }
    $danglingImages = docker images -f "dangling=true" -q 2>$null
    if ($danglingImages) {
        docker rmi $danglingImages 2>$null | Out-Null
    }
    Write-Host "[OK] Cleaned" -ForegroundColor Green
}

function Wait-ForBackend {
    Write-Host "[WAIT] Waiting for backend to be ready..." -ForegroundColor Yellow
    $maxRetries = 30
    $retry = 0

    while ($retry -lt $maxRetries) {
        try {
            $response = Invoke-WebRequest -Uri "http://localhost:25000/api/health" -UseBasicParsing -TimeoutSec 2 -ErrorAction SilentlyContinue
            if ($response.StatusCode -eq 200) {
                Write-Host "[OK] Backend is ready!" -ForegroundColor Green
                return $true
            }
        } catch {
            # 继续等待
        }
        $retry++
        Write-Host "  Waiting... ($retry/$maxRetries)" -ForegroundColor Gray
        Start-Sleep -Seconds 2
    }

    Write-Host "[WARN] Backend not responding, continuing anyway..." -ForegroundColor Yellow
    return $false
}

function Start-Dev {
    Write-Host "[START] Starting development environment..." -ForegroundColor Yellow

    # 检查 .env.dev 文件
    if (!(Test-Path ".env.dev")) {
        Write-Host "[WARN] .env.dev not found, copying from .env.example..." -ForegroundColor Yellow
        if (Test-Path ".env.example") {
            Copy-Item ".env.example" ".env.dev"
            Write-Host "[INFO] Please edit .env.dev with your database credentials" -ForegroundColor Cyan
        } else {
            Write-Host "[ERROR] .env.example not found!" -ForegroundColor Red
            exit 1
        }
    }

    # 1. 清理旧环境
    Clear-TestEnvironment

    # 2. 启动 Docker 后端
    Write-Host ""
    Write-Host "[DOCKER] Building and starting backend..." -ForegroundColor Yellow
    docker-compose up -d --build

    # 3. 等待后端就绪
    Wait-ForBackend

    # 4. 启动 Electron 客户端
    Write-Host ""
    Write-Host "[ELECTRON] Starting Electron client..." -ForegroundColor Yellow
    $env:ELECTRON_WEB_SERVER_URL = "http://localhost:25000"
    pnpm run dev

    Write-Host ""
    Write-Host "[OK] Development environment started!" -ForegroundColor Green
}

function Stop-Dev {
    Write-Host "[STOP] Stopping development environment..." -ForegroundColor Yellow
    docker-compose down
    Write-Host "[OK] Stopped!" -ForegroundColor Green
}

function Show-Logs {
    docker-compose logs -f
}

function Show-Status {
    Write-Host "[STATUS] Container status:" -ForegroundColor Yellow
    Write-Host ""
    docker-compose ps
    Write-Host ""

    try {
        $response = Invoke-WebRequest -Uri "http://localhost:25000/api/health" -UseBasicParsing -TimeoutSec 5
        $health = $response.Content | ConvertFrom-Json
        Write-Host "[HEALTH] Service is healthy" -ForegroundColor Green
        Write-Host "  Server ID: $($health.serverId)" -ForegroundColor White
        Write-Host "  Version:   $($health.version)" -ForegroundColor White
        Write-Host "  Database:  $($health.database)" -ForegroundColor White
    } catch {
        Write-Host "[HEALTH] Service is not responding" -ForegroundColor Red
    }
}

function Clean-Dev {
    Write-Host "[CLEAN] Cleaning up Docker resources..." -ForegroundColor Yellow
    docker-compose down -v --rmi local 2>$null
    Clear-TestEnvironment
    $testImages = docker images -q "Kiro-Cloud-Auth*" 2>$null
    if ($testImages) {
        docker rmi $testImages 2>$null | Out-Null
    }
    Write-Host "[OK] Cleaned up!" -ForegroundColor Green
}

# Main
if (!(Test-Docker)) { exit 1 }

Write-Host "Command: $Command" -ForegroundColor Cyan
Write-Host ""

switch ($Command.ToLower()) {
    "start" { Start-Dev }
    "stop" { Stop-Dev }
    "logs" { Show-Logs }
    "status" { Show-Status }
    "clean" { Clean-Dev }
    default {
        Write-Host "Unknown command: $Command" -ForegroundColor Red
        Write-Host "`nAvailable commands:" -ForegroundColor Yellow
        Write-Host "  start  - Start Docker backend + Electron client"
        Write-Host "  stop   - Stop Docker backend"
        Write-Host "  logs   - View Docker logs"
        Write-Host "  status - Show status"
        Write-Host "  clean  - Clean all Docker resources"
        exit 1
    }
}
