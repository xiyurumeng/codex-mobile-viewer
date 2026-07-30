# Codex Mobile Viewer

Convert local Codex conversations into read-only snapshots protected by a privacy allowlist and end-to-end encryption, then make them available on mobile devices through Cloudflare Pages. Cloudflare receives only static web assets, ciphertext, anonymized filenames, and a signed manifest.

## Requirements

- Windows 10 or Windows 11
- Node.js 22 or later
- The local Codex Desktop session directory: `%USERPROFILE%\.codex\sessions`
- A Cloudflare account, required only for viewing conversations online from a mobile device

The project does not require `npm install` and does not load CDNs, analytics scripts, external fonts, or third-party JavaScript.

## First-Time Setup

1. Double-click `Codex对话-管理菜单.cmd` and select `首次初始化` (Initial Setup).
2. The program displays a randomly generated unlock passphrase once. Save it in a password manager immediately. The program does not store the passphrase and cannot recover it.
3. In the management menu, select `只生成本地加密快照` (Build Local Encrypted Snapshot Only) to run the privacy scan first.
4. Select `执行安全检查` (Run Security Check) to verify the signature and every file hash.
5. Configure Cloudflare only after the local checks complete successfully.

During initial setup, the program creates DPAPI-protected ciphertext for the content master key and Ed25519 private key in `data`. Only the current Windows user can decrypt them. The unlock passphrase is used only by the mobile browser to unwrap the content master key, so automatic synchronization does not need to store the passphrase.

## Configure Cloudflare

Create a custom token from [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens):

- Entry point: open the link, click **Create Token** in the upper-right corner, then click **Create Custom Token**.
- Permission: `Account` → `Cloudflare Pages` → `Edit`
- Resources: select only the Cloudflare account that will host the Pages project
- Do not use the Global API Key
- You may set an expiration date and restrict the token to a fixed egress IP, but an IP restriction can break synchronization when your VPN exit address changes

Copy the 32-character `Account ID` from the Cloudflare Dashboard account home page. If you already know the account ID, you can open:

```text
https://dash.cloudflare.com/your-account-id/home
```

Replace `your-account-id` with the actual 32-character Account ID. Do not put the API Token in this URL. Then:

1. Open `Codex对话-管理菜单.cmd` and enter `Cloudflare 与网址设置` (Cloudflare and Site Settings).
2. Enter an unused Pages project name, such as `my-codex-mobile`.
3. Enter the Account ID.
4. Enter the Token. The input is hidden, and the Token is immediately encrypted with Windows DPAPI before it is stored.
5. Double-click `Codex对话-一键同步.cmd` to create and deploy the Direct Upload Pages project for the first time.

After a successful deployment, the terminal displays `https://project-name.pages.dev`. A Direct Upload project cannot later be switched directly to Git integration. This project does not require Git integration.

### Change the Site Name

Open `Codex对话-管理菜单.cmd` → `Cloudflare 与网址设置` (Cloudflare and Site Settings) → `更换 pages.dev 项目名` (Change pages.dev Project Name), then enter a name such as `my-codex-mobile`. Cloudflare Pages does not support renaming an existing Direct Upload project in place, so the program first creates and fully deploys a new project. It switches the local configuration to the new site only after deployment succeeds. The old project and URL are not deleted automatically. After confirming that the new site works, delete the old project manually from the Cloudflare Dashboard.

## Daily Entry Points

| File | Purpose |
| --- | --- |
| `Codex对话-一键同步.cmd` | Daily use: check for changes, synchronize updates immediately, and deploy them to the mobile site |
| `Codex对话-管理菜单.cmd` | Initial setup, status, security checks, site settings, automatic synchronization, passphrase management, and Token management |
| `sync-auto.cmd` | Internal entry point for Windows Task Scheduler; regular users do not need to run it manually |

Installing automatic synchronization modifies Windows Task Scheduler. By default, it checks for changes and deploys at `00:00` and `11:55` every day. If there is no network connection at a scheduled time, the Node.js program does not start. Windows runs one catch-up attempt when the network reconnects instead of using fixed-interval polling or a permanently running network monitor. Once a time slot succeeds or confirms that nothing changed, subsequent network-reconnect triggers only read the state and exit immediately without deploying again.

The task can run while the computer is awake but locked. It does not wake the computer from sleep. If a scheduled time is missed during sleep, the task catches up after you wake the computer manually and a network connection is available. No program runs while the computer is fully shut down. After you start Windows, sign in, and connect to the network, Windows handles any missed time slot. The task runs at low priority, and you can use `Codex对话-一键同步.cmd` for a manual update at any time.

Automatic synchronization limits are stored in `data\config.json`:

- Daily time slots: `00:00` and `11:55`
- Offline behavior: do not start the program; run one catch-up attempt after a network-reconnect event
- At most one successful automatic deployment per time slot
- At most two successful automatic deployments per day
- At most 62 successful automatic deployments per month

Manual one-click synchronization is not subject to these time limits, but it does not deploy again when there are no pending changes.

## Upload Allowlist

The snapshot keeps only:

- User-visible messages
- Assistant `commentary`
- Assistant `final_answer`
- Titles, timestamps, and message counts

The snapshot discards by default:

- System and developer prompts
- Reasoning traces
- Tool calls, terminal output, and patches
- Image and attachment contents
- Original Session IDs
- Unrecognized event types

If a visible message contains a suspected OpenAI, Cloudflare, GitHub, or AWS token, a JWT, a Bearer token, or a private key, the program omits the entire message, inserts a safe placeholder, and continues the build. It does not merely replace the key while preserving surrounding context that may still be sensitive. Logs record only the number and types of omitted credentials. They do not record message contents, matched values, or conversation titles. A structurally forbidden field that cannot be omitted safely still stops the entire build.

## Mobile Security

- PBKDF2-HMAC-SHA256 with 600,000 iterations
- Independent AES-256-GCM encryption with a random IV for every 40-message chunk
- HMAC-anonymized chunk filenames
- An Ed25519-signed manifest and SHA-256 file hashes
- Trust on first use for the public-key fingerprint and rollback detection for snapshot sequence numbers
- Passphrases, keys, and plaintext are never written to localStorage or IndexedDB
- The page locks immediately when it moves to the background and locks after five minutes of inactivity while in the foreground
- The Service Worker caches only the web shell and ciphertext
- Markdown is rendered with DOM `textContent`, so HTML from conversations is never executed
- A strict CSP blocks third-party connections, forms, iframes, camera access, microphone access, and geolocation

localStorage stores only the non-sensitive signing-key fingerprint, highest accepted snapshot sequence number, theme selection, reader font scale, and one-time UI hint state. It does not store the passphrase, content key, or conversation plaintext.

## Mobile Reading and Controls

- Opening a conversation downloads and decrypts only the latest 40 messages. Scroll upward or select `加载更早消息` (Load Earlier Messages) to fetch the preceding encrypted chunk.
- Concurrent downloads of the same path are deduplicated. Opening a conversation manually pauses other background prefetches.
- Prefetching is disabled by default on mobile devices, constrained connections, and connections measured as slow. A download that receives no data for 20 consecutive seconds stops and can be retried by reopening the conversation.
- During a download, the UI displays the number of bytes received. It also displays a percentage when the server provides a trustworthy content length.
- A conversation title is visible by default. Tap the conversation area below the title to hide or show it. Scrolling, selecting text, pressing controls, and multi-touch gestures do not toggle the title.
- The conversation body supports two-finger zoom from 85% to 130%. Zoom starts only after the distance between the two fingers changes by at least 12%, reflows the layout, and preserves the current reading position. The percentage button in the lower-left corner resets the scale to 100%.
- On refresh, the saved theme is restored before styles are painted, preventing a brief light-theme flash before dark mode appears.
- Subagent side tasks are grouped under their parent conversation through anonymous relationships. Only conversations with side tasks display an expand button. When a title is missing, the program restores it from a safely processed task path or nickname.
- Regular conversations are synchronized only when they remain in the current Codex Desktop sidebar index. Old sessions that are still stored on disk but no longer appear in the sidebar are excluded. Explicit side tasks are still retained; if their parent conversation is hidden, they appear as ungrouped side tasks.
- Moving the page to the background immediately clears plaintext and locks the viewer. Unlocking it again returns to the default `Select a conversation` screen.

## Risks That Cannot Be Eliminated

A static site cannot provide absolute protection if the Cloudflare account is fully compromised and the entire web application is replaced. Signatures prevent an attacker from modifying only the ciphertext or manifest, but a fully replaced fake site could still attempt to trick a user into entering the passphrase. Therefore:

- Run `安全检查` (Security Check) regularly from `Codex对话-管理菜单.cmd`
- If an unknown Cloudflare deployment appears, stop using the site immediately and revoke the Token from the Cloudflare Dashboard
- Do not unlock the viewer on a computer or phone infected with malware, using an untrusted input method, or controlled by another person
- A web page cannot reliably detect screenshots, photographs, or screen-reading software while it is unlocked
- Before opening the site on a mobile device for the first time, make sure neither the Cloudflare account nor the local computer shows signs of compromise

## Data and Recovery

- `data`: DPAPI-protected keys, configuration, and non-sensitive state; never uploaded
- `dist`: the currently deployable static site and ciphertext
- `dist.previous`: at least one local rollback snapshot
- `logs`: runtime logs that contain no Token, passphrase, or message contents

Do not delete `data`, or automatic synchronization will no longer be able to unwrap the content master key. Even if the Cloudflare Token is stolen, an attacker cannot directly decrypt existing conversations. However, the attacker may be able to replace the web application, so you should still revoke the Token immediately.

## Development Verification

```cmd
npm.cmd test
node --check src\cli.mjs
node --check web\app.js
```
