import { AtlasSignedInDirective } from './directives/signed-in.directive';
import { AtlasSignedOutDirective } from './directives/signed-out.directive';
import { AtlasLoadingDirective } from './directives/loading.directive';
import { AtlasLoadedDirective } from './directives/loaded.directive';
import { AtlasProtectDirective } from './directives/protect.directive';
import { AtlasRootDirective } from './directives/atlas-root.directive';
import { SignInComponent } from './components/sign-in.component';
import { SignUpComponent } from './components/sign-up.component';
import { UserButtonComponent } from './components/user-button.component';
import { OrganizationSwitcherComponent } from './components/organization-switcher.component';
import { UserProfileComponent } from './components/user-profile.component';
import { OrganizationProfileComponent } from './components/organization-profile.component';

/**
 * Every standalone directive and component the SDK ships. Import the array in a
 * standalone component's `imports`, or rely on `AtlasModule` re-exporting it for
 * NgModule-based apps:
 *
 * ```ts
 * @Component({ standalone: true, imports: [...ATLAS_UI], template: '…' })
 * ```
 */
export const ATLAS_UI = [
  AtlasSignedInDirective,
  AtlasSignedOutDirective,
  AtlasLoadingDirective,
  AtlasLoadedDirective,
  AtlasProtectDirective,
  AtlasRootDirective,
  SignInComponent,
  SignUpComponent,
  UserButtonComponent,
  OrganizationSwitcherComponent,
  UserProfileComponent,
  OrganizationProfileComponent,
] as const;
