# Website Code Extractor Telegram Bot

A Node.js Telegram bot that creates a bounded archive of publicly accessible website pages and static assets.

## Features

- Accepts a full `http://` or `https://` URL.
- Shows an extraction confirmation button and an "Another link" button.
- Crawls links on the same hostname only.
- Collects public HTML, CSS, JavaScript, images, fonts and other linked static assets.
- Checks `robots.txt` when available, uses a conservative request delay, and applies configurable page/file/size limits.
- Sends a ZIP archive with a README describing scope and limitations.
- Includes `/help` and `/cancel`.

## Important limitations and responsible use

Use this bot only for websites you own or have explicit permission to archive. Public availability does not automatically grant permission to republish a site's code or media.

The bot does not log in, bypass access controls, defeat paywalls, submit forms, execute JavaScript, or retrieve server-side source code, databases, secrets, or private files. It stays on the starting hostname. Dynamic pages and assets hosted on other domains may be incomplete. It honors disallow rules in `robots.txt` when that file can be read.

The crawler has limits to reduce load. Configure them conservatively. Telegram also has document upload limits that may vary by Bot API deployment.

## 1. Create a Telegram bot

1. Open Telegram and chat with **@BotFather**.
2. Send `/newbot`.
3. Follow the prompts and copy the bot token.
4. Keep the token private. If it is exposed, revoke it through BotFather and create a new one.

## 2. Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
cp .env.example .env
```

Edit `.env` and set `BOT_TOKEN` to the token from BotFather.

```bash
npm start
```

Open your bot in Telegram and send `/start`.

## 3. Deploy on Render

1. Create a GitHub repository and upload this project.
2. In Render, choose **New + → Web Service** and connect the repository.
3. Use:
   - Runtime: Node
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variable `BOT_TOKEN` with your BotFather token.
5. Optionally set `MAX_PAGES`, `MAX_FILES`, `MAX_TOTAL_MB`, `REQUEST_TIMEOUT_MS`, and `CRAWL_DELAY_MS`.
6. Deploy. Render should report the service healthy at `/health`.

You can also use the included `render.yaml` as a Blueprint. Review the selected plan and its cost before creating the service. A persistent disk is not required for this design because ZIP files are temporary and sent directly to Telegram.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `BOT_TOKEN` | required | Telegram bot token |
| `PORT` | `10000` | Render web-service port |
| `MAX_PAGES` | `40` | Maximum HTML pages crawled |
| `MAX_FILES` | `250` | Maximum saved files |
| `MAX_TOTAL_MB` | `35` | Maximum total downloaded bytes |
| `REQUEST_TIMEOUT_MS` | `12000` | Request timeout |
| `CRAWL_DELAY_MS` | `800` | Delay between crawl batches |
| `USER_AGENT` | built-in | Crawler user-agent |

## Project structure

```text
website-code-extractor-bot/
├── src/
│   ├── index.js
│   └── website-archiver.js
├── .env.example
├── .gitignore
├── package.json
├── render.yaml
└── README.md
```

## Notes

- Render free instances may sleep or have usage limits depending on current plan availability. Check Render's current pricing and service behavior.
- Telegram bot long polling is used, so a webhook URL is not needed.
- Never commit `.env` or share your bot token in chat or screenshots.
