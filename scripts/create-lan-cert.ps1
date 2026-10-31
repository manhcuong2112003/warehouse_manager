param([string]$LanHost='wms.internal',[Parameter(Mandatory=$true)][string]$LanIp)
$ErrorActionPreference='Stop'
if ($LanHost -notmatch '^[a-zA-Z0-9.-]+$') { throw 'Invalid hostname' }
$parsedIp=$null
if (![Net.IPAddress]::TryParse($LanIp,[ref]$parsedIp) -or $parsedIp.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Use a valid IPv4 address' }
$command=Get-Command openssl -ErrorAction SilentlyContinue
$openssl=if ($command) {$command.Source} else {'C:\Program Files\Git\usr\bin\openssl.exe'}
if (!(Test-Path -LiteralPath $openssl)) { throw 'Install OpenSSL or Git for Windows first' }
$root=Split-Path -Parent $PSScriptRoot
$pki=Join-Path $root 'deploy\pki'
$certs=Join-Path $root 'deploy\certs'
New-Item -ItemType Directory -Path $pki,$certs -Force | Out-Null
$caKey=Join-Path $pki 'rootCA-key.pem'
$ca=Join-Path $pki 'rootCA.pem'
$serverKey=Join-Path $certs 'privkey.pem'
$serverCert=Join-Path $certs 'fullchain.pem'
if ((Test-Path -LiteralPath $serverKey) -or (Test-Path -LiteralPath $serverCert)) { throw 'Server certificate already exists; keep it or renew explicitly with your CA.' }
if (!(Test-Path -LiteralPath $ca)) {
    & $openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -keyout $caKey -out $ca -subj '/CN=QuanLyKho Internal Root CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>$null
    if ($LASTEXITCODE) { throw 'CA creation failed' }
}
$csr=Join-Path $pki 'server.csr'
& $openssl req -newkey rsa:2048 -nodes -keyout $serverKey -out $csr -subj "/CN=$LanHost" 2>$null
if ($LASTEXITCODE) { throw 'CSR creation failed' }
$extension=Join-Path $pki 'server.ext'
$ext=@('basicConstraints=critical,CA:FALSE','keyUsage=critical,digitalSignature,keyEncipherment','extendedKeyUsage=serverAuth',"subjectAltName=DNS:$LanHost,DNS:localhost,IP:127.0.0.1,IP:$LanIp") -join "`n"
[IO.File]::WriteAllText($extension,$ext,[Text.UTF8Encoding]::new($false))
& $openssl x509 -req -in $csr -CA $ca -CAkey $caKey -CAcreateserial -out $serverCert -days 365 -sha256 -extfile $extension 2>$null
if ($LASTEXITCODE) { throw 'Certificate signing failed' }
Copy-Item -LiteralPath $ca -Destination (Join-Path $certs 'rootCA.pem')
Write-Output "Prepared HTTPS certificate for https://$LanIp and $LanHost."
Write-Output "Public root CA for client trust: $(Join-Path $certs 'rootCA.pem')"
Write-Output 'CA private key remains in deploy/pki and is not mounted into Nginx.'
