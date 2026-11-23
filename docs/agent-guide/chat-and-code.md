# Chat and Code roadmap

Conduit has a projectless conversation inbox for general Chat and a separate workspace for Code. Code uses OpenCode sessions and streaming. Chat uses tool-free generation. The dedicated OpenCode runtime provides stateless replies, and an optional NodeCode stream adapter delivers incremental text.

## NodeCode onboarding

- **Settings → Integrations → NodeCode** connects a regular key through OpenCode, reports the connected server version, and distinguishes a saved credential from an available model and a successful response.
- The NodeCode card uses the project-scoped integration catalog. A live server can list a custom integration while the single-integration endpoint returns 404, so the card uses the catalog for discovery.
- **Test connection** sends a single short generation request that can use account credit. **New chat with Cyber v1** uses OpenCode's session creation model field. The model belongs to the new session.
- Read [architecture](architecture.md) and [testing](testing.md) before changing the relay. Start with `src/lib/handlers/nodecode.ts`, `src/lib/nodecode.ts`, and `src/lib/frontend/components/overlays/NodecodeCard.svelte`. The other provider and session controls continue to use the shared client in `src/lib/instance/opencode-client.ts`.

## Milestones and release checks

| Work item | Implementation | Verification |
| --- | --- | --- |
| NodeCode preview | Provider Setup and Code session model selection | Existing account inference and restored session in the local browser preview. Physical iPhone PWA check pending. |
| Chat isolation | Dedicated model runtime, private home, separate network namespace with a fixed TLS bridge, authenticated relay routes | Relay routing and storage tests, plus live tool-free NodeCode generation in the isolated runtime. |
| Chat inbox and temporary mode | Projectless routes, conversation history, text drafts and attachments, memory-only temporary chats | Desktop and mobile browser workflows and relay storage tests. |
| Private search | Explicit query review, isolated Mullvad worker, reviewed snippets and page excerpts, citations | Worker and relay regressions, browser replay, and live fail-closed preview with the VPN disconnected. Keyless SearXNG search and live page reading were verified through a dedicated Mullvad tunnel. |
| Code handoff | Review and edit one message, select a Code project, and create an unsent Code draft | Desktop and mobile browser replay creates a Code session, verifies the edited draft survives reload and detects any automatic send. |

## Privacy and release boundaries

- Tailscale is the route from the phone to Conduit. Mullvad is the route from the search worker to the web.
- A hosted model receives the prompt and any excerpts supplied for the answer. A search provider can see the query and any search account identifier. Keep those distinctions visible in the product.
- Keep search disabled until the worker can prove its restricted egress. Use an existing Brave Search credential or the bundled keyless SearXNG profile.
- Keep machine-specific configs, account keys, saved conversations, and private preview addresses outside this public repository. Keep each milestone independently reviewable.

## Verification

Run `pnpm check`, `pnpm lint`, `pnpm test:unit`, and `pnpm build` from this checkout. The NodeCode card has desktop and mobile browser coverage in `test/e2e/specs/client-recovery.spec.ts`. That test simulates provider responses. A physical device and actual inference need separate checks.

### Preview results

- Live loopback preview against OpenCode 2.3.2. The NodeCode card found an existing connection and the short inference test succeeded.
- A mobile-sized Chromium session created a new Cyber v1 chat, received a real streamed response, and restored the conversation after reload. Physical iPhone acceptance is still outstanding.
- The isolated Chat runtime replied through the existing NodeCode account in a mobile-sized Chromium preview. The same preview verified search failed closed with Mullvad disconnected and a temporary transcript was absent after reload and on disk. A locally built worker container also returned HTTP 503 with its network disconnected. The desktop and mobile Chromium regression run passed all 56 Chat, recovery, and terminal cases.

## Running the projectless Chat preview

The **Chat** link opens `/chat`. Conversations have their own authenticated HTTP routes and inbox. A dedicated OpenCode 2.x runtime performs a single stateless, tool-free text generation per turn. It uses the NodeCode Cyber v1 model and receives the recent transcript plus any explicitly attached plain text. The isolated OpenCode endpoint returns a complete reply. To enable incremental Chat replies, set `CONDUIT_CHAT_NODECODE_API_KEY` in a protected relay environment file. The relay makes a fixed HTTPS streaming request to NodeCode with the same model and no tool definitions. The dedicated OpenCode endpoint remains the configuration for installations without the stream key. A failed stream is never retried automatically or sent to a different provider. Code sessions continue to use OpenCode streaming.

1. On Linux, install Bubblewrap and socat, then use the OpenCode 2.x binary already available to the relay. Give the Chat runtime its own server password. Store the password and the regular NodeCode key in a protected environment file outside the checkout.
2. Run `deploy/chat/run-opencode.sh` with `NODECODE_API_KEY` and `CONDUIT_CHAT_OPENCODE_PASSWORD` loaded into its environment. By default, the launcher binds port 4197, starts in an empty workspace, mounts a fresh home in memory, and passes only its dedicated provider and server credentials. Pin the OpenCode binary with `CONDUIT_CHAT_OPENCODE_BINARY` if needed.
3. Set `CONDUIT_CHAT_OPENCODE_URL=http://127.0.0.1:4197` and the matching `CONDUIT_CHAT_OPENCODE_PASSWORD` in the Conduit process environment, then start the relay. Keep the Chat runtime's port out of the Code registry, public proxy, and Tailscale Serve configuration.

The launcher uses an isolated Linux network namespace. Its only egress bridge forwards TLS connections to `api.nodecode.ai:443`. The runtime verifies the provider certificate. The only ingress is the dedicated loopback port via a private socket. The sandbox mounts system executables and certificate trust, plus an in-memory home and an empty workspace. Keep Code authenticated with separate credentials. The relay accepts no project, command, permission, or tool fields on Chat routes and refuses generation if a Code instance claims its port.

Ordinary conversations persist under the relay's `chat/` state directory and their unsent text drafts persist in the browser. Temporary chats stay in relay memory until restart, explicit deletion, or expiration after an hour without a completed turn. They have no inbox entry, shareable URL, or stored draft. The hosted model still sees temporary prompts. Chat keeps unsent attachments in the current tab until the page reloads.

The HTTP boundary regression is in `test/unit/server/http-router.test.ts`. The core files are `src/lib/chat/{http,service,types}.ts` and `src/lib/frontend/pages/ConversationPage.svelte`. The tool-free generation contract is documented in [OpenCode's HTTP API](https://opencode.ai/docs/api).

## Optional Mullvad search worker

Chat shows **Web search** only when Conduit has a worker URL and token. Type and review a query, then choose **Run search**. Search results and optional page excerpts stay in memory for up to ten minutes of usable access. To send them to NodeCode, review them and select the checkbox before sending a chat message. A regular chat stores the included source context with that turn. Temporary chat keeps it in memory.

1. Use a dedicated Mullvad WireGuard configuration and an existing Brave Search API credential. Keep both outside the repository with file mode `0600`. Make a protected worker env file with `BRAVE_SEARCH_API_KEY` and `CONDUIT_CHAT_SEARCH_TOKEN`. Generate the token with `openssl rand -hex 32`.
2. Set `CONDUIT_MULLVAD_WIREGUARD_FILE` and `CONDUIT_SEARCH_ENV_FILE` to the absolute paths of those two files. Run `docker compose -f deploy/search/compose.yaml up -d --build` on a host with Compose and a working WireGuard/TUN device. Gluetun owns the VPN network namespace and firewall. The worker shares that namespace, with a read-only filesystem and no added capabilities. Host publishing is loopback only. Never expose the worker through Tailscale Serve or a public proxy.
3. Set `CONDUIT_CHAT_SEARCH_URL=http://127.0.0.1:8754` and the same `CONDUIT_CHAT_SEARCH_TOKEN` on the relay. The default worker port is 8754. An authenticated JSON POST with body `{}` to the worker's `/status` path verifies Mullvad egress without sending a query. Pass the bearer header from a protected config file or stdin when checking it.
4. Verify a search and a page excerpt through the UI. Take the dedicated VPN service down, then verify that search and page reading return unavailable, ordinary Chat can still answer, and Tailscale still serves the relay. Bring the dedicated VPN instance back up and repeat the exit check.

Every request uses Mullvad's in-tunnel SOCKS5 address with remote DNS. The worker verifies the Mullvad exit before transmitting a query or page hostname and has no alternate transport. Brave can associate the reviewed query with its API account. Page reading starts only from a current search result, resolves public IPv4 through Cloudflare DoH over the tunnel, pins the validated destination with TLS hostname verification, and rejects redirects, non-public IPs, non-text media and oversized responses. Pages available only over IPv6 may still appear as indexed snippets. External source links in the transcript open in the browser when clicked and use the browser's own connection.

### Keyless SearXNG setup

Use the same dedicated Mullvad configuration and worker token. Put `CONDUIT_CHAT_SEARCH_PROVIDER=searxng` in the worker environment. Set `CONDUIT_SEARXNG_SECRET` to a separate random value via a protected Compose environment file. Run Compose with `-f deploy/search/compose.yaml -f deploy/search/compose.searxng.yaml up -d --build`. Keep the order of the files so relative paths resolve against the search deployment directory.

SearXNG listens on loopback inside the VPN namespace. Its engine connections use Mullvad's SOCKS5 proxy with remote DNS. The worker verifies exit before each search, sends only the reviewed query, and does not try another provider if the selected backend fails. Public search engines can throttle requests, and particular sites may reject excerpt fetching. The approved indexed results can still be used. The SearXNG container uses a disabled log driver because upstream errors may include query URLs.

Run `python3 -B -m unittest discover -s deploy/search -v` for worker regressions. The worker has no Chat history or model credential mounts and deliberately omits request details from its logs.

- [Mullvad SOCKS5 configuration](https://mullvad.net/en/help/socks5-proxy)
- [Gluetun WireGuard configuration](https://github.com/qdm12/gluetun-wiki/blob/main/setup/options/wireguard.md)
- [Brave Web Search API](https://api-dashboard.search.brave.com/documentation/services/web-search)

## Continuing a Chat message in Code

Choose **Continue in Code** on a message, edit the excerpt, and choose a ready project. In Code, choose **Create session with draft**. The browser stages only the selected text in memory for up to ten minutes, then saves it in the new session's regular Code composer after verifying the matching creation acknowledgment. A draft created from temporary Chat can persist in Code after this explicit transfer. The user controls when it is sent.

The handoff store is `src/lib/frontend/stores/chat-handoff.svelte.ts`. The desktop and mobile round-trip lives in `test/e2e/specs/conversation.spec.ts`.

## Chat turns and inbox

The browser starts a turn with `POST /api/chat/:id/turns` and a UUID. The relay saves the accepted prompt and receipt before generation. The browser reads the conversation while the turn is active and reconciles it when returning to the foreground. Retrying the same accepted request ID does not call the provider again. Regular chats recover after browser reconnect or reload. A relay restart marks an unfinished reply as interrupted and offers an explicit retry. Temporary turns remain memory-only.

**Stop** cancels the active request. Regenerate and edit target the latest prompt and preserve the previous completed turn until its replacement succeeds. Editing reuses previous attachments and sources unless the submitted edit supplies replacements. A reply can be branched into a separate saved conversation. Rename, pin, archive, restore, and JSON export are available under **Manage chat**. Inbox search matches saved conversation titles and message text on the relay.

The turn logic is in `src/lib/chat/service.ts`, the fixed provider stream in `src/lib/chat/nodecode-stream.ts`, and the browser recovery test in `test/e2e/specs/conversation.spec.ts`. Temporary Chat and Code continue to use their existing separate state and routes.

## Voice in Chat

**Dictate** records after a user gesture and stops on a second tap, after one minute, or when the app leaves the foreground. Chat sends the audio to the authenticated `/api/stt` route and displays an editable transcript in the current draft. The route requires the configured Whisper endpoint to be loopback for Chat requests and rejects upstream redirects. A failed upload can be retried while the conversation is open. Temporary chats keep their drafts in memory, and saved chats persist completed transcripts like typed drafts.

The default server endpoint is `http://127.0.0.1:8178/inference`. Run an existing whisper.cpp server bound to loopback with `--convert` for browser audio and a private runtime directory for `--tmp-dir`. Use `--no-gpu` if no GPU memory is available. The Whisper provider receives the recording. NodeCode receives the text only when the user sends the draft.

**Read aloud** uses a voice reported as local by the browser. It has pause, resume, and stop controls and releases playback when leaving the chat. Devices without an available on-device voice show a message when the user tries to play a reply.

The browser controls live in `ChatDictation.svelte` and `chat-speech.svelte.ts`. The replay tests cover microphone release on visibility change, retry without sending, draft reload, and speech controls. To test on an actual iPhone, accept microphone permission, record a phrase, switch apps while recording, then reopen Chat and check the editable transcript and the iOS microphone indicator.

## PDF files in Chat

**+ PDF** opens the file picker and current chat's files. Uploading stores the original on the relay. Attachments recover in the same browser after reload. **Review PDF excerpts** shows the actual page text before sending. Remove pages, trim excerpts, or replace selected text with `[redacted]`. The relay validates the edit against a short-lived review bound to the conversation and draft message. Leave the page field blank to choose up to four relevant pages, or select up to eight pages per PDF using numbers or ranges. The model receives the approved excerpts with neutral document labels and page numbers. Conduit keeps filenames and original file bytes local. Browser reloads retain the attachment selection and require a new review. **Files** searches PDFs by name and extracted text, opens page previews, and provides rename, download, library removal and original deletion. **Show all uploads** exposes regular chat uploads for file management. **Save to library** lets another saved chat reuse the same original.

The Linux relay uses Bubblewrap, prlimit and system Poppler tools (`pdfinfo`, `pdftotext`, `pdftoppm`). PDF parsing and page rendering run with no network, bounded memory, time and output, and a limited read-only filesystem. The initial limits are 10 MiB and 200 pages per file, four PDFs per turn, and 256 MiB of saved originals. A scanned PDF can be viewed, downloaded and managed. Choose **Read text from this page** in the viewer to run English OCR locally for an image-only page. The preview renders the cited page as a PNG inside the app.

Regular PDF files live in the relay's `chat/files/` state directory. Temporary PDF bytes, OCR output and excerpt reviews stay in relay memory. A temporary file cannot enter the library or be attached to a different chat. Deleting a file removes the original and searchable library text. By default the dialog also removes its excerpts and citations from saved turns and affected branches. Earlier messages remain visible and are excluded from future provider context in those conversations. They may still contain quotes, which can be removed by deleting the conversation. Clear the checkbox to retain earlier excerpts. A citation to a deleted original reports that the PDF is unavailable. New prompts only include excerpts from the approved review.

Before release, verify on a real iPhone that a PDF can be picked from Files, recovered after reopening the PWA, reviewed and sent, opened at a cited page, and selected from the library in a second chat. The parser, store, HTTP endpoints and UI live in `src/lib/chat/{pdf,files,file-http}.ts` and `ChatFilesPanel.svelte`.

The PDF privacy regression test captures the provider payload to verify that redacted text, filenames and file IDs stay out. It also checks that approval cannot be used for a different draft or chat, and that quotes in earlier replies are left out of future provider requests after scrubbing. Retries and regenerations reuse the approved excerpt snapshot. Older PDF turns require a fresh review before their excerpts can be sent again.

### Local scanned-page OCR

The viewer reads one page on demand. Selectable text is reused when available. Otherwise Bubblewrap renders the page and runs Tesseract with English trained data. Both processes have no network access, bounded execution and a private in-memory working directory. OCR runs with a single CPU thread. The existing PDF preview and upload stay available when OCR is unavailable.

The browser displays extracted text beside the original and offers **Use this page in draft**. The user still reviews and approves the exact excerpts before sending. OCR adds searchable text to the PDF record for saved chats. Temporary text expires with its original. An OCR failure leaves the original untouched. There is no remote OCR fallback.

To test the complete flow, upload a synthetic scanned receipt in Temporary Chat, extract the total locally, redact the receipt reference, send and open the citation, then delete the conversation. Check that the temporary file and OCR results are gone.
