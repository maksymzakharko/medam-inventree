export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly operationId?: string,
    readonly requestId?: string,
  ) { super(message); this.name = 'ApiError'; }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: unknown; idempotencyKey?: string };
type ErrorBody = { error?: { message?: string; code?: string; operationId?: string; requestId?: string } };

export class ApiClient {
  private csrfToken = '';
  onUnauthorized: (() => void) | undefined;

  setCsrfToken(token: string) { this.csrfToken = token; }
  clear() { this.csrfToken = ''; }

  async csrf() {
    const value = await this.request<{ csrfToken: string }>('/api/auth/csrf');
    this.csrfToken = value.csrfToken;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { body, idempotencyKey, ...init } = options;
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('X-CSRF-Token', this.csrfToken);
    }
    if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey);
    let response: Response;
    try {
      response = await fetch(path, {
        ...init, method, headers, credentials: 'same-origin', cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: init.signal ?? AbortSignal.timeout(25_000),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && init.signal?.aborted) throw error;
      throw new ApiError('Nie udało się połączyć z serwerem. Sprawdź połączenie z internetem.', 0, 'NETWORK_ERROR');
    }
    if (!response.ok) {
      let data: ErrorBody = {};
      try { data = await response.json() as ErrorBody; } catch { /* Never expose raw upstream or proxy errors. */ }
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError(
        data.error?.message ?? (response.status === 401 ? 'Sesja wygasła. Zaloguj się ponownie.' : 'Nie udało się wykonać żądania. Spróbuj odświeżyć widok.'),
        response.status, data.error?.code ?? 'REQUEST_FAILED', data.error?.operationId, data.error?.requestId,
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  async download(path: string, filename: string) {
    const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized?.();
      throw new ApiError('Nie udało się pobrać eksportu. Sprawdź zakres i uprawnienia.', response.status, 'EXPORT_FAILED');
    }
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export const api = new ApiClient();
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Wystąpił nieoczekiwany błąd.'; }
export const pendingOperationKey = 'medam.pending-operation';
export function readPendingOperation() {
  try { const value = sessionStorage.getItem(pendingOperationKey); return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null; }
  catch { return null; }
}
export function savePendingOperation(value: string | null) {
  try { if (value) sessionStorage.setItem(pendingOperationKey, value); else sessionStorage.removeItem(pendingOperationKey); }
  catch { /* Storage may be disabled. The visible UUID remains available during this page session. */ }
}
