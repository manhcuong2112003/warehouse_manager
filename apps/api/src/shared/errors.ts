import { HttpException } from "@nestjs/common";
export class WmsError extends HttpException {
  constructor(
    public code: string,
    message: string,
    status = 409,
  ) {
    super({ code, message }, status);
  }
}
export function ensure(
  condition: unknown,
  code: string,
  message: string,
  status = 409,
): asserts condition {
  if (!condition) throw new WmsError(code, message, status);
}
