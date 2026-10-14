# @atlasauth/js changelog

## 0.5.0
- **OIDC Front-Channel Logout helpers.** `runFrontChannelLogout(urls, { timeoutMs })` loads each
  front-channel logout URL in a hidden, sandboxed iframe and resolves once they have all loaded or
  after the timeout (default 5 s); it never throws, only loads `https:` URLs (and `http://localhost`
  for development), and is a no-op without a DOM (SSR). `runFrontChannelLogoutFromResponse(res)`
  reads `frontchannel_logout_urls` from a Frontend API sign-out response. The framework SDKs'
  `signOut()` uses them; the new `SignOutOptions` type (`{ frontchannel?: boolean }`) is the option
  they accept.
