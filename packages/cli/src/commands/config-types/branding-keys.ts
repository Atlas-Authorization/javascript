/**
 * Every key the branding PATCH takes, nested: `null` is a value with nothing to check inside, `'*'` a map
 * with free keys, `'[]'` a list of objects. A drift test in apps/api compares it with the published schema,
 * so plan refuses a nested key the server would drop or refuse, not only apply.
 */
export interface KeyTree {
  [key: string]: KeyTree | null;
}

export const BRANDING_KEY_TREE: KeyTree = {
  applicationName: null,
  logoUrl: null,
  faviconUrl: null,
  colorPrimary: null,
  colorBackground: null,
  colorText: null,
  supportEmail: null,
  colorAccent: null,
  colorCard: null,
  colorBorder: null,
  borderRadius: null,
  theme: null,
  fontFamily: null,
  fontUrl: null,
  layout: null,
  background: { type: null, color: null, from: null, to: null, angle: null, imageUrl: null },
  providers: { order: null, hidden: null },
  copy: { eyebrow: null, headline: null, subheadline: null, footer: null },
  socialButtons: { variant: null, size: null, layout: null, labels: { "*": null }, displayNames: { "*": null }, icons: { "*": null }, modes: { "*": null }, search: null, styles: { "*": null } },
  codeInput: null,
  card: { width: null, align: null, logoSize: null },
  typography: { headingSize: null, headingWeight: null },
  buttonShape: null,
  cardBorder: null,
  inputSize: null,
  interaction: { buttonStyle: null, buttonEffect: null, shadow: null, density: null, inputStyle: null, animations: null, motionSpeed: null, motionEasing: null, loading: null },
  backgroundPattern: null,
  cardStyle: null,
  textScale: null,
  socialPlacement: null,
  sectionOrder: null,
  legal: { termsUrl: null, privacyUrl: null, required: null },
  signUpFields: { "[]": { key: null, label: null, type: null, required: null, placeholder: null, options: null, collect_on: null, reprompt_days: null } },
  accountPortal: { panels: { "*": null } },
  audiences: { "*": { heading: null, subheading: null, logoUrl: null, primaryColor: null } },
  customCss: null,
  customHtmlHeader: null,
  customHtmlFooter: null,
  // Aliases the API normalises on write.
  account_portal: { panels: { '*': null } },
  favicon_url: null,
  favicon: null,
};
