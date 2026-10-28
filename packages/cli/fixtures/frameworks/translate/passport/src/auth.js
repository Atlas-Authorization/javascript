const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { Strategy: SamlStrategy } = require('@node-saml/passport-saml');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);

passport.use(new LocalStrategy({ usernameField: 'email' }, verifyPassword));

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: '/auth/google/callback',
      scope: ['profile', 'email'],
    },
    findOrCreate,
  ),
);

passport.use(new SamlStrategy({ entryPoint: 'https://idp.example.com/sso', issuer: 'api', cert: process.env.IDP_CERT }, samlVerify));

module.exports.sessionMiddleware = session({
  name: 'api.sid',
  secret: process.env.SESSION_SECRET,
  store: new pgSession({ tableName: 'session' }),
  rolling: true,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
});
