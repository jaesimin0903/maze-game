// Route-handler plumbing shared by every API route (plan §7.3).
//
// `route` is the only way a handler runs: it resolves the container (503 when the boot guards
// failed), and turns every thrown value into a response through `errorResponse`. A handler
// never builds an error body itself.

import type { Hex } from '@maze/shared';
import { getContainer, type Container } from './container';
import { ApiError, errorResponse, isApiError } from './errors';
import { createLogger, describeError } from './log';

export type RouteParams = Record<string, string>;

export interface RouteContext {
  container: Container;
  request: Request;
  params: RouteParams;
}

export type RouteHandler = (
  request: Request,
  context: { params: Promise<RouteParams> },
) => Promise<Response>;

export function route(handler: (context: RouteContext) => Promise<Response>): RouteHandler {
  return async (request, context) => {
    let container: Container | null = null;
    try {
      container = await getContainer();
      const params = await context.params;
      return await handler({ container, request, params });
    } catch (error) {
      if (isApiError(error)) return errorResponse(error.code);
      (container?.log ?? createLogger()).event({
        level: 'error',
        event: 'request-failed',
        detail: { path: new URL(request.url).pathname, error: describeError(error) },
      });
      return errorResponse('INTERNAL');
    }
  };
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** The `:id` path parameter as a lower-case game id. */
export function gameIdParam(params: RouteParams): Hex {
  const { id } = params;
  if (typeof id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(id)) throw new ApiError('BAD_REQUEST');
  return id.toLowerCase() as Hex;
}

const MAX_TOKEN_LENGTH = 256;

/** The token of `Authorization: Bearer <token>`, or `null` when there is none. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer ([\x21-\x7e]+)$/i.exec(header);
  if (match === null || match[1].length > MAX_TOKEN_LENGTH) return null;
  return match[1];
}

/**
 * The request body as a JSON object. At most `maxBytes` are read; a longer body, invalid JSON
 * or a non-object is `BAD_REQUEST`. With `allowEmpty`, an empty body counts as `{}`.
 */
export async function readJsonObject(
  request: Request,
  options: { maxBytes?: number; allowEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  const maxBytes = options.maxBytes ?? 4096;
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body !== null) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError('BAD_REQUEST');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '' && options.allowEmpty === true) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError('BAD_REQUEST');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError('BAD_REQUEST');
  }
  return body as Record<string, unknown>;
}
