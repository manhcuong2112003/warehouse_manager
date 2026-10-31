param([switch]$Check,[string]$SettingsPath,[string]$TestDirectory)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Backup-Paths.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$root=Split-Path -Parent $PSScriptRoot
$script:backupSettingsFile=Resolve-BackupSettingsFile -ProjectRoot $root -Value $SettingsPath
$script:backupRunnerFile=Join-Path $PSScriptRoot 'Run-ConfiguredBackup.ps1'
$script:backupResultFile=Join-Path ([IO.Path]::GetDirectoryName($script:backupSettingsFile)) 'backup-last.json'
$script:backupErrorFile=Join-Path $root 'deploy\backup-tool-error.log'
$script:startupError=$null
$saved=$null
if ([IO.File]::Exists($script:backupSettingsFile)) {
    try { $saved=[IO.File]::ReadAllText($script:backupSettingsFile,[Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { $script:startupError='Không đọc được cấu hình đã lưu. Chọn lại thư mục và lưu cấu hình.' }
}
$form=New-Object Windows.Forms.Form
$form.Text='Kho Vật Tư - Cấu hình sao lưu trên máy chủ'
$form.Size=New-Object Drawing.Size(680,440)
$form.StartPosition='CenterScreen'
$form.FormBorderStyle='FixedDialog'
$form.MaximizeBox=$false
$form.Font=New-Object Drawing.Font('Segoe UI',10)
function Label($text,$x,$y,$width=600) {
    $label=New-Object Windows.Forms.Label
    $label.Text=$text; $label.Location=New-Object Drawing.Point($x,$y); $label.Size=New-Object Drawing.Size($width,28)
    $form.Controls.Add($label)
    return $label
}
$null=Label 'Chọn thư mục trên máy chủ kho hoặc đường dẫn NAS mà tài khoản này truy cập được.' 24 20
$null=Label 'Thư mục lưu backup' 24 61
$folder=New-Object Windows.Forms.TextBox
$folder.Location=New-Object Drawing.Point(24,92);$folder.Size=New-Object Drawing.Size(450,30)
if ($saved) { $folder.Text=$saved.directory }
$form.Controls.Add($folder)
$browse=New-Object Windows.Forms.Button
$browse.Text='Chọn / tạo thư mục...';$browse.Location=New-Object Drawing.Point(486,90);$browse.Size=New-Object Drawing.Size(150,32)
$form.Controls.Add($browse)
$browseAction={
    $dialog=New-Object Windows.Forms.FolderBrowserDialog
    try {
        $dialog.Description='Chọn nơi lưu bản sao lưu. Có thể tạo thư mục mới bằng nút New Folder.'
        $dialog.ShowNewFolderButton=$true
        $initialPath=$folder.Text
        if (Test-BackupFolderExists -Value $initialPath) { $dialog.SelectedPath=$initialPath.Trim() }
        if ($Check) { return } # Regression checks exercise blank initial paths without opening a modal.
        if ($dialog.ShowDialog($form) -eq [Windows.Forms.DialogResult]::OK -and ![string]::IsNullOrWhiteSpace($dialog.SelectedPath)) { $folder.Text=$dialog.SelectedPath }
    } finally { $dialog.Dispose() }
}
$browse.Add_Click({ Invoke-BackupUiAction -Operation 'Chọn thư mục' -Action $browseAction })
$null=Label 'Môi trường cần sao lưu' 24 143 250
$profile=New-Object Windows.Forms.ComboBox
$profile.DropDownStyle='DropDownList';$profile.Location=New-Object Drawing.Point(24,176);$profile.Size=New-Object Drawing.Size(280,30)
$null=$profile.Items.Add('LAN HTTPS - kho làm việc')
$null=$profile.Items.Add('Local dev - dữ liệu phát triển')
$profile.SelectedIndex=if ($saved -and $saved.profile -eq 'local') {1} else {0}
$form.Controls.Add($profile)
$daily=New-Object Windows.Forms.CheckBox
$daily.Text='Sao lưu hằng ngày lúc';$daily.Location=New-Object Drawing.Point(336,173);$daily.Size=New-Object Drawing.Size(185,30)
$daily.Checked=if ($saved) {[bool]$saved.daily} else {$true}
$form.Controls.Add($daily)
$time=New-Object Windows.Forms.DateTimePicker
$time.Format='Custom';$time.CustomFormat='HH:mm';$time.ShowUpDown=$true;$time.Location=New-Object Drawing.Point(526,175);$time.Size=New-Object Drawing.Size(110,28)
$time.Value=[DateTime]::Today.AddHours(2)
if ($saved -and $saved.time) {
    try { $time.Value=[DateTime]::Today.Add([TimeSpan]::Parse($saved.time)) }
    catch { $script:startupError='Giờ sao lưu đã lưu không hợp lệ. Chọn lại giờ và lưu cấu hình.' }
}
$form.Controls.Add($time)
$note=Label 'Lịch chạy bằng tài khoản Windows hiện tại khi đang đăng nhập. Tài khoản cần quyền đọc kho và ghi thư mục đã chọn.' 24 220
$note.Size=New-Object Drawing.Size(610,45)
$status=Label 'Chưa lưu lựa chọn. Thư mục chưa tồn tại sẽ được tạo khi lưu.' 24 274
$status.ForeColor=[Drawing.Color]::FromArgb(45,105,125)
$status.Size=New-Object Drawing.Size(610,45)
if ($script:startupError) { $status.Text=$script:startupError }
$save=New-Object Windows.Forms.Button
$save.Text='Lưu cấu hình và lịch';$save.Location=New-Object Drawing.Point(24,332);$save.Size=New-Object Drawing.Size(200,38)
$save.BackColor=[Drawing.Color]::FromArgb(23,107,128);$save.ForeColor=[Drawing.Color]::White;$save.FlatStyle='Flat'
$form.Controls.Add($save)
$backup=New-Object Windows.Forms.Button
$backup.Text='Backup ngay';$backup.Location=New-Object Drawing.Point(240,332);$backup.Size=New-Object Drawing.Size(170,38)
$form.Controls.Add($backup)
$open=New-Object Windows.Forms.Button
$open.Text='Mở thư mục';$open.Location=New-Object Drawing.Point(426,332);$open.Size=New-Object Drawing.Size(170,38)
$form.Controls.Add($open)
$taskName='QuanLyKho-Backup-'+([BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($root))).Replace('-','').Substring(0,12))
function Invoke-BackupUiAction {
    param([string]$Operation,[scriptblock]$Action)
    try { & $Action }
    catch {
        $status.Text=$Operation+': '+$_.Exception.Message
        try {
            $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:backupErrorFile))
            $details=[DateTime]::UtcNow.ToString('o')+' '+$Operation+': '+$_+"`r`n"+$_.ScriptStackTrace+"`r`n"
            [IO.File]::AppendAllText($script:backupErrorFile,$details,[Text.UTF8Encoding]::new($false))
        } catch { } # Logging must never turn a handled UI error into another exception.
    }
}
function Save-Selection {
    $directory=Resolve-BackupFolder -Value $folder.Text
    $null=[IO.Directory]::CreateDirectory($directory)
    $probe=Join-Path $directory ('.wms-write-test-'+[Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($probe,'test')
    [IO.File]::Delete($probe)
    $settings=[ordered]@{version=1;directory=$directory;profile=$(if ($profile.SelectedIndex -eq 0) {'lan'} else {'local'});daily=$daily.Checked;time=$time.Value.ToString('HH:mm');taskName=$taskName}
    $null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:backupSettingsFile))
    [IO.File]::WriteAllText($script:backupSettingsFile,($settings | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    return $settings
}
$saveAction={
    try {
        $settings=Save-Selection
        if ($settings.daily) {
            $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script:backupRunnerFile+'" -SettingsPath "'+$script:backupSettingsFile+'"'
            $action=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
            $trigger=New-ScheduledTaskTrigger -Daily -At $settings.time
            $options=New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 15)
            $null=Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $options -User ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -RunLevel Limited -Force
            $status.Text='Đã lưu thư mục và lịch '+$settings.time+'. Có thể chạy Backup ngay để kiểm tra.'
        } else {
            if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { $null=Disable-ScheduledTask -TaskName $taskName }
            $status.Text='Đã lưu thư mục; lịch tự động đang tắt.'
        }
    } catch { $status.Text='Chưa hoàn tất: '+$_.Exception.Message }
}
$save.Add_Click({ Invoke-BackupUiAction -Operation 'Lưu cấu hình' -Action $saveAction })
$backupAction={
    try {
        $null=Save-Selection
        $arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script:backupRunnerFile+'" -SettingsPath "'+$script:backupSettingsFile+'"'
        $script:backupStarted=[DateTime]::UtcNow
        $script:backupProcess=Start-Process -FilePath 'powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru
        $backup.Enabled=$false
        $status.Text='Đang sao lưu vào thư mục đã chọn...'
    } catch { $status.Text='Không chạy được backup: '+$_.Exception.Message }
}
$backup.Add_Click({ Invoke-BackupUiAction -Operation 'Sao lưu' -Action $backupAction })
$openAction={
    if (!(Test-BackupFolderExists -Value $folder.Text)) { $status.Text='Chọn hoặc tạo thư mục trước.';return }
    $directory=Resolve-BackupFolder -Value $folder.Text
    Start-Process -FilePath 'explorer.exe' -ArgumentList ('"'+$directory+'"')
}
$open.Add_Click({ Invoke-BackupUiAction -Operation 'Mở thư mục' -Action $openAction })
$script:backupProcess=$null
$timer=New-Object Windows.Forms.Timer
$timer.Interval=1000
$timerAction={
    if ($script:backupProcess -and $script:backupProcess.HasExited) {
        $backup.Enabled=$true
        $resultFile=$script:backupResultFile
        try {
            if ($script:backupProcess.ExitCode -ne 0 -or ![IO.File]::Exists($resultFile)) { throw 'Không hoàn tất sao lưu. Kiểm tra Docker và quyền ghi thư mục rồi thử lại.' }
            $result=[IO.File]::ReadAllText($resultFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
            if ($result.status -ne 'COMPLETED' -or [DateTime]::Parse($result.at).ToUniversalTime() -lt $script:backupStarted) { throw 'Sao lưu chưa thành công. Kiểm tra thư mục và thử lại.' }
            $status.Text='Đã sao lưu thành công: '+[IO.Path]::GetFileName($result.file)
        } catch { $status.Text=$_.Exception.Message }
        $script:backupProcess.Dispose();$script:backupProcess=$null
    }
}
$timer.Add_Tick({ Invoke-BackupUiAction -Operation 'Đọc kết quả sao lưu' -Action $timerAction })
if ($Check) {
    foreach ($empty in @('', '   ')) {
        $folder.Text=$empty
        & $browseAction
        & $openAction
        if ($status.Text -ne 'Chọn hoặc tạo thư mục trước.') { throw 'Blank Open folder regression' }
        & $saveAction
        if ($status.Text -notlike '*Chọn thư mục sao lưu*') { throw 'Blank Save regression' }
        & $backupAction
        if ($status.Text -notlike '*Chọn thư mục sao lưu*') { throw 'Blank Backup regression' }
    }
    Write-Output 'PASS blank/whitespace Browse, Open, Save and Backup actions do not throw.'
    if ($TestDirectory) { $folder.Text=$TestDirectory;$daily.Checked=$false;$result=Save-Selection;if (![IO.Directory]::Exists($result.directory)) { throw 'Folder creation failed' };Write-Output 'PASS selected folder created and settings saved.' }
    $timer.Dispose();$form.Dispose();Write-Output 'Backup configuration dialog constructed successfully.';exit 0
}
$timer.Start()
$null=$form.ShowDialog()
$timer.Stop();$timer.Dispose()
$form.Dispose()
