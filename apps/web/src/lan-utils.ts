export function getSavedLanIp(): string {
  try {
    return localStorage.getItem("wms_lan_ip") || "";
  } catch {
    return "";
  }
}

export function saveLanIp(ip: string): void {
  try {
    if (ip && ip.trim()) {
      localStorage.setItem("wms_lan_ip", ip.trim());
    }
  } catch {}
}

export function getDetectedHostIps(): string[] {
  const winIps = (window as any).__HOST_LAN_IPS__;
  if (Array.isArray(winIps) && winIps.length > 0) {
    return winIps.filter((ip) => typeof ip === "string" && !ip.startsWith("127.") && !ip.startsWith("169.254."));
  }
  return [];
}

export function resolveInitialHostIp(): string {
  const saved = getSavedLanIp();
  if (saved && saved !== "localhost" && saved !== "127.0.0.1") {
    return saved;
  }
  const detected = getDetectedHostIps();
  if (detected.length > 0) {
    return detected[0];
  }
  const hostname = location.hostname;
  if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
    return hostname;
  }
  return "";
}

export function buildMobileScanUrl(path: string, hash: string, customIp?: string): string {
  let ip = customIp?.trim() || resolveInitialHostIp();
  if (!ip) {
    ip = location.hostname;
  }
  const protocol = location.protocol || "https:";
  const port = location.port ? `:${location.port}` : "";
  const base = `${protocol}//${ip}${port}`;
  const url = new URL(path, base);
  if (hash) {
    url.hash = hash.startsWith("#") ? hash.slice(1) : hash;
  }
  return url.toString();
}
