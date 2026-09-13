/**
 * §6 Telegram Login Widget — the client half.
 *
 * Like the native / One-Tap helper, the SDK does not own fetch: these are pure
 * request/response shapers. The Telegram Login Widget calls the page back with a
 * signed payload object; the app wraps it with `telegramSignInBody`, POSTs it to
 * `/v1/oauth/telegram`, and reads the result with the shared
 * `parseNativeSignInResponse` (a `ticket` means complete; a bare status means a
 * factor is still owed — exactly the same contract as every other flow).
 */

export interface TelegramWidgetUser {
  id: number | string;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number | string;
  hash: string;
  [key: string]: unknown;
}

export interface TelegramSignInBody {
  telegram: TelegramWidgetUser;
}

/** Build the POST body for `/v1/oauth/telegram` from the widget's user object. */
export function telegramSignInBody(payload: TelegramWidgetUser): TelegramSignInBody {
  return { telegram: payload };
}
