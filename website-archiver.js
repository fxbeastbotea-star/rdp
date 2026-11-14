const axios = require("axios");
const cheerio = require("cheerio");
const archiver = require("archiver");
const robotsParser = require("robots-parser");
const pLimit = require("p-limit");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const ASSET_ATTRS = [
  ["img", "src"], ["script", "src"], ["link", "href"], ["source", "src"],
  ["video", "poster"], ["audio", "src"], ["iframe", "src"]
];

async function archiveWebsite(startUrl, config) {
  const start = new URL(startUrl);
  const host = start.hostname.toLowerCase();
  const workDir = fs.mkdtempSync(path.join(config.outputDir, "site-"));
  const siteDir = path.join(workDir, "website");
  fs.mkdirSync(siteDir, { recursive: true });
  const zipPath = path.join(config.outputDir, `website-archive-${Date.now()}.zip`);

  let bytes = 0, skipped = 0;
  const saved = new Set();
  const visited = new Set();
  const queue = [start.href];
  const discoveredAssets = new Set();
  const limit = pLimit(3);

  const client = axios.create({
    timeout: config.timeoutMs,
    maxRedirects: 4,
    maxContentLength: 8 * 1024 * 1024,
    maxBodyLength: 8 * 1024 * 1024,
    responseType: "arraybuffer",
    headers: { "User-Agent": config.userAgent, "Accept": "*/*" },
    validateStatus: (s) => s >= 200 && s < 400
  });

  const robotsUrl = new URL("/robots.txt", start.origin).href;
  let robots = null;
  try {
    const r = await client.get(robotsUrl);
    robots = robotsParser(robotsUrl, Buffer.from(r.data).toString("utf8"));
  } catch {
    // If robots.txt cannot be read, proceed conservatively with a low page limit.
  }

  const allowed = (url) => {
    try {
      const u = new URL(url);
      return u.hostname.toLowerCase() === host &&
        ["http:", "https:"].includes(u.protocol) &&
        (!robots || robots.isAllowed(u.href, config.userAgent) !== false);
    } catch { return false; }
  };

  const saveResponse = async (url, response, forcedName) => {
    const type = String(response.headers["content-type"] || "").toLowerCase();
    if (type.includes("text/html")) return null;
    if (bytes + response.data.length > config.maxTotalBytes || saved.size >= config.maxFiles) {
      skipped++; return null;
    }
    const target = safeTargetPath(url, siteDir, forcedName, type);
    if (saved.has(target)) return target;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(response.data));
    saved.add(target);
    bytes += response.data.length;
    return target;
  };

  try {
    while (queue.length && visited.size < config.maxPages && saved.size < config.maxFiles &&
           bytes < config.maxTotalBytes) {
      const batch = [];
      while (queue.length && batch.length < 3 && visited.size + batch.length < config.maxPages) {
        const u = normalizePageUrl(queue.shift());
        if (!u || visited.has(u) || !allowed(u)) { skipped++; continue; }
        visited.add(u);
        batch.push(u);
      }
      await Promise.all(batch.map(url => limit(async () => {
        try {
          const response = await client.get(url);
          const finalUrl = response.request?.res?.responseUrl || url;
          if (new URL(finalUrl).hostname.toLowerCase() !== host) { skipped++; return; }
          const contentType = String(response.headers["content-type"] || "").toLowerCase();
          if (!contentType.includes("text/html")) { await saveResponse(finalUrl, response); return; }

          const html = Buffer.from(response.data).toString("utf8");
          const $ = cheerio.load(html);
          const pagePath = safeTargetPath(finalUrl, siteDir, null, "text/html");
          fs.mkdirSync(path.dirname(pagePath), { recursive: true });
          if (!saved.has(pagePath) && bytes + Buffer.byteLength(html) <= config.maxTotalBytes) {
            fs.writeFileSync(pagePath, html);
            saved.add(pagePath); bytes += Buffer.byteLength(html);
          } else if (!saved.has(pagePath)) skipped++;

          // Collect same-host links and static resources; do not submit forms or execute scripts.
          $("a[href]").each((_, el) => {
            const next = resolveUrl($(el).attr("href"), finalUrl);
            if (next && isPageLike(next) && allowed(next) && !visited.has(normalizePageUrl(next))) queue.push(next);
          });

          for (const [tag, attr] of ASSET_ATTRS) {
            $(tag).each((_, el) => {
              const raw = $(el).attr(attr);
              const asset = resolveUrl(raw, finalUrl);
              if (asset && allowed(asset)) discoveredAssets.add(asset);
            });
          }
          $("[srcset]").each((_, el) => {
            const srcset = $(el).attr("srcset") || "";
            srcset.split(",").forEach(part => {
              const raw = part.trim().split(/\s+/)[0];
              const asset = resolveUrl(raw, finalUrl);
              if (asset && allowed(asset)) discoveredAssets.add(asset);
            });
          });
          const cssUrls = [...html.matchAll(/url\((?:['"]?)([^)'"]+)(?:['"]?)\)/gi)];
          for (const match of cssUrls) {
            const asset = resolveUrl(match[1], finalUrl);
            if (asset && allowed(asset)) discoveredAssets.add(asset);
          }
        } catch { skipped++; }
      })));
      if (config.delayMs) await new Promise(r => setTimeout(r, config.delayMs));
    }

    // Fetch discovered same-host assets in a small bounded pool.
    const assets = [...discoveredAssets].filter(allowed).slice(0, config.maxFiles - saved.size);
    await Promise.all(assets.map(url => limit(async () => {
      if (saved.size >= config.maxFiles || bytes >= config.maxTotalBytes) { skipped++; return; }
      try {
        const response = await client.get(url);
        const finalUrl = response.request?.res?.responseUrl || url;
        if (new URL(finalUrl).hostname.toLowerCase() !== host) { skipped++; return; }
        await saveResponse(finalUrl, response);
      } catch { skipped++; }
    })));

    const readme = [
      "PUBLIC WEBSITE ARCHIVE",
      "======================",
      `Starting URL: ${start.href}`,
      `Pages saved: ${[...saved].filter(p => p.endsWith(".html")).length}`,
      `Files saved: ${saved.size}`,
      `Bytes downloaded: ${bytes}`,
      "",
      "SCOPE AND LIMITATIONS",
      "- Contains only resources that were publicly accessible without signing in.",
      "- Only the starting hostname was crawled; external domains were not archived.",
      "- robots.txt was checked when available. The crawler uses conservative request limits.",
      "- JavaScript was not executed; dynamically loaded content may be missing.",
      "- Private backend code (such as server-side PHP), databases, credentials and protected files are not included.",
      "- Some relative asset links may need adjustment if the site uses complex routing or a CDN.",
      "- Respect the website owner's copyright, terms and applicable law. Use only with authorization."
    ].join("\n");
    fs.writeFileSync(path.join(siteDir, "README.txt"), readme, "utf8");

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver("zip", { zlib: { level: 6 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      archive.directory(siteDir, false);
      archive.finalize();
    });

    return {
      zipPath, workDir, pages: [...saved].filter(p => p.endsWith(".html")).length,
      files: saved.size, bytes, skipped
    };
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
    throw err;
  }
}

function resolveUrl(raw, base) {
  if (!raw || /^(data:|javascript:|mailto:|tel:|blob:|#)/i.test(raw.trim())) return null;
  try {
    const u = new URL(raw, base);
    u.hash = "";
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

function normalizePageUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = "";
    if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/$/, "");
    return u.href;
  } catch { return null; }
}

function isPageLike(url) {
  try {
    const u = new URL(url);
    if (u.search && u.search.length > 180) return false;
    return !/\.(?:zip|rar|7z|pdf|png|jpe?g|gif|webp|svg|ico|mp4|mp3|woff2?|ttf|eot|xml|json)(?:$|\?)/i.test(u.pathname);
  } catch { return false; }
}

function safeTargetPath(url, root, forcedName, contentType) {
  const u = new URL(url);
  let pathname = decodeURIComponent(u.pathname || "/");
  if (forcedName) pathname = forcedName;
  if (pathname.endsWith("/") || !path.posix.basename(pathname).includes(".")) pathname = path.posix.join(pathname, "index.html");
  pathname = pathname.replace(/[^a-zA-Z0-9._/-]/g, "_").replace(/\.\./g, "_");
  if (pathname.startsWith("/")) pathname = pathname.slice(1);
  if (!pathname) pathname = "index.html";
  if (contentType && contentType.includes("text/html") && !/\.html?$/i.test(pathname)) pathname += ".html";
  const queryHash = u.search ? "-" + crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 8) : "";
  const ext = path.posix.extname(pathname);
  if (queryHash) pathname = ext ? pathname.slice(0, -ext.length) + queryHash + ext : pathname + queryHash;
  const target = path.resolve(root, pathname);
  if (!target.startsWith(path.resolve(root) + path.sep)) throw new Error("Unsafe output path");
  return target;
}

module.exports = { archiveWebsite };
