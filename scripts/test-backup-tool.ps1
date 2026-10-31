$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'tools\Backup-Paths.ps1')
function Assert-True([bool]$Condition,[string]$Message) { if (!$Condition) { throw $Message } }

foreach ($value in @($null,'','   ')) {
    Assert-True (!(Test-BackupFolderExists -Value $value)) 'Empty folder should return false without binding errors.'
    $settings=Resolve-BackupSettingsFile -ProjectRoot $root -Value $value
    Assert-True ($settings -eq (Join-Path $root 'deploy\backup-settings.json')) 'Blank settings path should resolve to an absolute default.'
    $failed=$false
    try { $null=Resolve-BackupFolder -Value $value } catch {
        $failed=$true
        Assert-True ($_.Exception.Message -like '*Chọn thư mục sao lưu*') 'Empty destination must produce a useful validation message.'
    }
    Assert-True $failed 'Blank destination should not be accepted.'
}
Write-Output 'PASS null, empty and whitespace folder/settings values.'

foreach ($value in @('relative','C:relative','\relative','\\NAS')) {
    $failed=$false
    try { $null=Resolve-BackupFolder -Value $value } catch { $failed=$true }
    Assert-True $failed 'Ambiguous relative or incomplete UNC folder should not be accepted.'
}
Assert-True ((Resolve-BackupFolder -Value '\\NAS\WMS') -eq '\\NAS\WMS') 'Full UNC target should remain valid.'
Write-Output 'PASS full drive/UNC path validation.'

$relative='test-results\backup-tool-regression\'+[Guid]::NewGuid().ToString('N')+'\settings.json'
$settingsFile=Resolve-BackupSettingsFile -ProjectRoot $root -Value $relative
$directory=Join-Path ([IO.Path]::GetDirectoryName($settingsFile)) 'thư mục backup tự chọn'
& powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $root 'tools\Configure-Backup.ps1') -Check -SettingsPath $relative -TestDirectory $directory
if ($LASTEXITCODE) { throw 'Windows PowerShell 5.1 dialog regression check failed.' }
Assert-True ([IO.File]::Exists($settingsFile)) 'Relative settings file must be saved under the project with a nonempty parent.'
$saved=[IO.File]::ReadAllText($settingsFile,[Text.Encoding]::UTF8) | ConvertFrom-Json
Assert-True ($saved.directory -eq $directory) 'Selected Unicode path must survive the JSON roundtrip.'
Write-Output 'PASS relative settings path, folder creation and Unicode persistence.'

# Existing incomplete settings must not crash startup or blank-field actions.
[IO.File]::WriteAllText($settingsFile,'{"directory":"","time":"invalid","daily":false}',[Text.UTF8Encoding]::new($false))
& powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $root 'tools\Configure-Backup.ps1') -Check -SettingsPath $settingsFile
if ($LASTEXITCODE) { throw 'Incomplete saved settings regression check failed.' }
Write-Output 'PASS incomplete saved configuration is handled without an unhandled exception.'
