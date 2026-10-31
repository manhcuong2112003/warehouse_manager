import { z } from "zod";
import { ensure, WmsError } from "./errors";
export const uuid = z.uuid();
export const text = z.string({ error: "Trường này không được để trống." }).trim().min(1, "Giá trị không được để trống.").max(255);
export const quantity = z
  .number()
  .int()
  .positive()
  .max(10_000_000)
  .refine(Number.isSafeInteger);
export const date = z.iso.date();
export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new WmsError(
      "VALIDATION_ERROR",
      r.error.issues.map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; "),
      422,
    );
  return r.data;
}
export function validateQuantity(raw: string | number) {
  const value = String(raw).trim();
  ensure(
    /^0*[1-9]\d*$/.test(value),
    "INVALID_QUANTITY",
    "Số lượng phải là số nguyên dương.",
    422,
  );
  return validate(quantity, Number(value));
}
export function warehouseDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
