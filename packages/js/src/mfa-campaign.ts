/**
 * MFA rollout campaigns, as the signed-in user sees them. Ask `getMfaCampaignPrompt` after sign-in (and whenever the
 * app opens). When `eligible` is true, show your "set up a second factor" screen, report `shown`, and report
 * `accepted` or `dismissed` from what the person does. While a campaign is enforcing (`phase: 'enforcing'`) the prompt
 * is always eligible: sign-in itself already requires the second factor, so a dismissed prompt comes back.
 */
import type { FapiClient, FapiResponse } from './fapi';

export interface MfaCampaignPrompt {
  object: 'mfa_campaign_prompt';
  /** Show the prompt now: the nag interval has elapsed, or the campaign is enforcing. */
  eligible: boolean;
  campaign_id?: string;
  name?: string;
  phase?: 'nag' | 'enforcing';
  /** The factor classes asked for (`totp`, `sms`, `passkey`, `push`). Empty: any second factor. */
  required_factors?: string[];
  enforce?: boolean;
  /** The deadline (epoch ms) after which the campaign is enforced, when it has one. */
  grace_until?: number | null;
  days_left?: number | null;
  nag_interval_days?: number;
}

export type MfaCampaignEvent = 'shown' | 'dismissed' | 'accepted';

/** The campaign to show first, or `{ eligible: false }` when none applies to this user. */
export function getMfaCampaignPrompt(client: FapiClient): Promise<FapiResponse<MfaCampaignPrompt>> {
  return client.get<MfaCampaignPrompt>('/v1/client/me/mfa/campaign');
}

/** Tell the server what happened to the prompt. `shown` starts the nag interval. */
export function reportMfaCampaignEvent(client: FapiClient, campaignId: string, event: MfaCampaignEvent): Promise<FapiResponse<{ object: 'mfa_campaign_event'; event: MfaCampaignEvent; campaign_id: string }>> {
  return client.post('/v1/client/me/mfa/campaign/events', { event, campaign_id: campaignId });
}
