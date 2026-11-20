# Indognito CLI installer (Windows, PowerShell).
#
#   irm https://raw.githubusercontent.com/aswartzlander2-school/indognito/main/install.ps1 | iex
#
# Downloads only the gnito CLI. Run `gnito start` afterwards to open the setup wizard, which
# downloads the Node.js runtime and the Indognito application and starts it.
#
# Overrides (env): GNITO_VERSION, GNITO_RELEASE_URL, GNITO_INSTALL_DIR
$ErrorActionPreference = 'Stop'
$repo = 'aswartzlander2-school/indognito'

$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { 'amd64' }
  'ARM64' { 'arm64' }
  default { throw "Unsupported CPU architecture: $($env:PROCESSOR_ARCHITECTURE)" }
}
$asset = "gnito-windows-$arch.exe"
$ver = if ($env:GNITO_VERSION) { $env:GNITO_VERSION } else { 'latest' }
$url =
  if ($env:GNITO_RELEASE_URL) { "$($env:GNITO_RELEASE_URL.TrimEnd('/'))/$asset" }
  elseif ($ver -eq 'latest')  { "https://github.com/$repo/releases/latest/download/$asset" }
  else                        { "https://github.com/$repo/releases/download/$ver/$asset" }

$dir = if ($env:GNITO_INSTALL_DIR) { $env:GNITO_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Indognito\bin' }
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$dest = Join-Path $dir 'gnito.exe'

Write-Host "INDOGNITO installer" -ForegroundColor Red
Write-Host "  arch    : windows/$arch"
Write-Host "  Source  : $url"
Write-Host "  Install : $dest`n"

Write-Host "Downloading gnito…"
try { Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing }
catch { throw "Download failed from $url (is the release published?): $($_.Exception.Message)" }

Write-Host "`n[OK] gnito installed to $dest" -ForegroundColor Green

# Add the install dir to the user PATH if it isn't already there.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (($userPath -split ';') -notcontains $dir) {
  [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
  Write-Host "Added $dir to your user PATH. Open a new terminal for it to take effect." -ForegroundColor Yellow
}

Write-Host "`nNext:"
Write-Host "  gnito start    # opens the setup wizard, then runs Indognito" -ForegroundColor Green
