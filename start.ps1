# start.ps1 - avsync launcher (called by the .cmd next to it)
# ASCII-ONLY source on purpose: non-ASCII bytes in a .ps1 are read with the
# system code page by Windows PowerShell 5.1 unless the file has a BOM, which
# breaks parsing. All Chinese text is written as \uXXXX escapes, which
# PowerShell expands inside double-quoted strings, so it renders correctly
# regardless of the active code page.

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$port = if ($env:PORT) { $env:PORT } else { '8799' }
$url = 'http://127.0.0.1:' + $port + '/'

function Test-Server {
    try {
        $r = Invoke-WebRequest -Uri ($url + 'api/channels') -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

Write-Host ''
Write-Host "  avsync  —— 央视频看画面 · B站听声音 · 延迟随便调" -ForegroundColor Cyan
Write-Host "  ---------------------------------------------------"

if (Test-Server) {
    Write-Host "  服务已经在运行，直接打开页面：$url" -ForegroundColor Green
    Start-Process $url
    Start-Sleep -Seconds 2
    exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  找不到 node，请先安装 Node.js 18 或更高版本：https://nodejs.org/" -ForegroundColor Red
    Read-Host "  按回车退出"
    exit 1
}

$env:PORT = $port
if (-not $env:HOST) { $env:HOST = '127.0.0.1' }

$logOut = Join-Path $root 'run.log'
$logErr = Join-Path $root 'run.err'
$proc = Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory $root `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr -WindowStyle Hidden -PassThru

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Server) { $ready = $true; break }
    if ($proc.HasExited) { break }
}

if ($ready) {
    Write-Host "  启动成功：$url" -ForegroundColor Green
    Start-Process $url
    Write-Host ''
    Write-Host "  浏览器已经打开。这个窗口可以关掉，关掉不会停服务；" -ForegroundColor DarkGray
    Write-Host "  要停服务请双击 停止.cmd。" -ForegroundColor DarkGray
    Write-Host ''
} else {
    Write-Host "  启动失败，下面是错误信息：" -ForegroundColor Red
    if (Test-Path $logErr) { Get-Content $logErr | Select-Object -Last 30 | ForEach-Object { Write-Host ('    ' + $_) } }
    if (Test-Path $logOut) { Get-Content $logOut | Select-Object -Last 30 | ForEach-Object { Write-Host ('    ' + $_) } }
    Write-Host ''
    Read-Host "  按回车退出"
    exit 1
}

if (-not $env:AVSYNC_NO_PAUSE) {
    Read-Host "  按回车关闭此窗口（服务继续在后台运行）"
}
