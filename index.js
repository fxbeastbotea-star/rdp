require("dotenv").config();

const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const fs = require("fs");
const path = require("path");

const { archiveWebsite } = require("./website-archiver");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing BOT_TOKEN. Add it to your .env file or Render environment.");
  process.exit(1);
}

const bot = new Telegraf(TOKEN);
const app = express();
const PORT = Number(process.env.PORT || 10000);
const TMP_DIR = path.join(__dirname, "..", ".tmp");
fs.mkdirSync(TMP_DIR, { recursive: true });

const jobs = new Map();

app.get("/", (_req, res) => res.status(200).send("Website Code Extractor Telegram Bot is running."));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

bot.start(async (ctx) => {
  await ctx.reply(
    "👋 Welcome to Website Code Extractor.\n\n" +
    "Send the full URL of a website you own or have permission to archive. " +
    "I can collect publicly accessible HTML, CSS, JavaScript, images and other static assets.\n\n" +
    "I respect robots.txt, stay on the same hostname, and apply page/file/size limits. " +
    "I cannot retrieve private server code, databases, protected pages or credentials.\n\n" +
    "Use /help for details."
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    "How to use:\n" +
    "1. Send a full URL, for example https://example.com\n" +
    "2. Review the detected site and press Extract now.\n" +
    "3. Wait for the ZIP archive.\n\n" +
    "Only archive websites you own or are authorized to copy. " +
    "The bot does not bypass logins, paywalls, access controls or robots.txt. " +
    "It does not extract backend source code or secrets."
  );
});

bot.command("cancel", async (ctx) => {
  jobs.delete(ctx.from.id);
  await ctx.reply("Current extraction cancelled. Send another website URL when ready.");
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  if (text.startsWith("/")) return;

  let url;
  try {
    url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP/HTTPS URLs are supported.");
    if (url.username || url.password) throw new Error("URLs containing credentials are not accepted.");
    if (isPrivateHostname(url.hostname)) throw new Error("Private/local network addresses are not accepted.");
  } catch (err) {
    await ctx.reply("Please send a valid public website URL, including https://\n\n" + err.message);
    return;
  }

  jobs.set(ctx.from.id, { url: url.href, createdAt: Date.now() });
  await ctx.reply(
    `🔎 LINK RECEIVED\n${url.origin}\n\n` +
    "I will check the public homepage and estimate the accessible files. " +
    "Continue only if you own this website or have permission to archive it.",
    Markup.inlineKeyboard([
      [Markup.button.callback("🟢 EXTRACT NOW", "extract")],
      [Markup.button.callback("🔄 ANOTHER LINK", "another")]
    ])
  );
});

bot.action("another", async (ctx) => {
  jobs.delete(ctx.from.id);
  await ctx.answerCbQuery();
  await ctx.reply("Send the next full website URL.");
});

bot.action("extract", async (ctx) => {
  await ctx.answerCbQuery();
  const job = jobs.get(ctx.from.id);
  if (!job) {
    await ctx.reply("No pending URL. Send a website link first.");
    return;
  }
  jobs.delete(ctx.from.id);

  const status = await ctx.reply("⏳ Starting a careful public-site archive. This may take a few minutes...");
  let result;
  try {
    result = await archiveWebsite(job.url, {
      outputDir: TMP_DIR,
      maxPages: Number(process.env.MAX_PAGES || 40),
      maxFiles: Number(process.env.MAX_FILES || 250),
      maxTotalBytes: Number(process.env.MAX_TOTAL_MB || 35) * 1024 * 1024,
      timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 12000),
      delayMs: Number(process.env.CRAWL_DELAY_MS || 800),
      userAgent: process.env.USER_AGENT || "PublicSiteArchiveBot/1.0"
    });

    await ctx.telegram.editMessageText(
      ctx.chat.id, status.message_id, undefined,
      `✅ ARCHIVE READY\nPages saved: ${result.pages}\nFiles saved: ${result.files}\n` +
      `Downloaded: ${(result.bytes / 1024 / 1024).toFixed(2)} MB\n` +
      `Skipped: ${result.skipped}\n\nSending ZIP...`
    );

    await ctx.replyWithDocument(
      { source: result.zipPath, filename: path.basename(result.zipPath) },
      { caption: "Website public-resource archive. Review README.txt for scope and limitations." }
    );
  } catch (err) {
    console.error(err);
    await ctx.reply("❌ Extraction stopped: " + safeMessage(err.message));
  } finally {
    if (result?.workDir) fs.rmSync(result.workDir, { recursive: true, force: true });
    if (result?.zipPath) fs.rmSync(result.zipPath, { force: true });
  }
});

function isPrivateHostname(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  // Reject literal IPv4 private, loopback, link-local and reserved ranges.
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127);
}

function safeMessage(message) {
  return String(message || "Unknown error").slice(0, 350);
}

bot.catch((err) => console.error("Telegram bot error:", err));

(async () => {
  await bot.launch();
  app.listen(PORT, "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));
  console.log("Telegram bot started (long polling).");
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
