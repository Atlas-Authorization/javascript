/// <reference path="../.astro/types.d.ts" />

declare namespace App {
  // atlasMiddleware() puts the verified session on Astro.locals.atlas.
  interface Locals {
    atlas: import('@atlasauth/astro').AtlasAuth;
  }
}
