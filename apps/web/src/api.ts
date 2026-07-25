import type { ApiEnvelope, ApiErrorBody } from "@damo/contracts";

export const API_URL =
  import.meta.env.VITE_API_URL ?? "http://127.0.0.1:4010/api/v1";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
  }
}

export const tokenStore = {
  get: () => localStorage.getItem("damo.accessToken"),
  set: (value: string) => localStorage.setItem("damo.accessToken", value),
  clear: () => {
    localStorage.removeItem("damo.accessToken");
    localStorage.removeItem("damo.refreshToken");
  }
};

export async function api<T>(
  path: string,
  init: RequestInit = {},
  authenticated = true
): Promise<T> {
  const token = tokenStore.get();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(authenticated && token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  const body = (await response.json().catch(() => null)) as
    | ApiEnvelope<T>
    | ApiErrorBody
    | null;
  if (!response.ok) {
    const error = body && "error" in body ? body.error : null;
    throw new ApiError(
      response.status,
      error?.code ?? "NETWORK_ERROR",
      error?.message ?? "서버와 통신하지 못했습니다.",
      error?.details
    );
  }
  if (!body || !("data" in body)) {
    throw new ApiError(500, "INVALID_RESPONSE", "서버 응답 형식이 올바르지 않습니다.");
  }
  return body.data;
}
