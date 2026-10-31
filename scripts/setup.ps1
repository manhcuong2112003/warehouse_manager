param([switch]$SkipInstall)
$ErrorActionPreference='Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
if (!(Test-Path -LiteralPath '.env')) {
    function New-Secret([int]$Length) {
        $bytes=New-Object byte[] $Length
        $rng=[Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        return [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
    }
    $owner=New-Secret 24
    $app=New-Secret 24
    $admin=New-Secret 12
    $lines=@("DB_OWNER_PASSWORD=$owner","DB_APP_PASSWORD=$app","MIGRATION_DATABASE_URL=postgresql://wms_owner:$owner@127.0.0.1:54329/wms","DATABASE_URL=postgresql://wms_app:$app@127.0.0.1:54329/wms","TEST_DATABASE_URL=postgresql://wms_owner:$owner@127.0.0.1:54330/wms_test",'PORT=3001','WEB_ORIGIN=http://localhost:5173','ADMIN_USERNAME=admin',"ADMIN_PASSWORD=$admin",'COOKIE_SECURE=false')
    [IO.File]::WriteAllText((Join-Path (Get-Location) '.env'),($lines -join "`n"),[Text.UTF8Encoding]::new($false))
}
if (!$SkipInstall) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
docker compose -f deploy/compose.yml --env-file .env up -d --wait postgres
if ($LASTEXITCODE) { throw 'PostgreSQL could not start' }
npm run db:migrate
if ($LASTEXITCODE) { throw 'Migration failed' }
npm run db:seed
if ($LASTEXITCODE) { throw 'Bootstrap failed' }
Write-Output 'Ready. Run npm run dev, then open http://localhost:5173. Admin credentials are in .env.'
