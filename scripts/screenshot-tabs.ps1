Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$OutDir = Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')) '验收截图'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$proc = $null
$deadline = (Get-Date).AddSeconds(30)
do {
  $proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*发布助手*' } | Select-Object -First 1
  if (-not $proc) { Start-Sleep -Milliseconds 500 }
} while (-not $proc -and (Get-Date) -lt $deadline)
if (-not $proc) { throw '未找到助手窗口' }

$h = $proc.MainWindowHandle
[Win32]::ShowWindow($h, 9) | Out-Null
[Win32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 800

$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)

function Select-Tab([string]$Name) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
  $tabs = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($t in $tabs) {
    if ($t.Current.Name -eq $Name) {
      $t.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
      return $true
    }
  }
  return $false
}

function Capture([string]$File) {
  [Win32]::SetForegroundWindow($h) | Out-Null
  Start-Sleep -Milliseconds 1200
  $r = New-Object Win32+RECT
  [Win32]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left; $hh = $r.Bottom - $r.Top
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $OutDir $File), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

foreach ($tab in @(@('首页','助手-首页.png'), @('平台账号','助手-账号页.png'), @('发布任务','助手-任务页.png'))) {
  if (-not (Select-Tab $tab[0])) { throw "未找到选项卡：$($tab[0])" }
  Capture $tab[1]
  Write-Output "saved: $($tab[1])"
}
