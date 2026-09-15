export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
  });
}

export function checkOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) {
    throw new HttpError(403, "不允许跨站调用管理接口。");
  }
}

export async function readObject(request: Request, limit = 16_384, allowEmpty = false): Promise<Record<string, unknown>> {
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
          await reader.cancel();
          throw new HttpError(413, `请求体不能超过 ${limit} 字节。`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "无法读取 UTF-8 请求体。");
    } finally {
      reader.releaseLock();
    }
  }
  if (!text.trim()) {
    if (allowEmpty) return {};
    throw new HttpError(400, "请提供 JSON 请求体。");
  }
  if (request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpError(415, "请求体必须使用 application/json。");
  }
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, "请求体不是合法的 JSON。"); }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "请求体必须是 JSON 对象。");
  }
  return body as Record<string, unknown>;
}

export function allowFields(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw new HttpError(400, "请求包含不支持的字段。");
  }
}
