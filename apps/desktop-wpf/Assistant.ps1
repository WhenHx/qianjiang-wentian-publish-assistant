param([string]$Config = 'config\assistant.development.json')

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$ScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptRoot '..\..')
$ConfigRelPath = $Config
$ConfigPath = if ([IO.Path]::IsPathRooted($ConfigRelPath)) { $ConfigRelPath } else { Join-Path $RepoRoot $ConfigRelPath }
$ConfigObj = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$DataDir = if ([IO.Path]::IsPathRooted($ConfigObj.dataDir)) { $ConfigObj.dataDir } else { Join-Path $RepoRoot $ConfigObj.dataDir }
$RuntimePath = Join-Path $DataDir 'runtime.json'

function Start-AssistantCore {
  if (Test-Path $RuntimePath) {
    try {
      $runtime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
      $null = Invoke-RestMethod -Uri "http://$($runtime.host):$($runtime.port)/local/v1/status" -Headers @{ Authorization = "Bearer $($runtime.token)" } -TimeoutSec 2
      return
    } catch {}
  }
  Start-Process -FilePath 'node.exe' -ArgumentList @('src/assistant/main.js','--config',$ConfigRelPath) -WorkingDirectory $RepoRoot -WindowStyle Hidden
  $deadline = (Get-Date).AddSeconds(15)
  do {
    Start-Sleep -Milliseconds 500
    if (Test-Path $RuntimePath) {
      try {
        $runtime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $null = Invoke-RestMethod -Uri "http://$($runtime.host):$($runtime.port)/local/v1/status" -Headers @{ Authorization = "Bearer $($runtime.token)" } -TimeoutSec 2
        return
      } catch {}
    }
  } while ((Get-Date) -lt $deadline)
  throw '助手核心启动超时'
}

Start-AssistantCore
$Runtime = Get-Content -LiteralPath $RuntimePath -Raw -Encoding UTF8 | ConvertFrom-Json
$Base = "http://$($Runtime.host):$($Runtime.port)"
$Headers = @{ Authorization = "Bearer $($Runtime.token)" }

function Invoke-LocalApi([string]$Path, [string]$Method = 'GET', $Body = $null) {
  $params = @{ Uri = "$Base$Path"; Method = $Method; Headers = $Headers; TimeoutSec = 30 }
  if ($null -ne $Body) { $params.ContentType = 'application/json'; $params.Body = ($Body | ConvertTo-Json -Depth 20) }
  Invoke-RestMethod @params
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="千匠问天 Windows 发布助手 - 测试版" Width="1100" Height="720" WindowStartupLocation="CenterScreen">
  <Grid>
    <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
    <Border Grid.Row="0" Background="#8A1F11" Padding="10"><TextBlock Name="ModeBanner" Foreground="White" FontWeight="Bold" Text="模拟模式：仅用于本地联调，不代表真实发布成功"/></Border>
    <TabControl Grid.Row="1" Margin="10">
      <TabItem Header="首页">
        <StackPanel Margin="12">
          <TextBlock FontSize="20" FontWeight="Bold" Text="设备与运行状态"/>
          <TextBox Name="StatusText" Margin="0,10" TextWrapping="Wrap" IsReadOnly="True" MinHeight="220" VerticalScrollBarVisibility="Auto"/>
          <StackPanel Orientation="Horizontal">
            <TextBox Name="DeviceName" Width="260" Margin="0,0,8,0" ToolTip="设备名称"/>
            <Button Name="RequestBinding" Content="申请绑定" Width="100" Margin="0,0,8,0"/>
            <Button Name="PollBinding" Content="轮询绑定结果" Width="120" Margin="0,0,8,0"/>
            <Button Name="RefreshStatus" Content="刷新状态" Width="100"/>
          </StackPanel>
          <TextBlock Margin="0,12,0,0" Text="绑定流程：申请绑定后，到模拟控制台输入绑定 ID 和绑定码确认，然后回到这里轮询绑定结果。" TextWrapping="Wrap"/>
        </StackPanel>
      </TabItem>
      <TabItem Header="平台账号">
        <Grid Margin="12">
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <StackPanel Orientation="Horizontal" Margin="0,0,0,8">
            <ComboBox Name="Platform" Width="120" Margin="0,0,8,0">
              <ComboBoxItem Content="douyin" IsSelected="True"/><ComboBoxItem Content="shipinhao"/><ComboBoxItem Content="kuaishou"/><ComboBoxItem Content="xiaohongshu"/>
            </ComboBox>
            <TextBox Name="Nickname" Width="220" Margin="0,0,8,0" ToolTip="账号备注昵称"/>
            <Button Name="AddAccount" Content="添加账号" Width="90" Margin="0,0,8,0"/>
            <Button Name="SyncAccounts" Content="同步账号" Width="90"/>
          </StackPanel>
          <ListBox Name="AccountsList" Grid.Row="1"/>
          <StackPanel Grid.Row="2" Orientation="Horizontal" Margin="0,8,0,0">
            <TextBox Name="AccountKey" Width="300" Margin="0,0,8,0" ToolTip="account_key"/>
            <Button Name="LoginAccount" Content="打开登录窗口" Width="110" Margin="0,0,8,0"/>
            <Button Name="CheckAccount" Content="检查登录状态" Width="120" Margin="0,0,8,0"/>
            <Button Name="DeleteAccount" Content="删除本机账号" Width="120"/>
          </StackPanel>
        </Grid>
      </TabItem>
      <TabItem Header="发布任务">
        <Grid Margin="12">
          <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
          <ListBox Name="TasksList"/>
          <StackPanel Grid.Row="1" Orientation="Horizontal" Margin="0,8,0,0">
            <TextBox Name="TaskId" Width="360" Margin="0,0,8,0" ToolTip="task_id"/>
            <Button Name="RefreshTasks" Content="刷新任务" Width="90" Margin="0,0,8,0"/>
            <Button Name="ContinueTask" Content="接管后继续" Width="110" Margin="0,0,8,0"/>
            <Button Name="SubmitTask" Content="执行一次提交" Width="120" Margin="0,0,8,0"/>
            <Button Name="CancelLocalTask" Content="关闭本地接管" Width="120"/>
          </StackPanel>
        </Grid>
      </TabItem>
      <TabItem Header="设置">
        <StackPanel Margin="12">
          <TextBlock FontSize="18" FontWeight="Bold" Text="设置与诊断"/>
          <TextBox Name="SettingsText" Margin="0,10" MinHeight="220" IsReadOnly="True" TextWrapping="Wrap" VerticalScrollBarVisibility="Auto"/>
          <StackPanel Orientation="Horizontal">
            <Button Name="RefreshSettings" Content="刷新设置" Width="100" Margin="0,0,8,0"/>
            <Button Name="ClearCache" Content="清理下载缓存" Width="120" Margin="0,0,8,0"/>
            <Button Name="ExportLogs" Content="导出脱敏日志" Width="120"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
            <Button Name="EnableAutostart" Content="启用开机自启动" Width="130" Margin="0,0,8,0"/>
            <Button Name="DisableAutostart" Content="关闭开机自启动" Width="130"/>
          </StackPanel>
          <TextBlock Margin="0,12,0,0" Text="开机自启动写入当前用户的 HKCU Run 注册表项，登录后自动启动助手（托盘常驻）。" TextWrapping="Wrap"/>
        </StackPanel>
      </TabItem>
    </TabControl>
    <StatusBar Grid.Row="2"><StatusBarItem><TextBlock Name="Footer" Text="就绪"/></StatusBarItem></StatusBar>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$Window = [Windows.Markup.XamlReader]::Load($reader)
$controls = @{}
foreach ($node in $xaml.SelectNodes('//*[@Name]')) { $controls[$node.Name] = $Window.FindName($node.Name) }
$controls.DeviceName.Text = $env:COMPUTERNAME

function Set-Footer([string]$Text) { $controls.Footer.Text = "$(Get-Date -Format 'HH:mm:ss')  $Text" }
function Show-Error($ErrorRecord) { [System.Windows.MessageBox]::Show($ErrorRecord.Exception.Message, '操作失败', 'OK', 'Warning') | Out-Null; Set-Footer $ErrorRecord.Exception.Message }
function JsonText($Value) { $Value | ConvertTo-Json -Depth 12 }

function Refresh-Status {
  try {
    $status = Invoke-LocalApi '/local/v1/status'
    $controls.StatusText.Text = JsonText $status
    $submitLabel = if ($status.submit_mode -eq 'auto') { '正式模式：网页确认后自动提交' } else { '测试模式：停在提交前需手动确认' }
    $controls.ModeBanner.Text = (if ($status.simulation) { '模拟模式：仅用于本地联调，不代表真实发布成功' } else { '生产模式：请确认服务地址和账号授权' }) + ' ｜ ' + $submitLabel
    Set-Footer '状态已刷新'
  } catch { Show-Error $_ }
}

function Refresh-Accounts {
  try {
    $accounts = Invoke-LocalApi '/local/v1/accounts'
    $controls.AccountsList.Items.Clear()
    foreach ($a in $accounts.accounts) {
      $text = "$($a.platform) | $($a.nickname) | $($a.status) | $($a.account_key) | cloud=$($a.cloud_account_id) | 最后检查=$($a.last_check_at)"
      $controls.AccountsList.Items.Add($text) | Out-Null
    }
    Set-Footer '账号已刷新'
  } catch { Show-Error $_ }
}

function Refresh-Tasks {
  try {
    $tasks = Invoke-LocalApi '/local/v1/tasks'
    $controls.TasksList.Items.Clear()
    foreach ($t in $tasks.tasks) {
      $text = "$($t.task_id) | $($t.platform) | $($t.status) | $($t.progress)% | $($t.last_error.message)"
      $controls.TasksList.Items.Add($text) | Out-Null
    }
    Set-Footer '任务已刷新'
  } catch { Show-Error $_ }
}

function Refresh-Settings {
  try { $controls.SettingsText.Text = JsonText (Invoke-LocalApi '/local/v1/settings'); Set-Footer '设置已刷新' } catch { Show-Error $_ }
}

$controls.RefreshStatus.Add_Click({ Refresh-Status })
$controls.RequestBinding.Add_Click({
  try {
    $binding = Invoke-LocalApi '/local/v1/bindings' 'POST' @{ device_name = $controls.DeviceName.Text }
    [System.Windows.MessageBox]::Show("请在模拟控制台确认绑定：`n绑定 ID：$($binding.binding_id)`n绑定码：$($binding.code)`n确认地址：$($binding.confirm_url)", '绑定申请已创建') | Out-Null
    Refresh-Status
  } catch { Show-Error $_ }
})
$controls.PollBinding.Add_Click({
  try { $result = Invoke-LocalApi '/local/v1/bindings/poll' 'POST' @{}; [System.Windows.MessageBox]::Show((JsonText $result), '绑定轮询结果') | Out-Null; Refresh-Status } catch { Show-Error $_ }
})
$controls.AddAccount.Add_Click({
  try { $platform = ($controls.Platform.SelectedItem).Content; $result = Invoke-LocalApi '/local/v1/accounts' 'POST' @{ platform = $platform; nickname = $controls.Nickname.Text }; [System.Windows.MessageBox]::Show((JsonText $result.account), '账号已添加') | Out-Null; Refresh-Accounts } catch { Show-Error $_ }
})
$controls.SyncAccounts.Add_Click({ try { Invoke-LocalApi '/local/v1/accounts/sync' 'POST' @{} | Out-Null; Refresh-Accounts } catch { Show-Error $_ } })
$controls.LoginAccount.Add_Click({ try { $result = Invoke-LocalApi "/local/v1/accounts/$($controls.AccountKey.Text)/login" 'POST' @{}; [System.Windows.MessageBox]::Show($result.message, '登录窗口') | Out-Null } catch { Show-Error $_ } })
$controls.CheckAccount.Add_Click({ try { $result = Invoke-LocalApi "/local/v1/accounts/$($controls.AccountKey.Text)/check" 'POST' @{}; [System.Windows.MessageBox]::Show((JsonText $result), '登录状态') | Out-Null; Refresh-Accounts } catch { Show-Error $_ } })
$controls.DeleteAccount.Add_Click({ try { Invoke-LocalApi "/local/v1/accounts/$($controls.AccountKey.Text)" 'DELETE' | Out-Null; Refresh-Accounts } catch { Show-Error $_ } })
$controls.RefreshTasks.Add_Click({ Refresh-Tasks })
$controls.ContinueTask.Add_Click({ try { [System.Windows.MessageBox]::Show((JsonText (Invoke-LocalApi "/local/v1/tasks/$($controls.TaskId.Text)/continue" 'POST' @{})), '继续结果') | Out-Null; Refresh-Tasks } catch { Show-Error $_ } })
$controls.SubmitTask.Add_Click({ try { [System.Windows.MessageBox]::Show((JsonText (Invoke-LocalApi "/local/v1/tasks/$($controls.TaskId.Text)/submit" 'POST' @{})), '单次提交结果') | Out-Null; Refresh-Tasks } catch { Show-Error $_ } })
$controls.CancelLocalTask.Add_Click({ try { Invoke-LocalApi "/local/v1/tasks/$($controls.TaskId.Text)/cancel-local" 'POST' @{} | Out-Null; Refresh-Tasks } catch { Show-Error $_ } })
$controls.RefreshSettings.Add_Click({ Refresh-Settings })
$controls.EnableAutostart.Add_Click({
  try {
    $cmd = "powershell.exe -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Config `"$ConfigRelPath`""
    Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'QianjiangWentianAssistant' -Value $cmd
    Set-Footer '已启用开机自启动（当前用户）'
  } catch { Show-Error $_ }
})
$controls.DisableAutostart.Add_Click({
  try {
    Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'QianjiangWentianAssistant' -ErrorAction SilentlyContinue
    Set-Footer '已关闭开机自启动'
  } catch { Show-Error $_ }
})
$controls.ClearCache.Add_Click({ try { Invoke-LocalApi '/local/v1/cache/clear' 'POST' @{} | Out-Null; Set-Footer '缓存已清理' } catch { Show-Error $_ } })
$controls.ExportLogs.Add_Click({
  try {
    $logs = Invoke-LocalApi '/local/v1/logs/export'
    $file = Join-Path $RepoRoot ("runtime\assistant-logs-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.txt')
    [IO.File]::WriteAllLines($file, [string[]]$logs.lines, [Text.Encoding]::UTF8)
    [System.Windows.MessageBox]::Show("已导出：$file", '日志导出') | Out-Null
  } catch { Show-Error $_ }
})

$Tray = New-Object System.Windows.Forms.NotifyIcon
$Tray.Icon = [System.Drawing.SystemIcons]::Application
$Tray.Text = '千匠问天发布助手'
$Tray.Visible = $true
$Menu = New-Object System.Windows.Forms.ContextMenuStrip
$Menu.Items.Add('查看状态').Add_Click({ $Window.Show(); $Window.WindowState = 'Normal'; $Window.Activate() })
$Menu.Items.Add('暂停领取新任务').Add_Click({
  try { Invoke-LocalApi '/local/v1/worker/pause' 'POST' @{} | Out-Null; $Tray.ShowBalloonTip(2000, '千匠问天发布助手', '已暂停领取新任务；进行中的任务不受影响。', 'Info') } catch { Show-Error $_ }
})
$Menu.Items.Add('恢复领取新任务').Add_Click({
  try { Invoke-LocalApi '/local/v1/worker/resume' 'POST' @{} | Out-Null; $Tray.ShowBalloonTip(2000, '千匠问天发布助手', '已恢复领取新任务。', 'Info') } catch { Show-Error $_ }
})
$Menu.Items.Add('退出').Add_Click({
  try {
    $st = Invoke-LocalApi '/local/v1/status'
    $busy = $st.worker.busy -or ($st.worker.held_tasks.Count -gt 0)
    if ($busy) {
      $answer = [System.Windows.MessageBox]::Show("当前有任务正在执行或等待处理：$([string]::Join('、', $st.worker.held_tasks))`n退出不会中断已在平台提交的流程，不明结果会保留为待核实。确认退出？", '退出确认', 'YesNo', 'Warning')
      if ($answer -ne 'Yes') { return }
    }
  } catch {}
  $Window.Tag = 'Exit'
  $Window.Close()
  $Tray.Visible = $false
  $Tray.Dispose()
  [System.Windows.Application]::Current.Shutdown()
})
$Tray.ContextMenuStrip = $Menu
$Tray.Add_DoubleClick({ $Window.Show(); $Window.WindowState = 'Normal'; $Window.Activate() })
$Window.Add_Closing({ param($sender,$e) if ($Window.Tag -ne 'Exit') { $e.Cancel = $true; $Window.Hide(); $Tray.ShowBalloonTip(2000, '千匠问天发布助手', '窗口已最小化到托盘，助手仍在运行。', 'Info') } })
$Window.Add_Closed({ $Tray.Visible = $false; $Tray.Dispose() })

$Timer = New-Object System.Windows.Threading.DispatcherTimer
$Timer.Interval = [TimeSpan]::FromSeconds(5)
$Timer.Add_Tick({ Refresh-Status; Refresh-Tasks })
$Timer.Start()

Refresh-Status; Refresh-Accounts; Refresh-Tasks; Refresh-Settings
$Tray.ShowBalloonTip(3000, '千匠问天发布助手', '助手已在后台运行，双击托盘图标查看状态。', 'Info')
$app = New-Object System.Windows.Application
$app.ShutdownMode = 'OnExplicitShutdown'
$app.Run() | Out-Null