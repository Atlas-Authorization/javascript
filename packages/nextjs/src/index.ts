export * from './matcher';
export * from './middleware';
export * from './proxy';
export * from './access-token';
export * from './mount';
export * from './webhooks';
export * from './backchannel';

// Auth status for 401s and server-side session renewal (see @atlasauth/backend).
export { authStatusHeaders, withAuthStatus, setAuthStatusHeader, refreshSessionFromRequest, type AuthStatus, type RefreshSessionOptions, type RefreshedSession } from '@atlasauth/backend';

// Rate limiting and grant usage (see ./limits).
export { withRateLimit, withGrantUsage, withStepUp, atlasRateLimitMiddleware, atlasGrantUsageMiddleware, atlasStepUpMiddleware, type StepUpCheck, type StepUpOptions, type AtlasLimitOptions, type GrantUsageCheck, type GrantUsageOptions, type RateLimitCheck, type RateLimiter, type LimitClaims, type LimitVerdict, withFeature, atlasRequireFeatureMiddleware, type FeatureCheck, type FeatureOptions } from './limits';
