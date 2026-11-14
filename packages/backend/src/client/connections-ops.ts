import { enc, type RequestFn } from './request';



export type ConnectionsRelayBody = {
  /** Must be in the connection's allowed_methods. */
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Absolute https URL on an allowed host. */
  url: string;
  /** Extra request headers. Authorization, Cookie and Host cannot be set. */
  headers?: {
    [key: string]: string;
  };
  /** POST, PUT, PATCH or DELETE: a string, or an object sent as JSON (up to 256 KiB). */
  body?: unknown;
  /** Where the provider returns after authorizing, to receive meta.authorize_url on a 402. */
  redirect_url?: string;
  retry?: {
    /** Retries after a 429 (any method) or a 502/503/504 (GET and HEAD), 0 to 5; default 2. Waits follow Retry-After, capped at 5 seconds, with jitter. */
    max?: number;
  };
  /** GET only. Fetch up to max_pages pages and return the merged items instead of one response. */
  paginate?: {
    /** link follows rel="next" in the Link header; cursor reads the next cursor from the body; offset advances an offset parameter. */
    type: 'link' | 'cursor' | 'offset';
    /** 1 to 10; default 3. */
    max_pages?: number;
    /** Dot path to the array of items in each page; omit when the body is the array. */
    items_path?: string;
    /** cursor: dot path to the next cursor in the body. */
    cursor_path?: string;
    /** cursor: the query parameter that carries the cursor. */
    cursor_param?: string;
    /** offset: the query parameter that carries the offset. */
    offset_param?: string;
    /** offset: the query parameter that carries the page size. */
    limit_param?: string;
    /** offset: items per page (1 to 1000). */
    page_size?: number;
  };
  /** POST, PUT, PATCH or DELETE: send multipart/form-data instead of body (up to 10 parts, 256 KiB in all). */
  multipart?: {
    /** The form field name. */
    name: string;
    /** Makes the part a file upload. */
    filename?: string;
    /** The part's media type. */
    content_type?: string;
    /** The part as text (use this or base64). */
    text?: string;
    /** The part as base64 bytes (use this or text). */
    base64?: string;
  }[];
  /** base64 returns the response bytes in body_base64, for binary downloads. */
  response_encoding?: 'text' | 'base64';
  /** The user the authorization link is for (organization-owned connections). */
  connect_user_id?: string;
};

export type ConnectionsRelayResult = {
  /** connection_relay_pages when the request asked for paginate. */
  object: 'connection_relay_response' | 'connection_relay_pages';
  /** Paginated requests: how many pages were fetched. */
  pages?: number;
  /** Paginated requests: true when max_pages stopped the walk before the last page. */
  has_more?: boolean;
  /** Paginated requests: the merged items of every page. */
  items?: Record<string, unknown>[];
  connection_id: string;
  /** The provider's HTTP status. */
  status: number;
  /** A small allow-list of response headers (content-type, etag, retry-after, link and a few more). */
  headers?: {
    [key: string]: string;
  };
  /** The provider's response body as text (up to 1 MiB). */
  body?: string;
  /** Present when the request asked for response_encoding base64: the response bytes, base64-encoded (up to 1 MiB). */
  body_base64?: string;
  truncated?: boolean;
  /** How many times the request was sent, counting retries after 429 / Retry-After and refreshed credentials. */
  attempts?: number;
};

/** Operations on `/v1/connections` (1). */
export function connectionsOpsResource(request: RequestFn) {
  return {
    /** Make a provider API call server-side with this connection's credential, so the credential never reaches your code: Atlas injects an api_key (header or query), bearer, basic or custom header, signs with an hmac_secret or OAuth 1.0a, or sends a minted client_credentials / jwt_bearer / GitHub App installation / admin consent token. Only https calls to the connection's allowed_hosts are made, with the verbs in allowed_methods (default GET, HEAD, POST). When the connection is not connected, or the provider rejects the credential, the answer is 402 CONNECTION_REQUIRED with `meta.reason` (not_connected or needs_reauth) and, for a user-owned OAuth connection when you pass `redirect_url`, `meta.authorize_url`. The audit log records the method, host and status only. */
    relay(id: string, body: ConnectionsRelayBody, idempotencyKey?: string): Promise<ConnectionsRelayResult> {
      return request({ method: 'POST', path: `/v1/connections/${enc(id)}/relay`, body, idempotencyKey });
    },
  };
}
