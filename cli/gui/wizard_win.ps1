# Indognito setup wizard for Windows (WinForms with native visual styles).
# Launched by "gnito start"; the gnito binary does the checks and the installation.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$Gnito   = $env:GNITO_BIN
$Result  = $env:GNITO_RESULT
$Version = $env:GNITO_VERSION
$Tmp     = $env:GNITO_TMP
$State   = $env:GNITO_STATE
$script:mode = 'user'; $script:done = $false; $script:proc = $null

function Api([string[]]$a) {
  $out = & $Gnito __wizard @a
  if ($out -is [array]) { $out = $out[-1] }
  if ($out) { return $out | ConvertFrom-Json } else { return @{} }
}
function Write-Result($outcome, $reason) {
  if ($Result) { @{ outcome = $outcome; reason = $reason } | ConvertTo-Json | Set-Content -Path $Result -Encoding UTF8 }
}

$form = New-Object Windows.Forms.Form
$form.Text = "Indognito $Version Setup"
$form.Size = New-Object Drawing.Size(800, 580)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Segoe UI', 9.5)
$form.FormBorderStyle = 'FixedDialog'; $form.MaximizeBox = $false

$body = New-Object Windows.Forms.FlowLayoutPanel
$body.FlowDirection = 'TopDown'; $body.WrapContents = $false; $body.AutoScroll = $true
$body.Dock = 'Fill'; $body.Padding = New-Object Windows.Forms.Padding(24)
$bar = New-Object Windows.Forms.FlowLayoutPanel
$bar.FlowDirection = 'RightToLeft'; $bar.Dock = 'Bottom'; $bar.Height = 52; $bar.Padding = New-Object Windows.Forms.Padding(10)
$form.Controls.Add($body); $form.Controls.Add($bar)

function Clear-Page { $body.Controls.Clear(); $bar.Controls.Clear() }
function H($t, $size = 16) { $l = New-Object Windows.Forms.Label; $l.Text = $t; $l.AutoSize = $true; $l.Font = New-Object Drawing.Font('Segoe UI Semibold', $size); $l.Margin = '0,0,0,10'; $body.Controls.Add($l) }
function P($t) { $l = New-Object Windows.Forms.Label; $l.Text = $t; $l.AutoSize = $true; $l.MaximumSize = New-Object Drawing.Size(720, 0); $l.Margin = '0,4,0,4'; $body.Controls.Add($l) }
function Btn($t, $action, [bool]$primary = $false) {
  $b = New-Object Windows.Forms.Button; $b.Text = $t; $b.AutoSize = $true; $b.MinimumSize = New-Object Drawing.Size(90, 30)
  $b.Add_Click($action); $bar.Controls.Add($b); if ($primary) { $form.AcceptButton = $b }
}
function NumBox($v) {
  $t = New-Object Windows.Forms.TextBox; $t.Text = "$v"; $t.Width = 90
  $t.Add_KeyPress({ if (-not [char]::IsDigit($_.KeyChar) -and -not [char]::IsControl($_.KeyChar)) { $_.Handled = $true } })
  return $t
}
function Table($headers, $rows) {
  $g = New-Object Windows.Forms.TableLayoutPanel
  $g.ColumnCount = $headers.Count; $g.AutoSize = $true; $g.CellBorderStyle = 'Single'; $g.Margin = '0,8,0,8'
  foreach ($h in $headers) { $l = New-Object Windows.Forms.Label; $l.Text = $h; $l.AutoSize = $true; $l.Font = New-Object Drawing.Font('Segoe UI Semibold', 9.5); $l.Margin = '8,6,8,6'; $g.Controls.Add($l) }
  foreach ($r in $rows) { foreach ($c in $r) {
    if ($c -is [Windows.Forms.Control]) { $c.Margin = '8,4,8,4'; $g.Controls.Add($c) }
    else { $l = New-Object Windows.Forms.Label; $l.Text = "$c"; $l.AutoSize = $true; $l.Margin = '8,6,8,6'; $g.Controls.Add($l) } } }
  $body.Controls.Add($g)
}
function Abort($reason = 'You cancelled setup.') {
  if ($script:done) { return }
  if ($script:proc -and -not $script:proc.HasExited) { $script:proc.Kill() }
  [Windows.Forms.MessageBox]::Show('The installation process was aborted', 'Indognito Setup', 'OK', 'Error') | Out-Null
  Write-Result 'cancelled' $reason; $script:done = $true; $form.Close()
}
$form.Add_FormClosing({ if (-not $script:done) { Abort 'The setup window was closed.' } })

$existing = Api @('existing')

function Show-Welcome {
  Clear-Page
  H "Welcome to Indognito v$Version" 20
  P 'This assistant sets up Indognito on this computer: an isolated browser, a terminal, file storage and an admin dashboard.'
  if ($existing.version) { P "An existing installation (v$($existing.version)) was found at $($existing.installDir). It will be reinstalled; your data is kept." }
  Btn 'Next' { Show-Checks } $true; Btn 'Cancel' { Abort }
}

function Show-Checks {
  Clear-Page
  H 'Checking if your device is compatible...'
  P "We're just checking to ensure we can stably run gnito on your machine. This will only take a moment."
  $pb = New-Object Windows.Forms.ProgressBar; $pb.Width = 720; $pb.Maximum = 10; $body.Controls.Add($pb)
  $list = New-Object Windows.Forms.ListBox; $list.Width = 720; $list.Height = 230; $body.Controls.Add($list)
  Btn 'Cancel' { Abort }
  $form.Refresh()
  $checks = & $Gnito __wizard checks | ForEach-Object { $_ | ConvertFrom-Json }
  $fails = @()
  foreach ($c in $checks) {
    $mark = if ($c.ok) { '✓' } elseif ($c.fatal) { '✗' } else { '!' }
    $list.Items.Add(" $mark  $($c.label) — $($c.detail)") | Out-Null
    $pb.Value = [Math]::Min(10, $list.Items.Count); [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 120
    if ($c.fatal -and -not $c.ok) { $fails += "$($c.label): $($c.detail)" }
  }
  if ($fails.Count -gt 0) {
    [Windows.Forms.MessageBox]::Show(("Setup stopped because these requirements are not met:`n`n" + ($fails -join "`n")), "This device can't run Indognito", 'OK', 'Error') | Out-Null
    Write-Result 'incompatible' ($fails -join "`n"); $script:done = $true; $form.Close(); return
  }
  $bar.Controls.Clear(); Btn 'Next' { Show-Perms } $true; Btn 'Cancel' { Abort }
}

function Show-Perms {
  Clear-Page
  H 'How should Indognito be installed?'
  P 'Continue installs for your account only (recommended). Continue as Administrator installs to Program Files and asks for permission through User Account Control when installation starts.'
  Btn 'Continue' { $script:mode = 'user'; Show-Ports } $true
  Btn 'Continue as Administrator' { $script:mode = 'admin'; Show-Ports }
  Btn 'Cancel' { Abort }
}

function Show-Ports {
  Clear-Page
  $form.Size = New-Object Drawing.Size(900, 620)
  H 'Port configuration'
  $be = if ($existing.backendPort) { $existing.backendPort } else { 7710 }
  $fe = if ($existing.frontendPort) { $existing.frontendPort } else { 7711 }
  $script:beBox = NumBox $be; $script:feBox = NumBox $fe
  Table @('Component', 'Port', 'Purpose') @(@('Backend', $script:beBox, 'API and relay (127.0.0.1 only)'), @('Frontend', $script:feBox, 'Web interface'))
  Btn 'Next' {
    $a = @('validate-ports', '--backend', $script:beBox.Text, '--frontend', $script:feBox.Text); if ($script:mode -eq 'admin') { $a += '--admin' }
    $r = Api $a
    if ($r.errors.Count -gt 0) { [Windows.Forms.MessageBox]::Show(($r.errors -join "`n`n"), 'Please check the ports', 'OK', 'Error') | Out-Null; return }
    Show-Storage
  } $true
  Btn 'Back' { Show-Perms }; Btn 'Cancel' { Abort }
}

function Show-Storage {
  Clear-Page
  $r = Api @('resources', '--mode', $script:mode); $script:res = $r
  H 'Storage allocations'
  $script:ramBox = NumBox ([Math]::Max(3072, [Math]::Min(4096, $r.ramAvailMB)))
  $script:stBox = NumBox ([Math]::Max(8192, [Math]::Min(16384, $r.storageAvailMB)))
  Table @('Resource', 'Minimum', 'Maximum', 'Allocate (MB)') @(@('RAM', '3072 MB', "$($r.ramAvailMB) MB available", $script:ramBox), @('Storage', '8192 MB', "$($r.storageAvailMB) MB free", $script:stBox))
  H 'Processor allocation' 12
  $script:coreBox = NumBox $r.cpuCores; $script:pctBox = NumBox 100
  Table @('Detected', 'Available', 'Cores', 'Per core (%)') @(, @("$($r.cpuCores) core(s)", "$($r.cpuCores * 100)%", $script:coreBox, $script:pctBox))
  Btn 'Next' {
    $e = (Api @('validate-alloc', '--ram', $script:ramBox.Text, '--storage', $script:stBox.Text, '--cores', $script:coreBox.Text, '--pct', $script:pctBox.Text)).errors
    if ($e.Count -gt 0) { [Windows.Forms.MessageBox]::Show(($e -join "`n`n"), 'These allocations are not possible', 'OK', 'Error') | Out-Null; return }
    $script:dir = if ($script:mode -eq 'admin') { $script:res.adminInstallDir } else { $script:res.installDir }
    Show-Confirm
  } $true
  Btn 'Back' { Show-Ports }; Btn 'Cancel' { Abort }
}

function Show-Confirm {
  Clear-Page
  H 'Ready to install'
  $pm = if ($script:mode -eq 'admin') { 'Administrator' } else { 'Standard user' }
  Table @('Setting', 'Value') @(@('Backend port', $script:beBox.Text), @('Frontend port', $script:feBox.Text), @('Permission mode', $pm),
    @('RAM allocation', "$($script:ramBox.Text) MB"), @('Storage allocation', "$($script:stBox.Text) MB"),
    @('CPU allocation', "$($script:coreBox.Text) core(s) at $($script:pctBox.Text)%"), @('Installation destination', $script:dir))
  P 'Continue lets you choose a different installation folder first.'
  Btn 'Install' { Show-Progress } $true
  Btn 'Continue' { $d = New-Object Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $script:dir = Join-Path $d.SelectedPath 'Indognito' }; Show-Confirm }
  Btn 'Cancel' { Abort }
}

function Show-Progress {
  Clear-Page
  H 'Installing Indognito'
  $pb = New-Object Windows.Forms.ProgressBar; $pb.Width = 720; $body.Controls.Add($pb)
  $labels = @{}
  foreach ($k in @(@('activity', 'Current activity'), @('component', 'Most recently installed'), @('dir', 'Installation directory'), @('transfer', 'Download / extraction'))) {
    $l = New-Object Windows.Forms.Label; $l.AutoSize = $true; $l.MaximumSize = New-Object Drawing.Size(720, 0); $l.Text = "$($k[1]): —"; $body.Controls.Add($l); $labels[$k[0]] = @($l, $k[1])
  }
  Btn 'Cancel' { Abort 'Installation was cancelled while in progress.' }
  $data = Join-Path $script:dir 'data'
  if ($script:mode -eq 'admin' -and $script:dir -eq $script:res.adminInstallDir) { $data = Join-Path $env:ProgramData 'Indognito' }
  $envs = @{}; foreach ($k in 'GNITO_RELEASE_URL', 'GNITO_BUNDLE', 'GNITO_DEV_RELAX', 'GNITO_NODE_VERSION') { $v = [Environment]::GetEnvironmentVariable($k); if ($v) { $envs[$k] = $v } }
  $plan = @{ mode = $script:mode; backend = [int]$script:beBox.Text; frontend = [int]$script:feBox.Text; ramMB = [int]$script:ramBox.Text; storageMB = [int]$script:stBox.Text
    cpuCores = [int]$script:coreBox.Text; cpuPercent = [int]$script:pctBox.Text; installDir = $script:dir; dataDir = $data; keepData = $true; stateFile = $State; env = $envs }
  $pf = Join-Path $Tmp 'plan.json'; $plan | ConvertTo-Json | Set-Content -Path $pf -Encoding UTF8
  $log = Join-Path $Tmp 'progress.jsonl'
  $psi = New-Object Diagnostics.ProcessStartInfo
  if ($script:mode -eq 'admin') {
    # UAC prompt; elevated processes cannot share a pipe with us, so progress goes through a file.
    $psi.FileName = 'cmd.exe'; $psi.Arguments = "/c `"`"$Gnito`" __wizard install --plan `"$pf`" > `"$log`"`""; $psi.Verb = 'runas'; $psi.UseShellExecute = $true; $psi.WindowStyle = 'Hidden'
  } else {
    $psi.FileName = 'cmd.exe'; $psi.Arguments = "/c `"`"$Gnito`" __wizard install --plan `"$pf`" > `"$log`"`""; $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  }
  try { $script:proc = [Diagnostics.Process]::Start($psi) } catch { [Windows.Forms.MessageBox]::Show('Administrator permission was not granted.', 'Installation failed', 'OK', 'Error') | Out-Null; Write-Result 'failed' 'Administrator permission was not granted.'; $script:done = $true; $form.Close(); return }
  $last = $null
  while (-not $script:proc.HasExited -or $true) {
    if (Test-Path $log) {
      foreach ($line in (Get-Content $log -ErrorAction SilentlyContinue)) {
        try { $p = $line | ConvertFrom-Json } catch { continue }
        $last = $p
      }
      if ($last) {
        $pb.Value = [Math]::Min(100, [int]$last.percent)
        foreach ($k in $labels.Keys) { if ($last.$k) { $labels[$k][0].Text = "$($labels[$k][1]): $($last.$k)" } }
      }
    }
    [Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 200
    if ($script:proc.HasExited) { break }
  }
  Start-Sleep -Milliseconds 300
  if (Test-Path $log) { foreach ($line in (Get-Content $log)) { try { $last = $line | ConvertFrom-Json } catch {} } }
  if ($last -and $last.done -and -not $last.error) {
    Clear-Page; H 'Everything has installed successfully!' 20
    Btn 'OK' { Write-Result 'installed' ''; $script:done = $true; $form.Close() } $true
  } else {
    $reason = if ($last -and $last.error) { $last.error } else { 'The installer stopped unexpectedly.' }
    [Windows.Forms.MessageBox]::Show($reason, 'Installation failed', 'OK', 'Error') | Out-Null
    Write-Result 'failed' $reason; $script:done = $true; $form.Close()
  }
}

Show-Welcome
[void]$form.ShowDialog()
