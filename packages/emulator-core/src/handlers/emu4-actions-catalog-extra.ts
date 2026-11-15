/**
 * Declared outputs for the first-party actions, and more first-party packs. Each endpoint was read from the provider's own
 * API reference:
 *  Asana     https://developers.asana.com/reference/gettasks , .../createtask , .../getworkspaces
 *  Dropbox   https://www.dropbox.com/developers/documentation/http/documentation#files-list_folder , #users-get_current_account
 *  Box       https://developer.box.com/reference/get-folders-id-items , https://developer.box.com/reference/get-users-me
 *  Calendly  https://developer.calendly.com/api-docs (users/me, event_types, scheduled_events)
 *  Airtable  https://airtable.com/developers/web/api/list-records , .../create-records , .../list-bases
 *  Zoom      https://developers.zoom.us/docs/api/meetings/ (users/{userId}/meetings, users/{userId})
 *  Spotify   https://developer.spotify.com/documentation/web-api/reference/get-current-users-profile , .../get-a-list-of-current-users-playlists
 *  Discord   https://discord.com/developers/docs/resources/user (users/@me, users/@me/guilds)
 *  Intercom  https://developers.intercom.com/docs/references/rest-api/api.intercom.io/contacts/listcontacts
 *  Figma     https://www.figma.com/developers/api (files/{key}, teams/{id}/projects)
 * An output schema lists only the fields a caller can rely on; extra fields never count as a change.
 */
const str = (description?: string, extra: Record<string, unknown> = {}) => ({ type: 'string', ...(description ? { description } : {}), ...extra });
const nstr = { type: ['string', 'null'] };
const num = { type: 'number' };
const int = { type: 'integer' };
const bool = { type: 'boolean' };
const arr = (items: unknown) => ({ type: 'array', items });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const input = (properties: Record<string, unknown>, required: string[] = []) => obj(properties, required);
const lim = (max: number) => ({ type: 'integer', minimum: 1, maximum: max });

/** `provider/action` -> output schema, for the actions defined in catalog.ts. */
export const BUILT_IN_OUTPUTS: Record<string, Record<string, unknown>> = {
  'github/list_issues': arr(obj({ number: int, title: str(), state: str() }, ['number', 'title'])),
  'github/get_issue': obj({ number: int, title: str(), state: str(), html_url: str() }, ['number', 'title']),
  'github/create_issue': obj({ number: int, html_url: str() }, ['number']),
  'slack_api/post_message': obj({ ok: bool, ts: str(), channel: str() }, ['ok']),
  'slack_api/list_channels': obj({ ok: bool, channels: arr(obj({ id: str(), name: str() }, ['id'])) }, ['ok']),
  'slack_api/list_messages': obj({ ok: bool, messages: arr(obj({ ts: str(), text: str() }, ['ts'])) }, ['ok']),
  'slack_api/list_users': obj({ ok: bool, members: arr(obj({ id: str(), name: str() }, ['id'])) }, ['ok']),
  'google/list_gmail_messages': obj({ messages: arr(obj({ id: str(), threadId: str() }, ['id'])), nextPageToken: str(), resultSizeEstimate: int }),
  'google/get_gmail_message': obj({ id: str(), threadId: str() }, ['id']),
  'google/list_calendar_events': obj({ items: arr(obj({ id: str(), summary: str() }, ['id'])), nextPageToken: str() }, ['items']),
  'google/create_calendar_event': obj({ id: str(), htmlLink: str() }, ['id']),
  'google/send_gmail_message': obj({ id: str(), threadId: str() }, ['id']),
  'linear/list_issues': obj({ nodes: arr(obj({ id: str(), identifier: str() }, ['id'])) }, ['nodes']),
  'linear/list_teams': obj({ nodes: arr(obj({ id: str(), key: str(), name: str() }, ['id'])) }, ['nodes']),
  'linear/create_issue': obj({ success: bool }, ['success']),
  'notion/create_page': obj({ id: str(), object: str() }, ['id']),
  'hubspot/create_contact': obj({ id: str() }, ['id']),
  'hubspot/list_contacts': obj({ results: arr(obj({ id: str() }, ['id'])) }, ['results']),
};

const A_BASE = 'https://app.asana.com/api/1.0';
const DBX = 'https://api.dropboxapi.com/2';
const BOX = 'https://api.box.com/2.0';
const CAL = 'https://api.calendly.com';
const AIR = 'https://api.airtable.com/v0';
const ZOOM = 'https://api.zoom.us/v2';
const SPOT = 'https://api.spotify.com/v1';
const DISCORD = 'https://discord.com/api/v10';
const ICOM = 'https://api.intercom.io';
const FIGMA = 'https://api.figma.com/v1';
const ASANA_ITEM = obj({ gid: str(), name: str(), resource_type: str() }, ['gid']);

export const EXTRA_ACTIONS: [string, string, unknown][] = [
  ['asana', 'list_workspaces', {
    description: 'List the workspaces the token can see.',
    input: input({}),
    request: { method: 'GET', base_url: A_BASE, path: '/workspaces' },
    output: obj({ data: arr(ASANA_ITEM) }, ['data']), mutating: false,
  }],
  ['asana', 'list_tasks', {
    description: 'List tasks of a project, or of an assignee in a workspace.',
    input: input({ project: str('Project gid.'), workspace: str('Workspace gid (with assignee).'), assignee: str('User gid or "me" (with workspace).'), limit: lim(100), offset: str('The next_page.offset of a previous call.') }),
    request: { method: 'GET', base_url: A_BASE, path: '/tasks', query: { project: '{project}', workspace: '{workspace}', assignee: '{assignee}', limit: '{limit}', offset: '{offset}' } },
    output: obj({ data: arr(ASANA_ITEM), next_page: { type: ['object', 'null'] } }, ['data']),
    paginate: { type: 'cursor', cursor_path: 'next_page.offset', cursor_param: 'offset', items_path: 'data' }, mutating: false,
  }],
  ['asana', 'create_task', {
    description: 'Create a task.',
    input: input({ name: str('Task name.'), notes: str('Task notes.'), workspace: str('Workspace gid (when no project).'), projects: arr(str()), assignee: str('User gid or "me".'), due_on: str('Due date, YYYY-MM-DD.') }, ['name']),
    request: { method: 'POST', base_url: A_BASE, path: '/tasks', body: { data: { name: '{name}', notes: '{notes}', workspace: '{workspace}', projects: '{projects}', assignee: '{assignee}', due_on: '{due_on}' } } },
    output: obj({ data: ASANA_ITEM }, ['data']), mutating: true,
  }],
  ['dropbox', 'get_current_account', {
    description: 'Read the connected Dropbox account.',
    input: input({}),
    request: { method: 'POST', base_url: DBX, path: '/users/get_current_account' },
    output: obj({ account_id: str(), email: str(), name: obj({ display_name: str() }) }, ['account_id']), mutating: false,
  }],
  ['dropbox', 'list_folder', {
    description: 'List the entries of a folder ("" is the root).',
    input: input({ path: str('Folder path; empty for the root.'), recursive: bool, limit: lim(2000) }, ['path']),
    request: { method: 'POST', base_url: DBX, path: '/files/list_folder', body: { path: '{path}', recursive: '{recursive}', limit: '{limit}' } },
    output: obj({ entries: arr(obj({ name: str(), path_lower: nstr, id: str() }, ['name'])), cursor: str(), has_more: bool }, ['entries']), mutating: false,
  }],
  ['box', 'get_current_user', {
    description: 'Read the connected Box user.',
    input: input({}),
    request: { method: 'GET', base_url: BOX, path: '/users/me' },
    output: obj({ id: str(), name: str(), login: str() }, ['id']), mutating: false,
  }],
  ['box', 'list_folder_items', {
    description: 'List the items of a folder ("0" is the root).',
    input: input({ folder_id: str('Folder id; 0 for the root.'), limit: lim(1000), offset: { type: 'integer', minimum: 0 } }, ['folder_id']),
    request: { method: 'GET', base_url: BOX, path: '/folders/{folder_id}/items', query: { limit: '{limit}', offset: '{offset}' } },
    output: obj({ total_count: int, entries: arr(obj({ id: str(), type: str(), name: str() }, ['id'])) }, ['entries']), mutating: false,
  }],
  ['calendly', 'get_current_user', {
    description: 'Read the connected Calendly user (its uri is the `user` the other actions take).',
    input: input({}),
    request: { method: 'GET', base_url: CAL, path: '/users/me' },
    output: obj({ resource: obj({ uri: str(), name: str(), email: str() }, ['uri']) }, ['resource']), mutating: false,
  }],
  ['calendly', 'list_event_types', {
    description: 'List a user\'s event types.',
    input: input({ user: str('The user uri from get_current_user.'), count: lim(100), page_token: str('pagination.next_page_token of a previous call.') }, ['user']),
    request: { method: 'GET', base_url: CAL, path: '/event_types', query: { user: '{user}', count: '{count}', page_token: '{page_token}' } },
    output: obj({ collection: arr(obj({ uri: str(), name: str() }, ['uri'])), pagination: { type: 'object' } }, ['collection']), mutating: false,
  }],
  ['calendly', 'list_scheduled_events', {
    description: 'List a user\'s scheduled events.',
    input: input({ user: str('The user uri from get_current_user.'), status: str('active or canceled.', { enum: ['active', 'canceled'] }), count: lim(100), page_token: str('pagination.next_page_token of a previous call.') }, ['user']),
    request: { method: 'GET', base_url: CAL, path: '/scheduled_events', query: { user: '{user}', status: '{status}', count: '{count}', page_token: '{page_token}' } },
    output: obj({ collection: arr(obj({ uri: str(), name: str(), start_time: str() }, ['uri'])), pagination: { type: 'object' } }, ['collection']), mutating: false,
  }],
  ['airtable', 'list_bases', {
    description: 'List the bases the token can see.',
    input: input({}),
    request: { method: 'GET', base_url: AIR, path: '/meta/bases' },
    output: obj({ bases: arr(obj({ id: str(), name: str() }, ['id'])) }, ['bases']), mutating: false,
  }],
  ['airtable', 'list_records', {
    description: 'List records of a table.',
    input: input({ base_id: str('Base id (app...).'), table: str('Table id or name.'), pageSize: lim(100), maxRecords: { type: 'integer', minimum: 1 }, view: str('View name or id.'), offset: str('The offset of a previous call.') }, ['base_id', 'table']),
    request: { method: 'GET', base_url: AIR, path: '/{base_id}/{table}', query: { pageSize: '{pageSize}', maxRecords: '{maxRecords}', view: '{view}', offset: '{offset}' } },
    output: obj({ records: arr(obj({ id: str(), createdTime: str(), fields: { type: 'object' } }, ['id'])), offset: str() }, ['records']),
    paginate: { type: 'cursor', cursor_path: 'offset', cursor_param: 'offset', items_path: 'records' }, mutating: false,
  }],
  ['airtable', 'create_records', {
    description: 'Create up to 10 records in a table.',
    input: input({ base_id: str('Base id (app...).'), table: str('Table id or name.'), records: { type: 'array', maxItems: 10, items: { type: 'object', description: '{ fields: { ... } }' } } }, ['base_id', 'table', 'records']),
    request: { method: 'POST', base_url: AIR, path: '/{base_id}/{table}', body: { records: '{records}' } },
    output: obj({ records: arr(obj({ id: str() }, ['id'])) }, ['records']), mutating: true,
  }],
  ['zoom', 'get_user', {
    description: 'Read a Zoom user ("me" is the connected user).',
    input: input({ user_id: str('User id, email or "me".') }, ['user_id']),
    request: { method: 'GET', base_url: ZOOM, path: '/users/{user_id}' },
    output: obj({ id: str(), email: str() }, ['id']), mutating: false,
  }],
  ['zoom', 'list_meetings', {
    description: 'List a user\'s meetings.',
    input: input({ user_id: str('User id, email or "me".'), type: str('scheduled, live, upcoming, upcoming_meetings or previous_meetings.'), page_size: lim(300), next_page_token: str('next_page_token of a previous call.') }, ['user_id']),
    request: { method: 'GET', base_url: ZOOM, path: '/users/{user_id}/meetings', query: { type: '{type}', page_size: '{page_size}', next_page_token: '{next_page_token}' } },
    output: obj({ meetings: arr(obj({ id: { type: ['integer', 'string'] }, topic: str() }, ['id'])), next_page_token: nstr }, ['meetings']),
    paginate: { type: 'cursor', cursor_path: 'next_page_token', cursor_param: 'next_page_token', items_path: 'meetings' }, mutating: false,
  }],
  ['zoom', 'create_meeting', {
    description: 'Schedule a meeting.',
    input: input({ user_id: str('User id, email or "me".'), topic: str('Meeting topic.'), type: { type: 'integer', description: '2 = scheduled meeting.' }, start_time: str('ISO 8601 start time.'), duration: { type: 'integer', minimum: 1 }, timezone: str('Timezone name.'), agenda: str('Agenda.') }, ['user_id']),
    request: { method: 'POST', base_url: ZOOM, path: '/users/{user_id}/meetings', body: { topic: '{topic}', type: '{type}', start_time: '{start_time}', duration: '{duration}', timezone: '{timezone}', agenda: '{agenda}' } },
    output: obj({ id: { type: ['integer', 'string'] }, join_url: str() }, ['id']), mutating: true,
  }],
  ['spotify', 'get_current_user', {
    description: 'Read the connected Spotify user.',
    input: input({}),
    request: { method: 'GET', base_url: SPOT, path: '/me' },
    output: obj({ id: str(), display_name: nstr }, ['id']), mutating: false,
  }],
  ['spotify', 'list_playlists', {
    description: 'List the user\'s playlists.',
    input: input({ limit: lim(50), offset: { type: 'integer', minimum: 0 } }),
    request: { method: 'GET', base_url: SPOT, path: '/me/playlists', query: { limit: '{limit}', offset: '{offset}' } },
    output: obj({ items: arr(obj({ id: str(), name: str() }, ['id'])), total: int, next: nstr }, ['items']), mutating: false,
  }],
  ['discord', 'get_current_user', {
    description: 'Read the connected Discord user.',
    input: input({}),
    request: { method: 'GET', base_url: DISCORD, path: '/users/@me' },
    output: obj({ id: str(), username: str() }, ['id']), mutating: false,
  }],
  ['discord', 'list_guilds', {
    description: 'List the servers the user is in.',
    input: input({ limit: lim(200), after: str('Guild id to start after.') }),
    request: { method: 'GET', base_url: DISCORD, path: '/users/@me/guilds', query: { limit: '{limit}', after: '{after}' } },
    output: arr(obj({ id: str(), name: str() }, ['id'])), mutating: false,
  }],
  ['intercom', 'list_contacts', {
    description: 'List contacts (cursor `starting_after` from pages.next.starting_after).',
    input: input({ per_page: lim(150), starting_after: str('Cursor from pages.next.starting_after.') }),
    request: { method: 'GET', base_url: ICOM, path: '/contacts', query: { per_page: '{per_page}', starting_after: '{starting_after}' }, headers: { 'intercom-version': '2.11' } },
    output: obj({ data: arr(obj({ id: str(), email: nstr }, ['id'])), pages: { type: 'object' } }, ['data']),
    paginate: { type: 'cursor', cursor_path: 'pages.next.starting_after', cursor_param: 'starting_after', items_path: 'data' }, mutating: false,
  }],
  ['figma', 'get_file', {
    description: 'Read a Figma file (add depth=1 to keep the answer small).',
    input: input({ file_key: str('The file key from its URL.'), depth: { type: 'integer', minimum: 1, maximum: 4 } }, ['file_key']),
    request: { method: 'GET', base_url: FIGMA, path: '/files/{file_key}', query: { depth: '{depth}' } },
    output: obj({ name: str(), lastModified: str(), document: { type: 'object' } }, ['name']), mutating: false,
  }],
  ['figma', 'list_team_projects', {
    description: 'List the projects of a team.',
    input: input({ team_id: str('Team id.') }, ['team_id']),
    request: { method: 'GET', base_url: FIGMA, path: '/teams/{team_id}/projects' },
    output: obj({ projects: arr(obj({ id: str(), name: str() }, ['id'])) }, ['projects']), mutating: false,
  }],
];
