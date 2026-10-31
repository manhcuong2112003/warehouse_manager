param([string]$SettingsPath)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Backup-Paths.ps1')
$root=Split-Path -Parent $PSScriptRoot
$SettingsPath=Resolve-BackupSettingsFile -ProjectRoot $root -Value $SettingsPath
if (![IO.File]::Exists($SettingsPath)) { throw 'Mở công cụ cấu hình và chọn thư mục backup trước.' }
$settings=[IO.File]::ReadAllText($SettingsPath,[Text.Encoding]::UTF8) | ConvertFrom-Json
$settings.directory=Resolve-BackupFolder -Value $settings.directory
$resultPath=Join-Path ([IO.Path]::GetDirectoryName($SettingsPath)) 'backup-last.json'
try {
    $file=& (Join-Path $root 'scripts\backup.ps1') -Profile $settings.profile -BackupDirectory $settings.directory
    $result=[ordered]@{status='COMPLETED';at=[DateTime]::UtcNow.ToString('o');file=($file | Select-Object -Last 1);directory=$settings.directory}
    [IO.File]::WriteAllText($resultPath,($result | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
} catch {
    $result=[ordered]@{status='FAILED';at=[DateTime]::UtcNow.ToString('o');message=$_.Exception.Message;directory=$settings.directory}
    [IO.File]::WriteAllText($resultPath,($result | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    throw
}
