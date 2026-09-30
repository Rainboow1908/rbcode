# 构建 RB Code 本机执行器并打出 Windows 安装程序。
#
#   powershell -ExecutionPolicy Bypass -File companion\build.ps1
#
# 实际就是 tauri build：它先让 vite 把窗口界面打包成静态文件，再编译 Rust 外壳，
# 最后调 NSIS 生成安装程序（按用户安装，不需要管理员权限）。
#
# 产物：
#   companion\src-tauri\target\release\rbcode-companion.exe
#   companion\src-tauri\target\release\bundle\nsis\RB Code Companion_0.1.0_x64-setup.exe

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot

# 构建缓存尽量放 D 盘，避免把系统盘塞满（没有这些目录就用默认位置）
if (Test-Path 'D:\cargo-home') { $env:CARGO_HOME = 'D:\cargo-home' }
if (Test-Path 'D:\tmp') {
  $env:TEMP = 'D:\tmp'
  $env:TMP = 'D:\tmp'
}

Push-Location $root

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host '==> 安装窗口界面依赖' -ForegroundColor Cyan
  npm install
}

Write-Host '==> 构建并打包（tauri build）' -ForegroundColor Cyan
npm run tauri:build

Pop-Location

Write-Host ''
Write-Host '完成。安装程序在 companion\src-tauri\target\release\bundle\nsis\' -ForegroundColor Green
