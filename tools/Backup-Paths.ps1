function Resolve-BackupSettingsFile {
    param([string]$ProjectRoot,[AllowNull()][AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($ProjectRoot)) { throw 'Không xác định được thư mục cài đặt WMS.' }
    $candidate=if ([string]::IsNullOrWhiteSpace($Value)) { Join-Path $ProjectRoot 'deploy\backup-settings.json' } else { $Value.Trim() }
    if (![IO.Path]::IsPathRooted($candidate)) { $candidate=Join-Path $ProjectRoot $candidate }
    return [IO.Path]::GetFullPath($candidate)
}

function Test-BackupFolderExists {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $false }
    return [IO.Directory]::Exists($Value.Trim())
}

function Resolve-BackupFolder {
    param([AllowNull()][AllowEmptyString()][string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Chọn thư mục sao lưu hoặc nhập đường dẫn đầy đủ trước.' }
    $candidate=$Value.Trim()
    if ($candidate -notmatch '^[a-zA-Z]:[\\/]' -and $candidate -notmatch '^[\\/]{2}[^\\/]+[\\/][^\\/]+') {
        throw 'Nhập đường dẫn đầy đủ, ví dụ D:\WMS-Backup hoặc \\NAS\WMS.'
    }
    return [IO.Path]::GetFullPath($candidate)
}
