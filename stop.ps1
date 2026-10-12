# stop.ps1 - stop avsync (called by the .cmd next to it). ASCII-only, see start.ps1.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$port = if ($env:PORT) { [int]$env:PORT } else { 8799 }

$conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Host "  端口  $port  上没有服务在运行，无需停止。" -ForegroundColor Yellow
    Start-Sleep -Seconds 2
    exit 0
}

$ids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $ids) {
    try {
        Stop-Process -Id $id -Force
        Write-Host "  已停止 avsync（PID  $id）" -ForegroundColor Green
    } catch {
        Write-Host "  停止 PID  $id  失败：$($_.Exception.Message)" -ForegroundColor Red
    }
}
Start-Sleep -Seconds 2
