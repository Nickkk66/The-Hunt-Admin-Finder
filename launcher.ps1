# The Hunt Admin Finder - launcher / readiness checker
# One plain screen: is it ready, is it running, one button to act on it.
# Anything fiddly lives behind "More options".

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

# Resolve a real node.exe. We avoid a bare "node" because a stray file on PATH
# (e.g. C:\Windows\System32\node) can shadow it and hang.
function Resolve-NodePath {
  $cands = @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe")
  foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
  try {
    $g = Get-Command node -All -ErrorAction SilentlyContinue |
         Where-Object { $_.Source -like '*node.exe' } | Select-Object -First 1
    if ($g) { return $g.Source }
  } catch {}
  return $null
}
$script:NodePath = Resolve-NodePath

function Get-EnvVal([string]$key) {
  $envPath = Join-Path $Root '.env'
  if (-not (Test-Path $envPath)) { return $null }
  foreach ($line in (Get-Content -LiteralPath $envPath)) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    if ($k -eq $key) {
      $v = $t.Substring($eq + 1).Trim()
      if ($v.Length -ge 2 -and (
            ($v.StartsWith('"') -and $v.EndsWith('"')) -or
            ($v.StartsWith("'") -and $v.EndsWith("'")))) {
        $v = $v.Substring(1, $v.Length - 2)
      }
      return $v
    }
  }
  return $null
}

# Write values back without touching the comments or anything we don't manage.
function Set-EnvVals([hashtable]$vals) {
  $envPath = Join-Path $Root '.env'
  $lines = @()
  if (Test-Path $envPath) {
    $lines = @(Get-Content -LiteralPath $envPath)
  } elseif (Test-Path (Join-Path $Root '.env.example')) {
    $lines = @(Get-Content -LiteralPath (Join-Path $Root '.env.example'))
  }
  $seen = @{}
  $out = foreach ($line in $lines) {
    $t = $line.Trim()
    if (-not $t -or $t.StartsWith('#')) { $line; continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { $line; continue }
    $k = $t.Substring(0, $eq).Trim()
    if ($vals.ContainsKey($k)) { $seen[$k] = $true; "$k=$($vals[$k])" } else { $line }
  }
  $out = @($out)
  foreach ($k in $vals.Keys) {
    if (-not $seen.ContainsKey($k)) { $out += "$k=$($vals[$k])" }
  }
  Set-Content -LiteralPath $envPath -Value $out -Encoding UTF8
}

function Get-NodeMajor {
  if (-not $script:NodePath) { return $null }
  try {
    $out = & $script:NodePath --version 2>$null
    if ($out -match 'v(\d+)\.') { return [int]$Matches[1] }
    return $null
  } catch { return $null }
}

# Watcher processes already running out of this folder. Two copies would send
# every Discord alert twice, so we surface them instead of silently stacking up.
function Get-WatcherProcs {
  try {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
             Where-Object { $_.CommandLine -match 'src[\\/]+index\.js' -and
                            $_.CommandLine -notmatch 'node_modules' })
  } catch { return @() }
}

# Every check speaks plain English. No file names, no jargon, no "re-check".
function Run-Checks {
  $checks = @()

  $major = Get-NodeMajor
  if ($null -eq $major) {
    $checks += [pscustomobject]@{ Name='The program that runs it'; Status='FAIL'; Detail='not installed yet'; Fix='Go to nodejs.org, download the big green button, install it, then open this again.' }
  } elseif ($major -lt 20) {
    $checks += [pscustomobject]@{ Name='The program that runs it'; Status='FAIL'; Detail=("too old (version {0})" -f $major); Fix='Go to nodejs.org and install the newest version, then open this again.' }
  } else {
    $checks += [pscustomobject]@{ Name='The program that runs it'; Status='PASS'; Detail='installed'; Fix='' }
  }

  if (Test-Path (Join-Path $Root '.env')) {
    $checks += [pscustomobject]@{ Name='Your saved settings'; Status='PASS'; Detail='saved'; Fix='' }
  } else {
    $checks += [pscustomobject]@{ Name='Your saved settings'; Status='FAIL'; Detail='not made yet'; Fix='Click the blue button below and it will make them for you.' }
  }

  if (Get-EnvVal 'ROBLOX_COOKIE') {
    $checks += [pscustomobject]@{ Name='Your Roblox login'; Status='PASS'; Detail='saved'; Fix='' }
  } else {
    $checks += [pscustomobject]@{ Name='Your Roblox login'; Status='FAIL'; Detail='not saved yet'; Fix='Click the blue button below and paste it in. (Get it on roblox.com: press F12, then Application, Cookies, .ROBLOSECURITY.)' }
  }

  $s = Get-EnvVal 'DISCORD_WEBHOOK_SILVER_WINGS'
  $g = Get-EnvVal 'DISCORD_WEBHOOK_GOLDEN_WINGS'
  if ($s -or $g) {
    $checks += [pscustomobject]@{ Name='Your Discord alerts'; Status='PASS'; Detail='set up'; Fix='' }
  } else {
    $checks += [pscustomobject]@{ Name='Your Discord alerts'; Status='WARN'; Detail='not set up - you will not get pinged'; Fix='Not required. For pings, put your Discord webhook link in Settings.' }
  }

  $wPath = Join-Path $Root 'watchers.json'
  if (-not (Test-Path $wPath)) {
    $checks += [pscustomobject]@{ Name='Groups to watch'; Status='FAIL'; Detail='none picked yet'; Fix='Click the blue button below and it will set up the two default groups for you.' }
  } else {
    try {
      $j = Get-Content -LiteralPath $wPath -Raw | ConvertFrom-Json
      $count = @($j.watchers).Count
      if ($count -ge 1) {
        $checks += [pscustomobject]@{ Name='Groups to watch'; Status='PASS'; Detail=("{0} group(s) picked" -f $count); Fix='' }
      } else {
        $checks += [pscustomobject]@{ Name='Groups to watch'; Status='FAIL'; Detail='none picked yet'; Fix='Open More options, then Open the folder, and add a group to watchers.json.' }
      }
    } catch {
      $checks += [pscustomobject]@{ Name='Groups to watch'; Status='FAIL'; Detail='the file got broken'; Fix='Open More options, then Open the folder, and delete watchers.json. Then come back and click the blue button.' }
    }
  }

  return $checks
}

function Start-Node([string]$scriptArgs) {
  $nc = if ($script:NodePath) { '"' + $script:NodePath + '"' } else { 'node' }
  Start-Process 'cmd.exe' -ArgumentList ('/k ' + $nc + ' ' + $scriptArgs) -WorkingDirectory $Root
}

# The watcher itself runs with no console: the launcher is the control surface,
# and its output is appended to watcher.log so "See what it has been doing"
# actually has something to show. Nothing in the app writes that file - it has
# always been a shell redirect, so leaving it out silently froze the log.
function Start-Watcher {
  $nc = if ($script:NodePath) { '"' + $script:NodePath + '"' } else { 'node' }
  $cmd = '/c ' + $nc + ' src\index.js >> watcher.log 2>&1'
  Start-Process 'cmd.exe' -ArgumentList $cmd -WorkingDirectory $Root -WindowStyle Hidden
}

$Green = [System.Drawing.Color]::FromArgb(46,120,64)
$Red   = [System.Drawing.Color]::FromArgb(140,58,58)
$Blue  = [System.Drawing.Color]::FromArgb(42,86,140)
$Grey  = [System.Drawing.Color]::FromArgb(50,52,58)
$Dim   = [System.Drawing.Color]::FromArgb(44,45,50)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'The Hunt Admin Finder'
$form.Size = New-Object System.Drawing.Size(660, 720)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.Color]::FromArgb(24,25,28)
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false

function New-Btn($parent, $text, $x, $y, $w, $h) {
  $b = New-Object System.Windows.Forms.Button
  $b.Text = $text
  $b.Location = New-Object System.Drawing.Point($x, $y)
  $b.Size = New-Object System.Drawing.Size($w, $h)
  $b.FlatStyle = 'Flat'
  $b.ForeColor = [System.Drawing.Color]::White
  $b.BackColor = $Grey
  $b.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(80,82,90)
  $parent.Controls.Add($b)
  return $b
}

function New-Note($parent, $text, $x, $y, $w) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $text
  $l.Location = New-Object System.Drawing.Point($x, $y)
  $l.Size = New-Object System.Drawing.Size($w, 20)
  $l.ForeColor = [System.Drawing.Color]::Gainsboro
  $parent.Controls.Add($l)
  return $l
}

# ---------------------------------------------------------------- main screen

$main = New-Object System.Windows.Forms.Panel
$main.Location = New-Object System.Drawing.Point(0, 0)
$main.Size = New-Object System.Drawing.Size(646, 682)
$form.Controls.Add($main)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'The Hunt Admin Finder'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 16)
$main.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Pings your Discord when someone in your groups is playing The Hunt.'
$subtitle.AutoSize = $true
$subtitle.ForeColor = [System.Drawing.Color]::Gainsboro
$subtitle.Location = New-Object System.Drawing.Point(22, 54)
$main.Controls.Add($subtitle)

$panel = New-Object System.Windows.Forms.FlowLayoutPanel
$panel.Location = New-Object System.Drawing.Point(20, 88)
$panel.Size = New-Object System.Drawing.Size(606, 370)
$panel.AutoScroll = $true
$panel.FlowDirection = 'TopDown'
$panel.WrapContents = $false
$panel.BorderStyle = 'FixedSingle'
$panel.BackColor = [System.Drawing.Color]::FromArgb(30,31,35)
$main.Controls.Add($panel)

$status = New-Object System.Windows.Forms.Label
$status.AutoSize = $false
$status.Size = New-Object System.Drawing.Size(606, 32)
$status.Location = New-Object System.Drawing.Point(20, 468)
$status.TextAlign = 'MiddleLeft'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$main.Controls.Add($status)

# Appears only when something is broken, and does the fixing for you.
$btnFix = New-Btn $main 'Set this up for me' 20 464 606 40
$btnFix.BackColor = $Blue
$btnFix.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

$btnGo = New-Btn $main 'Start watching' 20 552 380 56
$btnGo.Font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold)

$btnAgain = New-Btn $main 'Check again' 412 552 214 26
$btnMore  = New-Btn $main 'More options' 412 582 214 26

$btnClose = New-Btn $main 'Close this window' 20 620 380 30
$btnClose.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(50,52,58)

$hint = New-Note $main '' 412 620 214
$hint.TextAlign = 'MiddleLeft'

# ---------------------------------------------------------------- more screen

$more = New-Object System.Windows.Forms.Panel
$more.Location = New-Object System.Drawing.Point(0, 0)
$more.Size = New-Object System.Drawing.Size(646, 682)
$more.Visible = $false
$form.Controls.Add($more)

$mTitle = New-Object System.Windows.Forms.Label
$mTitle.Text = 'More options'
$mTitle.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$mTitle.AutoSize = $true
$mTitle.Location = New-Object System.Drawing.Point(20, 16)
$more.Controls.Add($mTitle)

$mSub = New-Note $more 'None of this is needed to just use it.' 22 56 580

$btnEnv  = New-Btn $more 'Settings'                    20 100 606 46
$btnEnv.BackColor = $Blue
$btnEnv.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
[void](New-Note $more 'Your Roblox login and Discord links.' 24 150 600)

$btnOnce = New-Btn $more 'Look once, right now'        20 186 606 46
[void](New-Note $more 'One check, then it stops.' 24 236 600)

$btnDash = New-Btn $more 'See everyone it has found'   20 272 606 46
[void](New-Note $more 'A list of everyone it has spotted.' 24 322 600)

$btnLog  = New-Btn $more 'See what it has been doing'  20 358 606 46
[void](New-Note $more 'Its diary.' 24 408 600)

$btnDir  = New-Btn $more 'Open the folder' 20 516 290 40

$btnBack = New-Btn $more 'Back' 336 516 290 40
$btnBack.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)

# ------------------------------------------------------------ settings screen

$setp = New-Object System.Windows.Forms.Panel
$setp.Location = New-Object System.Drawing.Point(0, 0)
$setp.Size = New-Object System.Drawing.Size(646, 682)
$setp.Visible = $false
$form.Controls.Add($setp)

$sTitle = New-Object System.Windows.Forms.Label
$sTitle.Text = 'Settings'
$sTitle.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$sTitle.AutoSize = $true
$sTitle.Location = New-Object System.Drawing.Point(20, 16)
$setp.Controls.Add($sTitle)

[void](New-Note $setp 'Type or paste straight into the boxes, then hit Save.' 22 56 580)

function New-Field($parent, $caption, $y) {
  $l = New-Object System.Windows.Forms.Label
  $l.Text = $caption
  $l.Location = New-Object System.Drawing.Point(20, $y)
  $l.Size = New-Object System.Drawing.Size(606, 20)
  $l.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $parent.Controls.Add($l)
  $tb = New-Object System.Windows.Forms.TextBox
  $tb.Location = New-Object System.Drawing.Point(20, ($y + 22))
  $tb.Size = New-Object System.Drawing.Size(606, 26)
  $tb.BackColor = [System.Drawing.Color]::FromArgb(38,39,44)
  $tb.ForeColor = [System.Drawing.Color]::White
  $tb.BorderStyle = 'FixedSingle'
  $parent.Controls.Add($tb)
  return $tb
}

$tbCookie = New-Field $setp 'Your Roblox login' 96
$tbCookie.UseSystemPasswordChar = $true
[void](New-Note $setp 'On roblox.com press F12, click Application, Cookies, .ROBLOSECURITY, copy it all, paste here.' 22 146 606)

$cbShow = New-Object System.Windows.Forms.CheckBox
$cbShow.Text = 'Show it'
$cbShow.Location = New-Object System.Drawing.Point(20, 168)
$cbShow.Size = New-Object System.Drawing.Size(120, 24)
$cbShow.ForeColor = [System.Drawing.Color]::Gainsboro
$setp.Controls.Add($cbShow)

$tbSilver = New-Field $setp 'Discord link for the Silver Wings group' 200
$tbGolden = New-Field $setp 'Discord link for the Golden Wings group' 274
[void](New-Note $setp 'In Discord: Server Settings, Integrations, Webhooks, Copy URL.' 22 324 606)

$tbPing = New-Field $setp 'Who to ping when someone shows up' 356
[void](New-Note $setp 'Your Discord user id, or @here, or leave it empty for no ping.' 22 406 606)

$btnSave = New-Btn $setp 'Save' 20 446 300 46
$btnSave.BackColor = $Green
$btnSave.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)

$btnSetBack = New-Btn $setp 'Back without saving' 336 446 290 46

$sMsg = New-Object System.Windows.Forms.Label
$sMsg.Location = New-Object System.Drawing.Point(20, 502)
$sMsg.Size = New-Object System.Drawing.Size(606, 24)
$sMsg.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$setp.Controls.Add($sMsg)

# ---------------------------------------------------------------------- logic

function Render {
  $panel.Controls.Clear()
  $checks = Run-Checks
  $hardFail = $false
  $nodeOk = $false
  foreach ($c in $checks) {
    if ($c.Name -eq 'The program that runs it' -and $c.Status -eq 'PASS') { $nodeOk = $true }
    $row = New-Object System.Windows.Forms.Label
    $row.AutoSize = $true
    $row.MaximumSize = New-Object System.Drawing.Size(570, 0)
    $icon = switch ($c.Status) { 'PASS' { [char]0x2713 } 'WARN' { [char]0x26A0 } default { [char]0x2717 } }
    $row.Text = ("{0}  {1}: {2}" -f $icon, $c.Name, $c.Detail)
    $row.ForeColor = switch ($c.Status) {
      'PASS' { [System.Drawing.Color]::FromArgb(90,220,130) }
      'WARN' { [System.Drawing.Color]::FromArgb(240,190,70) }
      default { [System.Drawing.Color]::FromArgb(240,95,95) }
    }
    $row.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
    $row.Margin = New-Object System.Windows.Forms.Padding(8, 8, 6, 0)
    $panel.Controls.Add($row)
    if ($c.Status -ne 'PASS' -and $c.Fix) {
      $fix = New-Object System.Windows.Forms.Label
      $fix.AutoSize = $true
      $fix.MaximumSize = New-Object System.Drawing.Size(555, 0)
      $fix.Text = ("      {0}" -f $c.Fix)
      $fix.ForeColor = [System.Drawing.Color]::Gainsboro
      $fix.Margin = New-Object System.Windows.Forms.Padding(20, 2, 6, 6)
      $panel.Controls.Add($fix)
    }
    if ($c.Status -eq 'FAIL') { $hardFail = $true }
  }

  $ready = -not $hardFail
  $running = @(Get-WatcherProcs)
  $isOn = $running.Count -gt 0

  # One button. It says what it will do right now, and nothing else.
  # Readiness wins the headline: saying "switched on" over a list of red lines
  # just reads as a contradiction.
  if (-not $ready -and $isOn) {
    $status.Text = 'It is running, but something above needs fixing.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(240,190,70)
    $btnGo.Text = 'Stop watching'
    $btnGo.BackColor = $Red
    $btnGo.Enabled = $true
    $hint.Text = 'Fix the red lines.'
  } elseif ($isOn) {
    $status.Text = 'It is switched on and watching right now.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(90,220,130)
    $btnGo.Text = 'Stop watching'
    $btnGo.BackColor = $Red
    $btnGo.Enabled = $true
    $hint.Text = 'Leave it running.'
  } elseif ($ready) {
    $status.Text = 'Everything is ready.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(90,220,130)
    $btnGo.Text = 'Start watching'
    $btnGo.BackColor = $Green
    $btnGo.Enabled = $true
    $hint.Text = 'Click the green button.'
  } else {
    $status.Text = 'Not ready yet - the red lines above say what to do.'
    $status.ForeColor = [System.Drawing.Color]::FromArgb(240,95,95)
    $btnGo.Text = 'Start watching'
    $btnGo.BackColor = $Dim
    $btnGo.Enabled = $false
    $hint.Text = 'Fix the red lines first.'
  }

  # The blue button only exists when there is something it can fix.
  $envMissing = -not (Test-Path (Join-Path $Root '.env'))
  $cookieMissing = -not (Get-EnvVal 'ROBLOX_COOKIE')
  $watchersMissing = -not (Test-Path (Join-Path $Root 'watchers.json'))
  $showFix = $true
  if ($envMissing) {
    $btnFix.Text = 'Make my settings for me'
    $btnFix.Tag = 'makeenv'
  } elseif ($cookieMissing) {
    $btnFix.Text = 'Open my settings so I can paste my Roblox login'
    $btnFix.Tag = 'openenv'
  } elseif ($watchersMissing) {
    $btnFix.Text = 'Set up the default groups for me'
    $btnFix.Tag = 'makewatchers'
  } else {
    $showFix = $false
  }
  $btnFix.Visible = $showFix

  # With no blue button there is a hole in the middle, so let the list fill it.
  # Note: read $showFix, not $btnFix.Visible - the getter reports false until the
  # form itself has been shown, which threw the very first layout out.
  if ($showFix) {
    $panel.Height = 324
    $status.Top = 422
    $btnFix.Top = 464
  } else {
    $panel.Height = 370
    $status.Top = 468
  }

  $btnDash.Enabled = $nodeOk
  $btnOnce.Enabled = $ready
}

function Show-Settings {
  $tbCookie.Text = [string](Get-EnvVal 'ROBLOX_COOKIE')
  $tbSilver.Text = [string](Get-EnvVal 'DISCORD_WEBHOOK_SILVER_WINGS')
  $tbGolden.Text = [string](Get-EnvVal 'DISCORD_WEBHOOK_GOLDEN_WINGS')
  $tbPing.Text   = [string](Get-EnvVal 'DISCORD_PING')
  $sMsg.Text = ''
  $main.Visible = $false
  $more.Visible = $false
  $setp.Visible = $true
}

$btnAgain.Add_Click({ Render })
$btnClose.Add_Click({ $form.Close() })
$btnMore.Add_Click({ $main.Visible = $false; $more.Visible = $true })
$btnBack.Add_Click({ $more.Visible = $false; $main.Visible = $true; Render })

$cbShow.Add_CheckedChanged({ $tbCookie.UseSystemPasswordChar = -not $cbShow.Checked })
$btnEnv.Add_Click({ Show-Settings })
$btnSetBack.Add_Click({ $setp.Visible = $false; $main.Visible = $true; Render })

$btnSave.Add_Click({
  try {
    Set-EnvVals @{
      'ROBLOX_COOKIE'                = $tbCookie.Text.Trim()
      'DISCORD_WEBHOOK_SILVER_WINGS' = $tbSilver.Text.Trim()
      'DISCORD_WEBHOOK_GOLDEN_WINGS' = $tbGolden.Text.Trim()
      'DISCORD_PING'                 = $tbPing.Text.Trim()
    }
  } catch {
    $sMsg.Text = 'Could not save: ' + $_.Exception.Message
    $sMsg.ForeColor = [System.Drawing.Color]::FromArgb(240,95,95)
    return
  }
  $sMsg.Text = 'Saved.'
  $sMsg.ForeColor = [System.Drawing.Color]::FromArgb(90,220,130)
  if (@(Get-WatcherProcs).Count -gt 0) {
    [System.Windows.Forms.MessageBox]::Show(
      'Saved. It is running right now with the old settings - stop it and start it again for these to take effect.',
      'Saved') | Out-Null
  }
  # Drop back to the main screen so they can see it go green and hit Start.
  $setp.Visible = $false
  $main.Visible = $true
  Render
})

$btnGo.Add_Click({
  $running = @(Get-WatcherProcs)
  if ($running.Count -gt 0) {
    $ans = [System.Windows.Forms.MessageBox]::Show(
      'Stop watching? You will not get any more Discord alerts until you start it again.',
      'Stop watching', 'YesNo', 'Warning')
    if ($ans -ne 'Yes') { return }
    foreach ($p in $running) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch {} }
    Start-Sleep -Milliseconds 600
  } else {
    Start-Watcher
    Start-Sleep -Milliseconds 900
  }
  Render
})

$btnFix.Add_Click({
  switch ($btnFix.Tag) {
    'makeenv'  { Show-Settings; return }
    'openenv'  { Show-Settings; return }
    'makewatchers' {
      $ex = Join-Path $Root 'watchers.example.json'
      if (-not (Test-Path $ex)) {
        [System.Windows.Forms.MessageBox]::Show('The example file is missing, so this cannot set up the groups. Try downloading the project again.', 'Cannot do that') | Out-Null
        return
      }
      Copy-Item -LiteralPath $ex -Destination (Join-Path $Root 'watchers.json')
      [System.Windows.Forms.MessageBox]::Show('Done - the two default groups are set up.', 'Sorted') | Out-Null
    }
  }
  Render
})

$btnOnce.Add_Click({ Start-Node 'src\index.js --once' })
$btnDash.Add_Click({ Start-Node 'src\ui.js' })
$btnLog.Add_Click({
  $log = Join-Path $Root 'watcher.log'
  if (Test-Path $log) { Start-Process notepad.exe $log }
  else { [System.Windows.Forms.MessageBox]::Show('Nothing here yet - this fills up once it has been watching for a bit.', 'Nothing to show') | Out-Null }
})
$btnDir.Add_Click({ Start-Process explorer.exe $Root })

Render
[void]$form.ShowDialog()
