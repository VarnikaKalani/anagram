import { NextResponse } from "next/server";
import type { ApiResponse } from "../../shared/types";

export function ok<T>(data: T) {
  return NextResponse.json<ApiResponse<T>>({
    ok: true,
    data
  });
}

export function fail<T = never>(errorCode: string, message: string, status = 400) {
  return NextResponse.json<ApiResponse<T>>({ ok: false, errorCode: errorCode as any, message }, { status });
}
