import type { ActionDef } from './emu4-actions-def';
import { parseActionDef } from './emu4-actions-def';
import { BUILT_IN_OUTPUTS, EXTRA_ACTIONS } from './emu4-actions-catalog-extra';

/**
 * First-party action packs. Each endpoint was read from the provider's own API reference:
 *  GitHub  https://docs.github.com/en/rest/issues/issues
 *  Slack   https://docs.slack.dev/reference/methods/chat.postMessage , .../conversations.list
 *  Notion  https://developers.notion.com/reference/post-page
 *  HubSpot https://developers.hubspot.com/docs/api/crm/contacts
 *  Slack   https://docs.slack.dev/reference/methods/conversations.history , .../users.list
 *  Google  https://developers.google.com/workspace/calendar/api/v3/reference/events/insert , .../events/list ,
 *          https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send , .../users.messages/list , .../users.messages/get
 *  Linear  GraphQL at https://api.linear.app/graphql (https://linear.app/developers/graphql), schema:
 *          https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql (Query.issues, Query.teams, Mutation.issueCreate)
 * More providers come from custom definitions (PUT /v1/connection_actions/{provider}/{name}).
 */
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

const GH = 'https://api.github.com';
const GH_H = { accept: 'application/vnd.github+json' };
const SLACK = 'https://slack.com/api';
const SLACK_OK = { ok_field: 'ok', error_field: 'error' };
const HUB = 'https://api.hubapi.com';

const RAW: [string, string, unknown][] = [
  ['github', 'list_issues', {
    description: 'List the issues of a repository.',
    input: obj({ owner: str('Repository owner.'), repo: str('Repository name.'), state: str('open, closed or all.', { enum: ['open', 'closed', 'all'] }), per_page: { type: 'integer', minimum: 1, maximum: 100 }, page: { type: 'integer', minimum: 1 } }, ['owner', 'repo']),
    request: { method: 'GET', base_url: GH, path: '/repos/{owner}/{repo}/issues', query: { state: '{state}', per_page: '{per_page}', page: '{page}' }, headers: GH_H },
    scopes: [], mutating: false,
  }],
  ['github', 'get_issue', {
    description: 'Read one issue.',
    input: obj({ owner: str('Repository owner.'), repo: str('Repository name.'), issue_number: { type: 'integer', minimum: 1 } }, ['owner', 'repo', 'issue_number']),
    request: { method: 'GET', base_url: GH, path: '/repos/{owner}/{repo}/issues/{issue_number}', headers: GH_H },
    mutating: false,
  }],
  ['github', 'create_issue', {
    description: 'Open an issue in a repository.',
    input: obj({ owner: str('Repository owner.'), repo: str('Repository name.'), title: str('Issue title.', { minLength: 1 }), body: str('Issue body.'), labels: { type: 'array', items: { type: 'string' } }, assignees: { type: 'array', items: { type: 'string' } } }, ['owner', 'repo', 'title']),
    request: { method: 'POST', base_url: GH, path: '/repos/{owner}/{repo}/issues', body: { title: '{title}', body: '{body}', labels: '{labels}', assignees: '{assignees}' }, headers: GH_H },
    mutating: true,
  }],
  ['slack_api', 'post_message', {
    description: 'Post a message to a channel or conversation.',
    input: obj({ channel: str('Channel id or name.'), text: str('Message text.', { minLength: 1 }), thread_ts: str('Reply in this thread.') }, ['channel', 'text']),
    request: { method: 'POST', base_url: SLACK, path: '/chat.postMessage', body: { channel: '{channel}', text: '{text}', thread_ts: '{thread_ts}' }, headers: { 'content-type': 'application/json; charset=utf-8' } },
    response: SLACK_OK, mutating: true,
  }],
  ['slack_api', 'list_channels', {
    description: 'List channels the token can see.',
    input: obj({ types: str('Comma-separated: public_channel, private_channel, mpim, im.'), limit: { type: 'integer', minimum: 1, maximum: 999 }, cursor: str('The next_cursor of a previous call.'), exclude_archived: { type: 'boolean' } }),
    request: { method: 'GET', base_url: SLACK, path: '/conversations.list', query: { types: '{types}', limit: '{limit}', cursor: '{cursor}', exclude_archived: '{exclude_archived}' } },
    response: SLACK_OK, mutating: false,
  }],
  ['slack_api', 'list_messages', {
    description: 'Read the message history of a conversation, newest first.',
    input: obj({ channel: str('Conversation id.'), limit: { type: 'integer', minimum: 1, maximum: 999 }, cursor: str('The next_cursor of a previous call.'), oldest: str('Only messages after this Unix timestamp.'), latest: str('Only messages before this Unix timestamp.') }, ['channel']),
    request: { method: 'GET', base_url: SLACK, path: '/conversations.history', query: { channel: '{channel}', limit: '{limit}', cursor: '{cursor}', oldest: '{oldest}', latest: '{latest}' } },
    response: SLACK_OK, paginate: { type: 'cursor', cursor_path: 'response_metadata.next_cursor', cursor_param: 'cursor', items_path: 'messages' }, mutating: false,
  }],
  ['slack_api', 'list_users', {
    description: 'List the workspace\'s users.',
    input: obj({ limit: { type: 'integer', minimum: 1, maximum: 999 }, cursor: str('The next_cursor of a previous call.') }),
    request: { method: 'GET', base_url: SLACK, path: '/users.list', query: { limit: '{limit}', cursor: '{cursor}' } },
    response: SLACK_OK, paginate: { type: 'cursor', cursor_path: 'response_metadata.next_cursor', cursor_param: 'cursor', items_path: 'members' }, mutating: false,
  }],
  ['google', 'list_gmail_messages', {
    description: 'List message ids of the signed-in user\'s mailbox (use get_gmail_message for content).',
    input: obj({ q: str('Gmail search query.'), maxResults: { type: 'integer', minimum: 1, maximum: 500 }, pageToken: str('nextPageToken of a previous call.'), includeSpamTrash: { type: 'boolean' } }),
    request: { method: 'GET', base_url: 'https://gmail.googleapis.com', path: '/gmail/v1/users/me/messages', query: { q: '{q}', maxResults: '{maxResults}', pageToken: '{pageToken}', includeSpamTrash: '{includeSpamTrash}' } },
    paginate: { type: 'cursor', cursor_path: 'nextPageToken', cursor_param: 'pageToken', items_path: 'messages' }, mutating: false,
  }],
  ['google', 'get_gmail_message', {
    description: 'Read one Gmail message.',
    input: obj({ id: str('Message id.'), format: str('minimal, full, raw or metadata.', { enum: ['minimal', 'full', 'raw', 'metadata'] }) }, ['id']),
    request: { method: 'GET', base_url: 'https://gmail.googleapis.com', path: '/gmail/v1/users/me/messages/{id}', query: { format: '{format}' } },
    mutating: false,
  }],
  ['google', 'list_calendar_events', {
    description: 'List events of a calendar.',
    input: obj({ calendar_id: str('Calendar id; "primary" for the signed-in user.'), timeMin: str('RFC3339 lower bound for an event\'s end.'), timeMax: str('RFC3339 exclusive upper bound for an event\'s start.'), maxResults: { type: 'integer', minimum: 1, maximum: 2500 }, pageToken: str('nextPageToken of a previous call.'), singleEvents: { type: 'boolean' }, orderBy: str('startTime (needs singleEvents) or updated.', { enum: ['startTime', 'updated'] }), q: str('Free-text search.') }, ['calendar_id']),
    request: { method: 'GET', base_url: 'https://www.googleapis.com', path: '/calendar/v3/calendars/{calendar_id}/events', query: { timeMin: '{timeMin}', timeMax: '{timeMax}', maxResults: '{maxResults}', pageToken: '{pageToken}', singleEvents: '{singleEvents}', orderBy: '{orderBy}', q: '{q}' } },
    paginate: { type: 'cursor', cursor_path: 'nextPageToken', cursor_param: 'pageToken', items_path: 'items' }, mutating: false,
  }],
  ['linear', 'list_issues', {
    description: 'List issues (newest first by default). Pass `after` from pageInfo.endCursor for the next page.',
    input: obj({ first: { type: 'integer', minimum: 1, maximum: 250 }, after: str('pageInfo.endCursor of a previous call.') }),
    request: { method: 'POST', base_url: 'https://api.linear.app', path: '/graphql', body: { query: 'query($first: Int, $after: String) { issues(first: $first, after: $after) { nodes { id identifier title url state { name } } pageInfo { hasNextPage endCursor } } }', variables: { first: '{first}', after: '{after}' } } },
    response: { path: 'data.issues' }, mutating: false,
  }],
  ['linear', 'list_teams', {
    description: 'List teams.',
    input: obj({ first: { type: 'integer', minimum: 1, maximum: 250 }, after: str('pageInfo.endCursor of a previous call.') }),
    request: { method: 'POST', base_url: 'https://api.linear.app', path: '/graphql', body: { query: 'query($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }', variables: { first: '{first}', after: '{after}' } } },
    response: { path: 'data.teams' }, mutating: false,
  }],
  ['linear', 'create_issue', {
    description: 'Create an issue in a team. Linear reports failures in an `errors` array with HTTP 200, so check the result.',
    input: obj({ teamId: str('Team id (see list_teams).'), title: str('Issue title.', { minLength: 1 }), description: str('Markdown description.') }, ['teamId', 'title']),
    request: { method: 'POST', base_url: 'https://api.linear.app', path: '/graphql', body: { query: 'mutation($teamId: String!, $title: String, $description: String) { issueCreate(input: { teamId: $teamId, title: $title, description: $description }) { success issue { id identifier title url } } }', variables: { teamId: '{teamId}', title: '{title}', description: '{description}' } } },
    response: { path: 'data.issueCreate' }, mutating: true,
  }],
  ['notion', 'create_page', {
    description: 'Create a page under a page or a data source.',
    input: obj({ parent: { type: 'object', description: 'One of { page_id } or { data_source_id }.' }, properties: { type: 'object', description: 'Property values keyed by name.' }, children: { type: 'array', maxItems: 100, items: { type: 'object' } } }, ['parent', 'properties']),
    request: { method: 'POST', base_url: 'https://api.notion.com', path: '/v1/pages', body: { parent: '{parent}', properties: '{properties}', children: '{children}' }, headers: { 'notion-version': '2026-03-11' } },
    mutating: true,
  }],
  ['hubspot', 'create_contact', {
    description: 'Create a CRM contact.',
    input: obj({ email: str('Email address.'), firstname: str('First name.'), lastname: str('Last name.') }, ['email']),
    request: { method: 'POST', base_url: HUB, path: '/crm/v3/objects/contacts', body: { properties: { email: '{email}', firstname: '{firstname}', lastname: '{lastname}' } } },
    mutating: true,
  }],
  ['hubspot', 'list_contacts', {
    description: 'List CRM contacts (cursor `after` from the previous page).',
    input: obj({ limit: { type: 'integer', minimum: 1, maximum: 100 }, after: str('Cursor from paging.next.after.'), properties: str('Comma-separated property names to return.') }),
    request: { method: 'GET', base_url: HUB, path: '/crm/v3/objects/contacts', query: { limit: '{limit}', after: '{after}', properties: '{properties}' } },
    paginate: { type: 'cursor', cursor_path: 'paging.next.after', cursor_param: 'after', items_path: 'results' }, mutating: false,
  }],
  ['google', 'create_calendar_event', {
    description: 'Create a calendar event.',
    input: obj({ calendar_id: str('Calendar id; "primary" for the signed-in user.'), summary: str('Event title.'), start: { type: 'object', description: '{ dateTime, timeZone } or { date }.' }, end: { type: 'object', description: '{ dateTime, timeZone } or { date }.' }, description: str('Event description.') }, ['calendar_id', 'start', 'end']),
    request: { method: 'POST', base_url: 'https://www.googleapis.com', path: '/calendar/v3/calendars/{calendar_id}/events', body: { summary: '{summary}', description: '{description}', start: '{start}', end: '{end}' } },
    scopes: [], mutating: true,
  }],
  ['google', 'send_gmail_message', {
    description: 'Send an email from the signed-in user. `raw` is the RFC 2822 message, base64url-encoded.',
    input: obj({ raw: str('Base64url RFC 2822 message.', { minLength: 1 }) }, ['raw']),
    request: { method: 'POST', base_url: 'https://gmail.googleapis.com', path: '/gmail/v1/users/me/messages/send', body: { raw: '{raw}' } },
    mutating: true,
  }],
];

export const BUILT_IN_ACTIONS: ActionDef[] = [
  // The original packs gain their declared outputs from catalog-extra; the newer packs carry their own.
  ...RAW.map(([p, n, d]) => parseActionDef(p, n, { ...(d as object), ...(BUILT_IN_OUTPUTS[`${p}/${n}`] ? { output: BUILT_IN_OUTPUTS[`${p}/${n}`] } : {}) })),
  ...EXTRA_ACTIONS.map(([p, n, d]) => parseActionDef(p, n, d)),
];
export const builtInFor = (provider: string) => BUILT_IN_ACTIONS.filter((a) => a.provider === provider);
