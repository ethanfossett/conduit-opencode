# Chat and Code roadmap

Conduit will have a conversation inbox for general chat and a separate workspace for coding. Both surfaces can use OpenCode's session and streaming APIs. The current milestone lands NodeCode onboarding and verifies the existing session flow before building the new UI.

## Current milestone

- **Settings → Integrations → NodeCode** connects a regular key through OpenCode, reports the connected server version, and distinguishes a saved credential from an available model and a successful response.
- The NodeCode card uses the project-scoped integration catalog. A live server can list a custom integration while the single-integration endpoint returns 404, so the card uses the catalog for discovery.
- **Test connection** sends a single short generation request that can use account credit. **New chat with Cyber v1** uses OpenCode's session creation model field. The model belongs to the new session.
- Read [architecture](architecture.md) and [testing](testing.md) before changing the relay. Start with `src/lib/handlers/nodecode.ts`, `src/lib/nodecode.ts`, and `src/lib/frontend/components/overlays/NodecodeCard.svelte`. The other provider and session controls continue to use the shared client in `src/lib/instance/opencode-client.ts`.

## Next work, in order

| Work item | Scope | Acceptance |
| --- | --- | --- |
| Close the preview milestone | Run the branch on an authenticated private preview with a compatible OpenCode V2 server and an existing NodeCode credential. | From a physical iPhone, run the connection test, open a Cyber v1 chat, send a short message, reopen the PWA, and verify the model and reply persisted. Record the server version and outcome. |
| Prove the Chat boundary | Start a separate OpenCode instance for Chat with a dedicated state directory and an empty workspace. Restrict its filesystem and network access at the process boundary. Explicitly disable shell, file, plugin, and delegated tools. Give the browser a Chat-specific relay surface that accepts only chat lifecycle, model selection, and prompt operations. | A direct API or WebSocket call cannot use Chat to invoke a terminal, list project files, change tool policy, or access a Code session by ID. The runtime cannot read the Code workspace or credentials. Test reconnects and make sure Code remains usable. |
| Ship the conversation interface | Add a projectless Chat route and a Chat/Code switch. Reuse composer, streaming, and drafts. Scope draft and session caches by mode. Keep explicit attachments on the Chat input path. | Creating a chat requires neither a project nor new setup. Chat history and drafts stay distinct after a reload, and the Code flow still passes its regression tests. |
| Add private web search | Add a deliberate composer action that sends a reviewed query to a dedicated search worker. The worker owns search and page fetches. It uses a dedicated Mullvad WireGuard connection for IPv4, IPv6 if enabled, and DNS. Block all alternate egress. Return source URLs and bounded plain-text excerpts, with no project credentials or ambient cookies. | Verify exit IP and DNS from inside the worker. Bring the tunnel down and verify search and page reads stop while normal chat and Tailscale stay reachable. Reject private-address fetches, unsafe redirects, and oversized responses. Display citations and label externally sourced text as data. |
| Add temporary chat and a Code handoff | Define retention and deletion across the relay and OpenCode. Add an explicit preview for copying selected conversation content into a Code session. | Temporary sessions obey the stated retention after refresh and server restart. Code receives only approved content. |

## Privacy and release boundaries

- Tailscale is the route from the phone to Conduit. Mullvad is the proposed route from the search worker to the web.
- A hosted model receives the prompt and any excerpts supplied for the answer. A search provider can see the query and any search account identifier. Keep those distinctions visible in the product.
- Keep search disabled until the worker can prove its restricted egress. Pick the search backend during the search milestone. Use an existing account or an approved provider before introducing per-query costs.
- Keep machine-specific configs, account keys, saved conversations, and private preview addresses outside this public repository. Keep each milestone independently reviewable.

## Verification

Run `pnpm check`, `pnpm lint`, `pnpm test:unit`, and `pnpm build` from this checkout. The NodeCode card has desktop and mobile browser coverage in `test/e2e/specs/client-recovery.spec.ts`. That test simulates provider responses. A physical device and actual inference need separate checks.

### Preview results

- Live loopback preview against OpenCode 2.3.2. The NodeCode card found an existing connection and the short inference test succeeded.
- A mobile-sized Chromium session created a new Cyber v1 chat, received a real streamed response, and restored the conversation after reload. Physical iPhone acceptance is still outstanding.
- The current branch passed 4,247 unit tests and both targeted desktop and mobile browser tests, plus type checking, lint and a production build.
