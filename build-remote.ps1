# ========================================
# Kiro Cloud - Electron Cloud Build Script
# ========================================
# Product: Kiro Cloud
# ========================================

param(
    [switch]$SkipClean,
    [switch]$KeepTemp,
    [switch]$Portable
)

$ErrorActionPreference = "Stop"
$StartTime = Get-Date

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Kiro Cloud - Electron Cloud Build" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ========================================
# Step 1: Pre-build cleanup
# ========================================
if (-not $SkipClean) {
    Write-Host "[Step 1/5] Cleaning build environment..." -ForegroundColor Green

    # 终止可能占用文件的进程
    Write-Host "  Terminating potential file-locking processes..." -ForegroundColor Gray
    Get-Process | Where-Object { $_.ProcessName -like "*electron*" -or $_.ProcessName -like "*kiro*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500

    $foldersToClean = @(
        "dist",
        "out",
        "release",
        "dist-web",
        ".vite"
    )

    $cleanedCount = 0
    foreach ($folder in $foldersToClean) {
        if (Test-Path $folder) {
            # 尝试多次删除，处理文件占用问题
            $retryCount = 0
            $maxRetries = 3
            $deleted = $false

            while (-not $deleted -and $retryCount -lt $maxRetries) {
                try {
                    Remove-Item -Recurse -Force $folder -ErrorAction Stop
                    $deleted = $true
                    Write-Host "  Removed: $folder" -ForegroundColor Gray
                    $cleanedCount++
                } catch {
                    $retryCount++
                    if ($retryCount -lt $maxRetries) {
                        Write-Host "  Retry removing $folder (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
                        Start-Sleep -Seconds 1
                    } else {
                        Write-Host "  Warning: Could not remove $folder (may be in use)" -ForegroundColor Yellow
                    }
                }
            }
        }
    }

    # Clean node_modules/.cache
    if (Test-Path "node_modules/.cache") {
        Remove-Item -Recurse -Force "node_modules/.cache" -ErrorAction SilentlyContinue
        Write-Host "  Removed: node_modules/.cache" -ForegroundColor Gray
        $cleanedCount++
    }

    if ($cleanedCount -eq 0) {
        Write-Host "  No files to clean" -ForegroundColor Gray
    }
    Write-Host "  Clean completed!" -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "[Step 1/5] Skipping clean (--SkipClean)" -ForegroundColor Yellow
    Write-Host ""
}

# ========================================
# Step 2: Check dependencies
# ========================================
Write-Host "[Step 2/5] Checking dependencies..." -ForegroundColor Green

# Check pnpm
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Host "  ERROR: pnpm not found!" -ForegroundColor Red
    Write-Host "  Please install pnpm: npm install -g pnpm" -ForegroundColor Yellow
    exit 1
}
Write-Host "  pnpm: $(pnpm --version)" -ForegroundColor Gray

# Check node_modules
if (-not (Test-Path "node_modules")) {
    Write-Host "  Installing dependencies..." -ForegroundColor Yellow
    pnpm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Failed to install dependencies!" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  Dependencies: OK" -ForegroundColor Gray
Write-Host ""

# ========================================
# Step 3: Build application
# ========================================
Write-Host "[Step 3/5] Building application..." -ForegroundColor Green
Write-Host "  This may take a few minutes..." -ForegroundColor Gray

# 设置环境变量以避免文件占用问题
$env:ELECTRON_BUILDER_ALLOW_UNRESOLVED_DEPENDENCIES = "true"
$env:USE_HARD_LINKS = "false"

$buildCommand = if ($Portable) { "build:cloud:portable" } else { "build:cloud" }
Write-Host "  Command: pnpm run $buildCommand" -ForegroundColor Gray
Write-Host "  Note: Building with --recompile to avoid file lock issues" -ForegroundColor Gray

# 使用 --dir 先构建到临时目录，然后再打包
pnpm run $buildCommand -- --config.directories.output=release-new

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "Build FAILED!" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    exit 1
}
Write-Host ""

# ========================================
# Step 4: Post-build cleanup
# ========================================
if (-not $KeepTemp) {
    Write-Host "[Step 4/5] Cleaning temporary files..." -ForegroundColor Green

    $tempFolders = @(
        "release/win-unpacked",
        "release/builder-effective-config.yaml",
        "release/__uninstaller-nsis-kiro-cloud.exe",
        "release/__uninstaller-nsis-kiro-cloud-auth.exe"
    )

    $cleanedTemp = 0
    foreach ($item in $tempFolders) {
        if (Test-Path $item) {
            Remove-Item -Recurse -Force $item -ErrorAction SilentlyContinue
            Write-Host "  Removed: $item" -ForegroundColor Gray
            $cleanedTemp++
        }
    }

    if ($cleanedTemp -eq 0) {
        Write-Host "  No temporary files to clean" -ForegroundColor Gray
    }
    Write-Host ""
} else {
    Write-Host "[Step 4/5] Keeping temporary files (--KeepTemp)" -ForegroundColor Yellow
    Write-Host ""
}

# ========================================
# Step 5: Build summary
# ========================================
Write-Host "[Step 5/5] Build summary..." -ForegroundColor Green

$EndTime = Get-Date
$Duration = $EndTime - $StartTime

# 如果使用了新目录，移动文件
if (Test-Path "release-new") {
    if (Test-Path "release") {
        Write-Host "  Removing old release directory..." -ForegroundColor Gray
        Remove-Item -Recurse -Force "release" -ErrorAction SilentlyContinue
    }
    Rename-Item "release-new" "release"
    Write-Host "  Moved build output to release/" -ForegroundColor Gray
}

# Find generated installers
$installers = Get-ChildItem -Path "release" -Filter "*.exe" -ErrorAction SilentlyContinue

if ($installers) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "Build completed successfully!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "Output directory: release/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Generated installers:" -ForegroundColor White

    foreach ($installer in $installers) {
        $sizeMB = [math]::Round($installer.Length / 1MB, 2)
        Write-Host "  - $($installer.Name) ($sizeMB MB)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Build time: $($Duration.Minutes)m $($Duration.Seconds)s" -ForegroundColor Gray
    Write-Host ""

    # Size comparison hint
    $totalSize = ($installers | Measure-Object -Property Length -Sum).Sum / 1MB
    if ($totalSize -lt 100) {
        Write-Host "Size optimization: ~$([math]::Round($totalSize, 0)) MB (vs ~200 MB before)" -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Red
    Write-Host "No installers found in release/" -ForegroundColor Red
    Write-Host "========================================" -ForegroundColor Red
    exit 1
}
