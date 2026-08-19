/**
 * 서버 오류 봉투를 그대로 받는 타입.
 *
 * 서버는 모든 오류를 `{ error: { code, message, details, request_id } }` 로 준다
 * (`server/app/core/errors.py`). **`code` 로 분기하고 `message` 는 그대로 보여준다** —
 * 화면에서 메시지를 다시 지어내면 서버가 문구를 고쳐도 반영이 안 되고, 두 곳이
 * 서로 다른 말을 하게 된다.
 */

export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    request_id?: string;
  };
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  /** 문의할 때 이걸 알려주면 서버 로그에서 바로 찾을 수 있다 */
  readonly requestId: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId = '',
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }

  /** 네트워크가 끊겼거나 서버가 응답을 못 준 경우 */
  static offline(cause?: unknown): ApiError {
    return new ApiError(0, 'network_unreachable', '서버에 연결할 수 없습니다', {
      cause: String(cause ?? ''),
    });
  }
}

/** 응답 본문에서 오류를 꺼낸다. 봉투가 아니어도(프록시 502 등) 죽지 않는다 */
export function toApiError(status: number, body: unknown): ApiError {
  const envelope = body as Partial<ApiErrorBody> | null;
  const err = envelope?.error;
  if (err && typeof err.code === 'string') {
    return new ApiError(status, err.code, err.message, err.details ?? {}, err.request_id ?? '');
  }
  // 서버가 아니라 앞단(nginx·프록시)이 만든 응답일 수 있다
  return new ApiError(status, `http_${status}`, `요청이 실패했습니다 (${status})`);
}

/** 무료 한도에 걸렸나 — 화면이 결제 안내를 띄우는 신호 */
export function isQuotaError(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 402;
}

/** 낙관적 잠금 충돌 — 다른 창에서 먼저 저장했다 */
export function isConflict(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status === 409;
}
