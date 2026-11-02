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
  const detected = getDetectedHostIps();
  const saved = getSavedLanIp();
  // Nếu IP đã lưu vẫn nằm trong danh sách IP mạng thực tế đang kết nối thì giữ nguyên
  if (saved && detected.includes(saved)) {
    return saved;
  }
  // Nếu đổi mạng (hoặc chưa lưu), luôn ưu tiên IP mạng thực tế phát hiện được
  if (detected.length > 0) {
    return detected[0];
  }
  if (saved && saved !== "localhost" && saved !== "127.0.0.1") {
    return saved;
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

