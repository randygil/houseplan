# Tray icon that runs sync.mjs a few times a day, like a person checking the bank:
# 3 runs at random times between 08:00 and 22:00, only when the PC has been idle for a few minutes
# (the Chrome window is off-screen, but its taskbar button still flashes for ~1 min).
# Any failure pauses the schedule until "Sincronizar ahora" is clicked: never retry a bank login on our own.
# Start: powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tray.ps1
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class Idle {
  [StructLayout(LayoutKind.Sequential)] struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LII p);
  public static double Minutes() { var l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return (Environment.TickCount - (int)l.dwTime) / 60000.0; }
}
'@

$dir = $PSScriptRoot
$log = Join-Path $dir 'sync.log'
$runsPerDay = 3; $from = 8; $to = 22; $idleMin = 3

function Slots([datetime]$day) {
  # One random time inside each equal share of the waking window, so runs don't bunch up.
  $share = ($to - $from) * 60 / $runsPerDay
  0..($runsPerDay - 1) | ForEach-Object { $day.Date.AddHours($from).AddMinutes($_ * $share + (Get-Random -Maximum ([int]$share - 20))) }
}
function NextSlot {
  $now = Get-Date
  $next = (Slots $now) + (Slots $now.AddDays(1)) | Where-Object { $_ -gt $now } | Select-Object -First 1
  return $next
}

$script:next = NextSlot
$script:paused = $false
$script:proc = $null

$icon = New-Object System.Windows.Forms.NotifyIcon
$icon.Icon = [System.Drawing.SystemIcons]::Shield
$icon.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$status = $menu.Items.Add('...'); $status.Enabled = $false
$syncNow = $menu.Items.Add('Sincronizar ahora')
$quit = $menu.Items.Add('Salir')
$icon.ContextMenuStrip = $menu

function Refresh {
  $s = if ($script:proc) { 'Consultando BDV…' } elseif ($script:paused) { 'Pausado por un error' } else { 'Próxima: ' + $script:next.ToString('ddd HH:mm') }
  $status.Text = $s; $icon.Text = "BDV → Plata: $s"
}

function Start-Sync {
  if ($script:proc) { return }
  $script:out = Join-Path $env:TEMP 'plata-bdv-out.txt'
  $script:proc = Start-Process node -ArgumentList '--env-file=.env', 'sync.mjs' -WorkingDirectory $dir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $script:out -RedirectStandardError "$($script:out).err"
  $null = $script:proc.Handle  # without touching Handle, ExitCode stays empty after exit
  Refresh
}

$syncNow.add_Click({ $script:paused = $false; Start-Sync })
$quit.add_Click({ $icon.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30000
$timer.add_Tick({
  if ($script:proc) {
    if (-not $script:proc.HasExited) { return }
    $code = $script:proc.ExitCode
    $text = (Get-Content $script:out -Raw -ErrorAction SilentlyContinue) + (Get-Content "$($script:out).err" -Raw -ErrorAction SilentlyContinue)
    Add-Content $log ("{0} exit={1} {2}" -f (Get-Date -Format s), $code, ($text -replace '\s+', ' '))
    $script:proc = $null
    if ($code -ne 0) {
      $script:paused = $true
      $icon.ShowBalloonTip(10000, 'BDV', 'La consulta falló; pausé las automáticas. Detalle en sync.log', 'Warning')
    }
    $script:next = NextSlot
  } elseif (-not $script:paused -and (Get-Date) -ge $script:next) {
    $late = ((Get-Date) - $script:next).TotalHours
    if ([Idle]::Minutes() -ge $idleMin) { Start-Sync }
    elseif ($late -gt 3) { $script:next = NextSlot }  # never idle in this share of the day: skip it
  }
  Refresh
})
$timer.Start()
Refresh
[System.Windows.Forms.Application]::Run()
