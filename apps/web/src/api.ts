let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export async function api(
  path: string,
  options: RequestInit = {},
): Promise<any> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set("Content-Type", "application/json");
  if (options.method && !["GET", "HEAD"].includes(options.method)) {
    headers.set("x-csrf-token", csrf);
    if (!headers.has("Idempotency-Key"))
      headers.set("Idempotency-Key", crypto.randomUUID());
  }
  const r = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  const body = await r
    .json()
    .catch(() => ({ message: "Máy chủ không trả dữ liệu hợp lệ." }));
  if (!r.ok) {
    const e = new Error(body.message || "Không thể xử lý yêu cầu.");
    Object.assign(e, { code: body.code, status: r.status });
    throw e;
  }
  return body;
}
export const post = (path: string, data: unknown = {}, method = "POST") =>
  api(path, { method, body: JSON.stringify(data) });
export const params = (values: Record<string, any>) =>
  new URLSearchParams(
    Object.entries(values)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => [k, String(v)]),
  ).toString();
export const fmt = (v: any) => Number(v || 0).toLocaleString("vi-VN");
