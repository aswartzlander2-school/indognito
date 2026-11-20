# Indognito installer for Windows 10 (1809+) and 11, x64 and ARM64.
#
#   irm https://github.com/aswartzlander2-school/indognito/releases/latest/download/install.ps1 | iex
#
# Downloads only the `gnito` command (checksum-verified) into your user profile and puts it on your
# PATH — no administrator rights needed. Then run `gnito start`: setup runs once, on the first start.
#
# Options (environment variables):
#   $env:GNITO_VERSION = "1.0.0"   a specific version (default: the latest release)
#   $env:GNITO_BIN_DIR = "C:\..."  where to put gnito.exe (default: %LOCALAPPDATA%\Programs\Indognito)
#   $env:GITHUB_TOKEN  = "…"       needed while the repository is private (or sign in with `gh auth login`)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Repo = 'aswartzlander2-school/indognito'
function Say($m)  { Write-Host $m -ForegroundColor White }
function Note($m) { Write-Host "  $m" }
function Die($m)  { Write-Host "x $m" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- platform
$build = [Environment]::OSVersion.Version.Build
if ($build -lt 17763) { Die "Indognito needs Windows 10 version 1809 or newer (terminals use ConPTY)." }
# a 32-bit PowerShell on 64-bit Windows reports the real CPU in PROCESSOR_ARCHITEW6432
$cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($cpu) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { Die "Unsupported CPU: $cpu (Indognito supports x64 and ARM64)." }
}

# ---------------------------------------------------------------- downloads (public, or private with a token)
$token = $env:GITHUB_TOKEN
if (-not $token) { $token = $env:GH_TOKEN }
if (-not $token -and (Get-Command gh -ErrorAction SilentlyContinue)) {
  try { $token = (& gh auth token 2>$null).Trim() } catch { }
}
$headers = @{ 'User-Agent' = 'gnito-install' }
if ($token) { $headers['Authorization'] = "Bearer $token" }

function Api($path) {
  Invoke-RestMethod -Headers $headers -Uri "https://api.github.com/repos/$Repo/$path"
}

$Version = $env:GNITO_VERSION
if (-not $Version) {
  try { $Version = (Api 'releases/latest').tag_name.TrimStart('v') }
  catch { Die "Couldn't find the latest release. If the repository is private, set `$env:GITHUB_TOKEN or run 'gh auth login' first." }
}

function Get-Asset($name, $dest) {
  if (-not $token) {
    Invoke-WebRequest -UseBasicParsing -Headers $headers -OutFile $dest -Uri "https://github.com/$Repo/releases/download/v$Version/$name"
    return
  }
  $rel = Api "releases/tags/v$Version"
  $a = $rel.assets | Where-Object { $_.name -eq $name } | Select-Object -First 1
  if (-not $a) { Die "Release v$Version has no file $name." }
  $h = $headers.Clone(); $h['Accept'] = 'application/octet-stream'
  Invoke-WebRequest -UseBasicParsing -Headers $h -OutFile $dest -Uri "https://api.github.com/repos/$Repo/releases/assets/$($a.id)"
}

Say "Installing Indognito $Version for windows/$arch"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("gnito-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $name = "gnito-windows-$arch.exe"
  Get-Asset $name (Join-Path $tmp 'gnito.exe')
  Get-Asset 'SHA256SUMS' (Join-Path $tmp 'SHA256SUMS')
  $want = (Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match " $([regex]::Escape($name))$" } | Select-Object -First 1)
  if ($want) { $want = ($want -split ' ')[0].ToLower() }
  $got = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp 'gnito.exe')).Hash.ToLower()
  if (-not $want -or $want -ne $got) { Die "Checksum mismatch for $name - refusing to install." }
  Note 'gnito downloaded and verified'

  # ---------------------------------------------------------------- install + PATH
  $dest = $env:GNITO_BIN_DIR
  if (-not $dest) { $dest = Join-Path $env:LOCALAPPDATA 'Programs\Indognito' }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Move-Item -Force (Join-Path $tmp 'gnito.exe') (Join-Path $dest 'gnito.exe')
  Unblock-File (Join-Path $dest 'gnito.exe') -ErrorAction SilentlyContinue
  Note "gnito -> $dest\gnito.exe"

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -ieq $dest })) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $dest), 'User')
    Note 'Added to your PATH (new terminals pick it up).'
  }
  if (-not ($env:Path -split ';' | Where-Object { $_ -ieq $dest })) { $env:Path = "$env:Path;$dest" }
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

Write-Host ''
Say 'Done. Now run:  gnito start'
Note 'Setup runs once, the first time. After that, gnito start just starts Indognito.'
