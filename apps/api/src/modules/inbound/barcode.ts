import { z } from "zod";
import {
  date,
  text,
  validate,
  validateQuantity,
} from "../../shared/validation";
import { ensure } from "../../shared/errors";
export type ParsedScan = {
  partNo?: string;
  vendorCode?: string;
  poType?: string;
  lotNo?: string;
  quantity?: number;
  mesPackNo?: string;
  expiredDate?: string;
};
function gs1Date(v: string) {
  ensure(
    /^\d{6}$/.test(v),
    "INVALID_DATE",
    "Ngày GS1 phải có 6 chữ số YYMMDD.",
    422,
  );
  const year = 2000 + Number(v.slice(0, 2)),
    month = Number(v.slice(2, 4));
  let day = Number(v.slice(4));
  if (day === 0) day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return validate(
    date,
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  );
}
export function parseBarcode(raw: string): ParsedScan {
  ensure(
    typeof raw === "string" && raw.trim().length > 0 && raw.length <= 4096,
    "INVALID_BARCODE",
    "Mã quét trống hoặc quá dài.",
    422,
  );
  const s = raw.trim().replace(/^\][A-Za-z]\d/, "");
  if (s.startsWith("{")) {
    const schema = z
      .object({
        partNo: text.optional(),
        vendorCode: text.optional(),
        poType: text.optional(),
        lotNo: text.optional(),
        quantity: z.union([z.string(), z.number()]).optional(),
        mesPackNo: text.optional(),
        expiredDate: date.optional(),
      })
      .strict();
    let json: any;
    try {
      json = JSON.parse(s);
    } catch {
      ensure(false, "INVALID_JSON", "QR không phải JSON hợp lệ.", 422);
    }
    const value = validate(schema, json);
    return {
      ...value,
      quantity:
        value.quantity === undefined
          ? undefined
          : validateQuantity(value.quantity),
    };
  }
  if (s.includes("|")) {
    const parts = s.split("|").map((p) => p.trim());
    ensure(
      parts.length === 5,
      "INVALID_BARCODE",
      "Mã 1D cần đúng 5 trường Part|Vendor|PO|Lot|Qty.",
      422,
    );
    return {
      partNo: validate(text, parts[0]),
      vendorCode: validate(text, parts[1]),
      poType: parts[2] || undefined,
      lotNo: validate(text, parts[3]),
      quantity: validateQuantity(parts[4]),
    };
  }
  if (
    s.startsWith("(") ||
    s.includes("\x1d") ||
    /^\][Cd][12]/.test(raw.trim())
  ) {
    const ais: Record<string, string> = {};
    if (s.startsWith("(")) {
      const matches = [...s.matchAll(/\((\d{2,4})\)([^()]*)/g)];
      ensure(
        matches.map((m) => m[0]).join("") === s,
        "INVALID_GS1",
        "Cấu trúc GS1 không hợp lệ.",
        422,
      );
      for (const m of matches) {
        ensure(!ais[m[1]], "INVALID_GS1", "AI GS1 bị trùng.", 422);
        ais[m[1]] = m[2];
      }
    } else {
      const lengths: Record<string, number> = {
        "00": 18,
        "01": 14,
        "11": 6,
        "17": 6,
        "240": 0,
        "10": 0,
        "21": 0,
        "30": 0,
        "91": 0,
      };
      let rest = s;
      while (rest) {
        rest = rest.replace(/^\x1d/, "");
        if (!rest) break;
        const ai = Object.keys(lengths).find((a) => rest.startsWith(a));
        ensure(
          ai,
          "UNSUPPORTED_GS1",
          "AI GS1 chưa được hỗ trợ. Dùng QR JSON hoặc nhập có kiểm soát.",
          422,
        );
        rest = rest.slice(ai.length);
        const len = lengths[ai];
        const end = len || (rest.indexOf("\x1d") + 1 || rest.length + 1) - 1;
        ais[ai] = rest.slice(0, end);
        rest = rest.slice(end);
      }
    }
    return {
      partNo: ais["240"],
      lotNo: ais["10"],
      mesPackNo: ais["21"] || ais["00"],
      vendorCode: ais["91"],
      quantity: ais["30"] ? validateQuantity(ais["30"]) : undefined,
      expiredDate: ais["17"] ? gs1Date(ais["17"]) : undefined,
    };
  }
  ensure(
    /^[\w.\-/]{1,100}$/.test(s),
    "INVALID_BARCODE",
    "Mã pack chứa ký tự không được hỗ trợ.",
    422,
  );
  return { mesPackNo: s };
}
