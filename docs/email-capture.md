# Private Gmail capture

Email capture runs in Folio's existing trusted Next.js server and PostgreSQL database. Each Admin/Member can connect one personal Gmail mailbox per workspace. Other members, including Admins, cannot read that connection's metadata or captured content. A Viewer can inspect their own retained capture and disconnect/delete it, but cannot connect, change settings or sync.

## Deployment configuration

Configure the optional server requirements in `.neander/compose.yaml` (or ignored local environment):

- `FOLIO_GOOGLE_CLIENT_ID` and `FOLIO_GOOGLE_CLIENT_SECRET`: deployment-owned Google OAuth web client with Gmail API enabled.
- `FOLIO_GOOGLE_REDIRECT_URI`: the exact registered public HTTPS callback ending in `/api/mail/callback`. Local HTTP loopback is accepted for development.
- `FOLIO_MAIL_ENCRYPTION_KEY`: exactly32 random bytes encoded as canonical base64. Generate/store securely; preserve the same key across replicas, restarts and backups. Changing it makes prior encrypted tokens/content unreadable. Restore the previous key or explicitly disconnect to delete local capture.

Unset/invalid configuration visibly remains unconfigured. Connecting requires `gmail.readonly`, offline access and consent. A Gmail label is an application import filter; the OAuth permission still grants mailbox read access. Deployment owners must complete Google's applicable consent/verification requirements before offering this integration. No Google account, OAuth project, production deployment or live-provider verification is supplied by this feature.

OAuth state is short-lived, single-use and bound to the signed-in session, user and workspace. PKCE/code exchange, refresh and revocation use `google-auth-library`. Credentials and message payloads use AES-256-GCM at rest and never reach browser storage/responses/logs. The browser receives only the signed-in user's permitted capture. Server responses disable caching.

## User workflow and limits

1. Connect Gmail. This imports nothing. Reconnecting a different mailbox requires explicitly deleting the previous connection.
2. Choose one personal (non-system) label and save it with capture off. Changing labels deletes prior copies/progress. Separately enable capture.
3. Use **Sync now**, then **Continue sync** for additional pages. Each request reads at most20 message IDs and500 per complete run. Narrow the label and restart progress if the limit is reached. Last completed sync updates only after the final page; each successful page/cursor persists. A failed page is safe to retry. Sync is manual; no background job/offline schedule is promised.
4. Captured plain text appears privately on Email capture and matched active-person/company records. Label membership is checked per message; spam/trash, attachments, HTML-only, oversized (>64KiB body), unmatched or ambiguous email matches are skipped. UTF-8 plain text is the supported content format. No contacts are created, mail sent or shared. Matching excludes the connected mailbox's own address.
5. A full completed sync reconciles removed labels/messages. Earlier copies remain private until that reconciliation finishes, the label changes or the connection is deleted. Pause stops imports while retaining copies. Editing a CRM email/deleting its record removes that record's access to old captured mail; links are checked on each read.
6. Disconnect deletes local tokens, pending consent, progress and messages atomically, even without a usable encryption key. Remote revocation is attempted afterward. A failed remote revoke is reported; remove Folio's grant in Google account settings if needed. Local deletion is not undone.

The connection row serializes settings/sync/disconnect. Settings use version conflicts, preserve the UI draft and offer explicit reload. Rules and lists retain their existing workspace/list permissions; mail is never attached to a shared note or inferred from an arbitrary deal-owner label.

## Controlled verification

`scripts/check-mail.ts` runs the real OAuth library against `scripts/mail-controlled-provider.ts`, an HTTP provider of fictional codes/tokens/messages. It does not contact Google. Built browser verification can use a separate explicitly labelled test mode: `FOLIO_MAIL_CONTROLLED_PROVIDER=1`, `FOLIO_MAIL_TEST_AUTH_ORIGIN` (browser loopback), `FOLIO_MAIL_TEST_TRANSPORT_ORIGIN` (server loopback or Docker's host.docker.internal). Both origins must be HTTP loopback origins. Normal runtime uses fixed Google endpoints and ignores test-origin overrides. These variables are not deployment recipe requirements; never enable test mode for real accounts.

Official protocol references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [Google OAuth library](https://googleapis.dev/nodejs/google-auth-library/latest/), [Gmail message listing](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list). Controlled results establish the configured adapter contract, not live Gmail account/consent approval or managed deployment behavior.
