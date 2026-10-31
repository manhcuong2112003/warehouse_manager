param([ValidateSet('local','lan')][string]$Profile='local',[string]$BackupDirectory,[ValidateSet('wms','wms_test')][string]$Database='wms')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'tools\Backup-Paths.ps1')
if ([string]::IsNullOrWhiteSpace($BackupDirectory)) {
    $settingsFile=Join-Path $root 'deploy\backup-settings.json'
    if (!(Test-Path -LiteralPath $settingsFile)) { throw 'Chọn thư mục bằng tools\CauHinhSaoLuu.cmd hoặc truyền -BackupDirectory trước khi sao lưu.' }
    $settings=Get-Content -LiteralPath $settingsFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (!$settings.directory) { throw 'Cấu hình chưa có thư mục sao lưu.' }
    $BackupDirectory=$settings.directory
    if (!$PSBoundParameters.ContainsKey('Profile')) { $Profile=$settings.profile }
}
$destination=Resolve-BackupFolder -Value $BackupDirectory
New-Item -ItemType Directory -Path $destination -Force | Out-Null
$compose=Join-Path $root $(if ($Profile -eq 'lan') {'deploy\compose.lan.yml'} else {'deploy\compose.yml'})
$name='wms-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.dump'
$composeArgs=@('compose','-f',$compose,'--env-file',(Join-Path $root '.env'))
$service=if ($Database -eq 'wms_test') { 'postgres-test' } else { 'postgres' }
& docker @composeArgs exec -T $service pg_dump -U wms_owner -d $Database -Fc -f "/tmp/$name"
if ($LASTEXITCODE) { throw 'pg_dump failed' }
$output=Join-Path $destination $name
& docker @composeArgs cp "${service}:/tmp/$name" $output
if ($LASTEXITCODE) { throw 'Backup copy failed' }
& docker @composeArgs exec -T $service rm "/tmp/$name"
if (!(Test-Path -LiteralPath $output) -or (Get-Item -LiteralPath $output).Length -eq 0) { throw 'Backup is empty' }
$digest=(Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash
[IO.File]::WriteAllText("$output.sha256",$digest,[Text.UTF8Encoding]::new($false))
Write-Output $output
