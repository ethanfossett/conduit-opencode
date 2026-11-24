# Conduit for OpenCode

A browser client and installable PWA for OpenCode. Use it to work with sessions and terminals from a desktop or phone.

This is an independently maintained edition of [dibstern/conduit](https://github.com/dibstern/conduit), based on upstream v0.1.3. The upstream copyright and MIT terms are preserved in [LICENSE](LICENSE).

- Connect to OpenCode V2 and resume conversations across devices.
- Keep unsent text and attachments locally across a reload.
- Work with persistent OpenCode terminals and paste from the terminal toolbar on mobile.
- Browse files, attach project references, and manage session models and settings.
- See connection and display recovery controls if the app loses its connection or cannot render a conversation.

## Run from source

Use Node.js 24, the pnpm version pinned in `package.json`, and a running OpenCode V2 server. The default upstream port is 4096.

```sh
pnpm install --frozen-lockfile
pnpm build
node dist/src/bin/cli.js --foreground --host 127.0.0.1 --port 2633 --oc-port 4096 --no-update
```

Run the last command from the project you want to open, using the absolute path to the built CLI if necessary. Open `http://127.0.0.1:2633/` on the machine running Conduit. To install the PWA on another device, use HTTPS through a private network such as Tailscale.

```sh
pnpm check
pnpm lint
pnpm test:unit
```

## Connect NodeCode

In Conduit, go to **Settings → Integrations → NodeCode · Cyber v1**. If your OpenCode server needs the provider preset, copy it from the card and merge it into the OpenCode configuration on the server. Reload OpenCode’s config, then refresh the card. The native connection flow has been verified with OpenCode V2.3.2.

Connect a regular [NodeCode API key](https://nodecode.ai/account/keys). Use **Test connection** to send a short request using your NodeCode balance, or **New chat with Cyber v1** to select it for a single session.

## Development roadmap

See the [Chat, Code, and private search roadmap](docs/agent-guide/chat-and-code.md) for implementation order, code entry points, and acceptance checks.
