param([Parameter(Mandatory=$true)][string]$BackupFile,[ValidateSet('local','lan')][string]$Profile='local')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$backup=(Resolve-Path -LiteralPath $BackupFile).Path
if (Test-Path -LiteralPath "$backup.sha256") {
    if ((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne (Get-Content -LiteralPath "$backup.sha256" -Raw).Trim()) { throw 'Checksum mismatch' }
}
$database='wms_restore_'+[Guid]::NewGuid().ToString('N')+'_test'
if ($database -notmatch '^wms_restore_[a-f0-9]{32}_test$') { throw 'Invalid drill database name' }
$compose=Join-Path $root $(if ($Profile -eq 'lan') {'deploy\compose.lan.yml'} else {'deploy\compose.yml'})
$composeArgs=@('compose','-f',$compose,'--env-file',(Join-Path $root '.env'))
$remote='/tmp/'+$database+'.dump'
& docker @composeArgs cp $backup "postgres:$remote"
if ($LASTEXITCODE) { throw 'Copy failed' }
& docker @composeArgs exec -T postgres createdb -U wms_owner $database
if ($LASTEXITCODE) { throw 'Could not create isolated drill database' }
& docker @composeArgs exec -T postgres pg_restore -U wms_owner -d $database --exit-on-error $remote
if ($LASTEXITCODE) { throw 'Restore failed' }
$sql=@'
SELECT json_build_object(
 'packs',(SELECT count(*) FROM stock_pack_balances),
 'movements',(SELECT count(*) FROM stock_movements),
 'receipts',(SELECT count(*) FROM inbound_receipts),
 'mismatched_balances',(SELECT count(*) FROM stock_pack_balances b LEFT JOIN (SELECT pack_balance_id,sum(quantity_delta) qty FROM stock_movements GROUP BY pack_balance_id) m ON m.pack_balance_id=b.id WHERE b.on_hand<>COALESCE(m.qty,0)),
 'mismatched_reservations',(SELECT count(*) FROM stock_pack_balances b LEFT JOIN (SELECT pack_balance_id,sum(quantity) qty FROM stock_reservations WHERE status='ACTIVE' GROUP BY pack_balance_id) r ON r.pack_balance_id=b.id WHERE b.reserved<>COALESCE(r.qty,0))
);
'@
$result=& docker @composeArgs exec -T postgres psql -U wms_owner -d $database -At -v ON_ERROR_STOP=1 -c $sql
if ($LASTEXITCODE) { throw 'Reconciliation query failed' }
$counts=$result | ConvertFrom-Json
if ($counts.mismatched_balances -ne 0 -or $counts.mismatched_reservations -ne 0) { throw 'Reconciliation failed' }
& docker @composeArgs exec -T postgres rm $remote
Write-Output "Restored into isolated database $database"
Write-Output $result
