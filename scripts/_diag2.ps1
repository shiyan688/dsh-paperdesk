# Diagnostics round 2: pull the served client bundle to disk and check whether the
# plugin's ACTUAL CODE is inside it (a module-id string in the loader table is not
# proof). ASCII only. Delete after use.

$repo = 'D:\research\dsh-paperdesk'
$profileName = 'web'
$port = 3097
$base = "http://127.0.0.1:$port"
$dshBin = 'C:\Users\ASUS\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
$logDir = Join-Path $repo '.test-tmp'
$logOut = Join-Path $logDir 'diag2.out.log'
$logErr = Join-Path $logDir 'diag2.err.log'
$bundlePath = Join-Path $logDir 'bundle.js'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Remove-Item -Force $logOut, $logErr, $bundlePath -ErrorAction SilentlyContinue

Write-Output "=== boot profile '$profileName' on port $port ==="
$proc = Start-Process -FilePath 'node' `
  -ArgumentList @($dshBin, '--profile', $profileName, '--port', "$port", '--no-open') `
  -PassThru -NoNewWindow -RedirectStandardOutput $logOut -RedirectStandardError $logErr
Write-Output "  pid=$($proc.Id)"
for ($i = 1; $i -le 60; $i++) {
  Start-Sleep -Seconds 1
  if ($proc.HasExited) { Write-Output '  exited early'; break }
  try { Invoke-WebRequest "$base/" -UseBasicParsing -TimeoutSec 3 | Out-Null; Write-Output "  up after ${i}s"; break }
  catch { if ($_.Exception.Response -ne $null) { Write-Output "  up after ${i}s"; break } }
}

$token = $null
for ($i = 0; $i -lt 20 -and -not $token; $i++) {
  $hit = Select-String -Path $logOut -Pattern 'token=([A-Za-z0-9_\-]+)' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit -ne $null) { $token = $hit.Matches[0].Groups[1].Value }
  if (-not $token) { Start-Sleep -Seconds 1 }
}
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

if ($token -ne $null) {
  try { Invoke-WebRequest "$base/?token=$token" -UseBasicParsing -WebSession $session -TimeoutSec 10 | Out-Null } catch { }
  $html = (Invoke-WebRequest "$base/" -UseBasicParsing -WebSession $session -TimeoutSec 20).Content
  $m = [regex]::Matches($html, '(?:src|href)="([^"]*paperdesk[^"]*)"')
  if ($m.Count -eq 0) { Write-Output '  no paperdesk asset tag' }
  else {
    $src = $m[0].Groups[1].Value -replace '&amp;', '&'
    Write-Output "  fetching bundle -> $bundlePath"
    Invoke-WebRequest "$base$src" -UseBasicParsing -WebSession $session -TimeoutSec 120 -OutFile $bundlePath
    Write-Output "  saved: $((Get-Item $bundlePath).Length) bytes"
  }
}

Write-Output ""
Write-Output "=== stop the temporary instance ==="
taskkill /PID $proc.Id /T /F 2>&1 | Select-Object -First 1 | ForEach-Object { "  $_" }
Start-Sleep -Seconds 1

Write-Output ""
Write-Output "=== analyze the bundle with node ==="
Set-Location $repo
node -e "
const { readFileSync } = require('node:fs')
const path = '.test-tmp/bundle.js'
let text
try { text = readFileSync(path, 'utf8') } catch (e) { console.log('  cannot read bundle:', e.message); process.exit(0) }
console.log('  bundle chars:', text.length)
const markers = {
  'loader wrapper __ModuleLoader__': '__ModuleLoader__',
  'my api prefix paperdesk/api': 'paperdesk/api',
  'my panel title 论文工作台': '论文工作台',
  'my sidebar label 论文': '📚 论文',
  'my slot call sidebar.footer.action': 'sidebar.footer.action',
  'taste-loop api (control)': 'taste-loop/api',
  'novel-craft marker (control)': 'novel-craft',
}
for (const [label, needle] of Object.entries(markers)) {
  console.log('  ' + (text.includes(needle) ? 'YES ' : 'no  ') + label)
}
const idx = text.indexOf('dsh-paperdesk')
console.log('')
console.log('  first occurrence of \\'dsh-paperdesk\\' at char', idx)
if (idx >= 0) {
  const from = Math.max(0, idx - 400)
  console.log('  ---- window ----')
  console.log(text.slice(from, from + 900))
  console.log('  ---- end window ----')
}
"