import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

type LocalHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface LocalJsonRequestOptions {
  method?: LocalHttpMethod;
  body?: any;
  headers?: Record<string, string>;
  timeoutMs: number;
}

export interface LocalJsonResponse<T = any> {
  statusCode: number;
  data: T;
  rawBody: string;
}

function getRequestPath(url: URL) {
  return `${url.pathname}${url.search}`;
}

export function getLocalHttpErrorMessage(error: unknown) {
  const base = error instanceof Error ? error.message : String(error);
  const cause = (error as any)?.cause?.message;
  return cause && cause !== base ? `${base}；原因：${cause}` : base;
}

export async function requestLocalJson<T = any>(
  urlString: string,
  options: LocalJsonRequestOptions
): Promise<LocalJsonResponse<T>> {
  const url = new URL(urlString);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = options.method || 'GET';
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(payload !== undefined ? {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(payload))
    } : {}),
    ...(options.headers || {})
  };

  const rawBody = await new Promise<string>((resolve, reject) => {
    const req = transport({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: getRequestPath(url),
      method,
      headers
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const statusCode = res.statusCode || 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`HTTP ${statusCode}: ${bodyText.slice(0, 500) || 'empty response'}`));
          return;
        }
        resolve(bodyText);
      });
    });

    req.setTimeout(options.timeoutMs, () => {
      req.destroy(new Error(`请求超过等待上限仍未完成`));
    });
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });

  let data: T;
  try {
    data = rawBody ? JSON.parse(rawBody) : (null as T);
  } catch (error) {
    throw new Error(`JSON解析失败: ${(error as Error).message}; body=${rawBody.slice(0, 500)}`);
  }

  return {
    statusCode: 200,
    data,
    rawBody
  };
}
