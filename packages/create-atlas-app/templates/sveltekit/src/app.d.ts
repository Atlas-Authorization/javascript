declare global {
  namespace App {
    // handleAtlas() puts the verified session on event.locals.auth.
    interface Locals {
      auth: import('@atlasauth/svelte/server').ServerAuth;
    }
  }
}

export {};
