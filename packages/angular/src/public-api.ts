/**
 * `@atlasauth/angular` — the official Angular SDK for Atlas, the Angular peer of
 * `@atlasauth/react`. Public surface.
 */

// Configuration + DI
export { ATLAS_OPTIONS, type AtlasOptions } from './lib/atlas.config';
export { provideAtlas, AtlasModule } from './lib/provide-atlas';

// Core service (the AtlasProvider + hooks equivalent)
export { AtlasService } from './lib/atlas.service';

// Structural directives + the theming host directive
export { AtlasSignedInDirective } from './lib/directives/signed-in.directive';
export { AtlasSignedOutDirective } from './lib/directives/signed-out.directive';
export { AtlasLoadingDirective } from './lib/directives/loading.directive';
export { AtlasLoadedDirective } from './lib/directives/loaded.directive';
export { AtlasProtectDirective } from './lib/directives/protect.directive';
export { AtlasRootDirective } from './lib/directives/atlas-root.directive';

// Components
export { SignInComponent } from './lib/components/sign-in.component';
export { SignUpComponent } from './lib/components/sign-up.component';
export { UserButtonComponent } from './lib/components/user-button.component';
export { OrganizationSwitcherComponent } from './lib/components/organization-switcher.component';
export { UserProfileComponent } from './lib/components/user-profile.component';
export { OrganizationProfileComponent } from './lib/components/organization-profile.component';
export { AttemptFlowComponent } from './lib/components/attempt-flow.component';
export { AtlasFlowController } from './lib/components/flow-controller';
export { ATLAS_UI } from './lib/atlas.ui';

// Route guards
export {
  atlasGuard,
  atlasChildGuard,
  type AtlasGuardOptions,
} from './lib/guards/atlas.guard';

// Theming, i18n, authorization, data shapes, FAPI re-exports
export * from './lib/appearance';
export * from './lib/i18n';
export * from './lib/protect';
export * from './lib/types';
export * from './lib/fapi';
