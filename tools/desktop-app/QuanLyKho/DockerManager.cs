using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;

namespace QuanLyKho;

public static class DockerManager
{
    private static readonly string[] PossibleDockerExePaths = new[]
    {
        @"C:\Program Files\Docker\Docker\Docker Desktop.exe",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "Docker Desktop.exe"),
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Docker", "Docker", "Docker Desktop.exe")
    };

    private static readonly string[] PossibleDockerCliPaths = new[]
    {
        @"C:\Program Files\Docker\Docker\resources\bin\docker.exe",
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Docker", "Docker", "resources", "bin", "docker.exe"),
        @"C:\Program Files\Docker\Docker\resources\docker.exe"
    };

    public static bool IsDockerInstalled()
    {
        foreach (var p in PossibleDockerExePaths)
        {
            if (File.Exists(p)) return true;
        }
        foreach (var p in PossibleDockerCliPaths)
        {
            if (File.Exists(p)) return true;
        }
        try
        {
            using var proc = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "docker",
                    Arguments = "--version",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardOutput = true
                }
            };
            proc.Start();
            proc.WaitForExit(3000);
            return proc.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    public static async Task<bool> IsDockerRunningAsync()
    {
        return await Task.Run(() =>
        {
            try
            {
                using var proc = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = GetDockerCli(),
                        Arguments = "info",
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true
                    }
                };
                proc.Start();
                bool exited = proc.WaitForExit(5000);
                return exited && proc.ExitCode == 0;
            }
            catch
            {
                return false;
            }
        });
    }

    public static bool StartDockerDesktop()
    {
        foreach (var p in PossibleDockerExePaths)
        {
            try
            {
                if (File.Exists(p))
                {
                    Process.Start(new ProcessStartInfo(p) { UseShellExecute = true });
                    return true;
                }
            }
            catch { }
        }
        return false;
    }

    public static async Task<bool> IsServerOnlineAsync(string url)
    {
        try
        {
            using var handler = new HttpClientHandler
            {
                ServerCertificateCustomValidationCallback = (m, c, ch, p) => true
            };
            using var client = new HttpClient(handler)
            {
                Timeout = TimeSpan.FromSeconds(2)
            };
            var resp = await client.GetAsync(url);
            return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 500;
        }
        catch
        {
            return false;
        }
    }

    public static string GetDockerCli()
    {
        foreach (var p in PossibleDockerCliPaths)
        {
            if (File.Exists(p)) return p;
        }
        return "docker";
    }

    public static void PrepareDeploymentFiles(string storagePath)
    {
        string dockerDir = Path.Combine(storagePath, "docker");
        string certsDir = Path.Combine(dockerDir, "certs");

        Directory.CreateDirectory(dockerDir);
        Directory.CreateDirectory(certsDir);

        // 1. init-db.sh
        string initDbPath = Path.Combine(dockerDir, "init-db.sh");
        if (!File.Exists(initDbPath))
        {
            string initDbContent = "#!/bin/sh\nset -eu\npsql -v ON_ERROR_STOP=1 --username \"$POSTGRES_USER\" --dbname \"$POSTGRES_DB\" --set=app_password=\"$DB_APP_PASSWORD\" <<'SQL'\nCREATE ROLE wms_app LOGIN PASSWORD :'app_password';\nGRANT CONNECT ON DATABASE wms TO wms_app;\nSQL\n";
            File.WriteAllText(initDbPath, initDbContent, Encoding.UTF8);
        }

        // 2. certs/fullchain.pem
        string fullchainPath = Path.Combine(certsDir, "fullchain.pem");
        if (!File.Exists(fullchainPath))
        {
            File.WriteAllText(fullchainPath, EmbeddedCerts.FullChainPem, Encoding.UTF8);
        }

        // 3. certs/privkey.pem
        string privkeyPath = Path.Combine(certsDir, "privkey.pem");
        if (!File.Exists(privkeyPath))
        {
            File.WriteAllText(privkeyPath, EmbeddedCerts.PrivKeyPem, Encoding.UTF8);
        }

        // 4. .env
        string envPath = Path.Combine(dockerDir, ".env");
        if (!File.Exists(envPath))
        {
            string envContent = "DB_OWNER_PASSWORD=WmsOwner2026@SecurePass!\nDB_APP_PASSWORD=WmsApp2026@AppPass!\nADMIN_USERNAME=admin\nADMIN_PASSWORD=Admin@123456\nLAN_ORIGIN=https://localhost\n";
            File.WriteAllText(envPath, envContent, Encoding.UTF8);
        }

        // 5. docker-compose.yml
        string composePath = Path.Combine(dockerDir, "docker-compose.yml");
        string composeContent = @"name: quanlykho-customer
services:
  postgres:
    image: postgres:17
    restart: unless-stopped
    environment:
      POSTGRES_DB: wms
      POSTGRES_USER: wms_owner
      POSTGRES_PASSWORD: ${DB_OWNER_PASSWORD:-WmsOwner2026@SecurePass!}
      DB_APP_PASSWORD: ${DB_APP_PASSWORD:-WmsApp2026@AppPass!}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./init-db.sh:/docker-entrypoint-initdb.d/10-app-user.sh:ro
    healthcheck:
      test: [""CMD-SHELL"", ""pg_isready -U wms_owner -d wms""]
      interval: 3s
      timeout: 3s
      retries: 20
  redis:
    image: redis:8-alpine
    restart: unless-stopped
    command: [""redis-server"", ""--save"", """", ""--appendonly"", ""no""]
  migrate:
    image: ghcr.io/manhcuong2112003/warehouse_manager-api:latest
    command: [""node"", ""apps/api/dist/database/bootstrap.js""]
    environment:
      MIGRATION_DATABASE_URL: postgresql://wms_owner:${DB_OWNER_PASSWORD:-WmsOwner2026@SecurePass!}@postgres:5432/wms
      DATABASE_URL: postgresql://wms_app:${DB_APP_PASSWORD:-WmsApp2026@AppPass!}@postgres:5432/wms
      ADMIN_USERNAME: ${ADMIN_USERNAME:-admin}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:-Admin@123456}
    depends_on:
      postgres:
        condition: service_healthy
  api:
    image: ghcr.io/manhcuong2112003/warehouse_manager-api:latest
    restart: unless-stopped
    environment:
      DATABASE_URL: postgresql://wms_app:${DB_APP_PASSWORD:-WmsApp2026@AppPass!}@postgres:5432/wms
      WEB_ORIGIN: https://localhost
      COOKIE_SECURE: ""true""
      REDIS_URL: redis://redis:6379
    depends_on:
      migrate:
        condition: service_completed_successfully
      redis:
        condition: service_started
  web:
    image: ghcr.io/manhcuong2112003/warehouse_manager-web:latest
    restart: unless-stopped
    ports:
      - ""443:443""
      - ""80:80""
    volumes:
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      - api
volumes:
  postgres_data:
";
        File.WriteAllText(composePath, composeContent, Encoding.UTF8);
    }

    public static async Task<bool> RunDockerComposeUpAsync(string storagePath, Action<string> onLog)
    {
        return await Task.Run(() =>
        {
            try
            {
                PrepareDeploymentFiles(storagePath);
                string dockerDir = Path.Combine(storagePath, "docker");

                using var proc = new Process
                {
                    StartInfo = new ProcessStartInfo
                    {
                        FileName = GetDockerCli(),
                        Arguments = "compose --progress plain -f docker-compose.yml up -d",
                        WorkingDirectory = dockerDir,
                        CreateNoWindow = true,
                        UseShellExecute = false,
                        RedirectStandardOutput = true,
                        RedirectStandardError = true,
                        StandardOutputEncoding = Encoding.UTF8,
                        StandardErrorEncoding = Encoding.UTF8
                    }
                };

                proc.OutputDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) onLog(e.Data);
                };
                proc.ErrorDataReceived += (s, e) =>
                {
                    if (!string.IsNullOrEmpty(e.Data)) onLog(e.Data);
                };

                proc.Start();
                proc.BeginOutputReadLine();
                proc.BeginErrorReadLine();

                bool finished = proc.WaitForExit(300000); // 5 minutes timeout for image pull & startup
                return finished && proc.ExitCode == 0;
            }
            catch (Exception ex)
            {
                onLog("Lỗi khởi chạy Docker: " + ex.Message);
                return false;
            }
        });
    }
}

public static class EmbeddedCerts
{
    public const string FullChainPem = @"-----BEGIN CERTIFICATE-----
MIID8TCCAlmgAwIBAgIUCoNOpNjKDISSolCoIRXP7j+mEscwDQYJKoZIhvcNAQEL
BQAwJTEjMCEGA1UEAwwaUXVhbkx5S2hvIEludGVybmFsIFJvb3QgQ0EwHhcNMjYx
MDMxMDcwODU1WhcNMjcxMDMxMDcwODU1WjAXMRUwEwYDVQQDDAx3bXMuaW50ZXJu
YWwwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCVba84KmAdNe5UiTp1
YksnLBdx2B/GCQS9Ij4s9pfzBVjOKZK3oMZAr45zTZLF2+Q/ZqJbP8MV2RomsnGY
tSEz9mYyGV/zVB7qmex4D58ug84+ak0LE9cDTokNZQyohLlw7rkvboEgsY5DdO8A
5nptR4FUmnbop6P6qtHDWO6Inb6gxkF6I/zWgeLe9Xnv6W2uiYrZXqDlMmN2tAzO
SgsfuIhVuvJT2GJmCxQW76LuKqc8RM7hJ8Xva8oJ9Woq+U9U3DVEbehm2SfsL4Tp
KKjMjpAZo6mYVWDKMe4e0QV23N/xkNr3o7oRIWIC/J0Odoi4CUl5yOIf4+vV9FFV
S8kRAgMBAAGjgaYwgaMwDAYDVR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCBaAwEwYD
VR0lBAwwCgYIKwYBBQUHAwEwLgYDVR0RBCcwJYIMd21zLmludGVybmFsgglsb2Nh
bGhvc3SHBH8AAAGHBMCoAQ0wHQYDVR0OBBYEFBgwYt0TETyUf3TESUD7il/VDqAk
MB8GA1UdIwQYMBaAFCccZcq6BRC6AZF+65paV0CVJb3AMA0GCSqGSIb3DQEBCwUA
A4IBgQCZC8xqyrOPZpNIjFfIBY0Sc/uKGTlHr1pW4vMv5T/mp+NspD3A0eMpqY6w
5VnkYKV+V09J70Jbt0iC6nZfdUPHdwGt9etB700zpCERar+Nel80oaK6lc2R1Krq
fFLn4zMsNEeRxRKEq9wrKx638VDxyP0K6VaFwqciPvSzPujLVSeLtuhSps0T/WVC
iFjl07kr7mx2u6uLKlu7lrEIQB+kmNRLFQ1ML0RsXyVcIxkS1fdiBIWeZjBJixlf
Nf3SdZ9HKDICE/aRZMJWjhdOt89sdMd93QjZYMmIsF6bv+cbh8KF3lMIUU9onSP8
7kzvtet+h7gduvIyM1XO049/yf6G7PXj5hTCxNAQthfxiw0lhXeN4qQE9Q4ph5Up
70+d9zqPYF1sZZjfahsfKEOZPCq/BKLDcodJoZ97nC2MDlfgBoXycy0gHNwZUNEn
zpuvogLhNV2HgYRPvWtlfT0aaO4HXlwTbLd3z9Mw+Bc3E9XhxfrO4bKPMVyY3GRJ
NiANm1E=
-----END CERTIFICATE-----";

    public const string PrivKeyPem = @"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCVba84KmAdNe5U
iTp1YksnLBdx2B/GCQS9Ij4s9pfzBVjOKZK3oMZAr45zTZLF2+Q/ZqJbP8MV2Rom
snGYtSEz9mYyGV/zVB7qmex4D58ug84+ak0LE9cDTokNZQyohLlw7rkvboEgsY5D
dO8A5nptR4FUmnbop6P6qtHDWO6Inb6gxkF6I/zWgeLe9Xnv6W2uiYrZXqDlMmN2
tAzOSgsfuIhVuvJT2GJmCxQW76LuKqc8RM7hJ8Xva8oJ9Woq+U9U3DVEbehm2Sfs
L4TpKKjMjpAZo6mYVWDKMe4e0QV23N/xkNr3o7oRIWIC/J0Odoi4CUl5yOIf4+vV
9FFVS8kRAgMBAAECggEADjKd2RcDPkASdSGVMA1whfgyAatry9V6h+MgVJ+MRqQF
t1zxQRV7dy6KORljR/2bHVnWmxeFWGbIdDabOLIcRZz0dW+LLT1n/8yaA7q6pxRE
VqwJ+VksVXbMt2/+kmc99jJKEezzEIfeTdMaWS1zVdb0vY5wAuE+x6foU1Ve7Xr0
rxHdZJvWvaBkUCJWCMr/65/p9x38/prUyQjMDTtb9ePjLOgUacDeyu2dmGRau25o
Ed8RAcbLpFD2PYZWD/67+xw7CmGiJPPiJMJQBVqo0oSxZwFwPjcyJiV9aZfZ0tPW
JW0RtKSuvxblvh1ASUFUFB0X2CWIgZ+ddx/LXcESQwKBgQDKeZPPsyccEFyrrB7D
rWDIgQiLSwGNqV9lMTNGBq9ertlT9yD1CzwShD0Pdwl16BwauBuSaGDRulKUS6aR
vG1Jrq7zS2Hp5o0Z3w5RYnN2JO/Y90u3tT6xUW5ODwM/5ToBegCcZVbBkrgHwTKt
ju0d3NiVmcOi67P8PMy1kMNVfwKBgQC87jSmSmnF+G6ixWNymtlcGap9JdFbDnoF
9foPuTPFTJ0A33ocQYo+3Jyqk6h2NBnClFIZKLHx6bLyHFT880XdkkUYsA7J6D9d
IN1/uoOHAllsp+LD/de5VCG+mKV8R43aiczSUr34rhETXwxmtdMTiF8TFJuTHXjW
CpzvJAfJbwKBgD9xPt5qvUtu2Qq1oOIhVl0dCUdUFkWEF68GbpF3kMWzNce4fKwr
fAQ1SUiqPN2kAAJjQ8hpSkUNA8kRtzyc9QWMZac4LJL0uausl7jqh1Eym7C5NBF5
Cg7XfB+bVqJTugwyZTScEEYRKfbME4wMZ8HerEKb7pADGN9lUaNmm74TAoGAUYyA
LUbxYQJavud0hYNRTu/FJz+rniIhiXEi/qZyMjdfjYDotEmV4oxXE0mo7VyPwe1D
gpiONl0pYFfaV1SqU3lPWdikiYI113zYHsni++OHtd7BgteOxfAKoLpCs+Iu2KWi
QyZz2WNI+5OLRso00bmLUDEU9etCvSDXnGFw+wECgYAyabFJsuMbqfyY51fqnNwk
Ah8uZ1uZqphyHV1qkGQ8PrdPP7bnsaAXxpk1sm/DdjkiETBbrXWBteidU7hzqKMs
OtyXgkRf8LCMsqpeELFux2PkAAEm7E7/t8dOspjOrAMRLj+0BpDkw/GDkN4Ye33k
YzvEUsreH6dcRvktEbs5aA==
-----END PRIVATE KEY-----";
}

