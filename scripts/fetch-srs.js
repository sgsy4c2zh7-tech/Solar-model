// scripts/fetch-srs.js
// NOAA SWPC latest SRSを取得して data/srs/YYYYMMDD.txt に保存。
// 同時に data/srs/index.json を作る。
// Node 18+ / 22推奨。外部npm不要。

const fs = require("fs/promises");
const path = require("path");

const SRS_URL = "https://services.swpc.noaa.gov/text/srs.txt";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "data", "srs");
const INDEX_PATH = path.join(OUT_DIR, "index.json");

// 残す日数。1年残したいなら370。
const RETENTION_DAYS = Number(process.env.SRS_RETENTION_DAYS || 370);

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log("[SRS] Fetching latest SRS...");
  const text = await fetchTextWithRetry(SRS_URL, 3);

  if (!text || text.length < 100) {
    throw new Error("SRS text is empty or too short.");
  }

  const meta = parseSrsMeta(text);

  const fileName = `${yyyymmdd(meta.validDate)}.txt`;
  const filePath = path.join(OUT_DIR, fileName);

  await writeFileIfChanged(filePath, text);

  console.log(`[SRS] Saved: ${fileName}`);
  console.log(`[SRS] Issued: ${meta.issuedRaw || "unknown"}`);
  console.log(`[SRS] Valid : ${meta.validRaw || "unknown"}`);
  console.log(`[SRS] Valid ISO: ${meta.validDate.toISOString()}`);
  console.log(`[SRS] Regions: ${meta.regionCount}`);

  await pruneOldFiles();
  await buildIndex();

  console.log("[SRS] Done.");
}

async function fetchTextWithRetry(url, tries = 3) {
  let lastErr = null;

  for (let i = 1; i <= tries; i++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);

      const res = await fetch(url + "?t=" + Date.now(), {
        cache: "no-store",
        signal: controller.signal,
        headers: {
          "User-Agent": "srs-archive-github-actions/1.0"
        }
      });

      clearTimeout(timer);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      return await res.text();

    } catch (e) {
      lastErr = e;
      console.warn(`[SRS] Fetch failed ${i}/${tries}: ${e.message}`);
      await sleep(2500 * i);
    }
  }

  throw lastErr;
}

function parseSrsMeta(text) {
  const issuedRaw =
    (text.match(/:Issued:\s*(.+)/i) || [])[1]?.trim() ||
    (text.match(/Issued at\s+(.+)/i) || [])[1]?.trim() ||
    "";

  const validRaw =
    (text.match(/Locations Valid at\s*(.+)/i) || [])[1]?.trim() ||
    "";

  const issuedDate =
    parseIssuedDate(issuedRaw) ||
    parseIssuedDateFromBody(text) ||
    new Date();

  const validDate =
    parseValidDate(validRaw, issuedDate) ||
    issuedDate;

  const regionCount = countRegions(text);

  return {
    issuedRaw,
    validRaw,
    issuedDate,
    validDate,
    regionCount
  };
}

function parseIssuedDate(s) {
  if (!s) return null;

  // 例: 2026 May 25 0030 UTC
  let cleaned = s
    .replace(/UTC/i, "")
    .replace(/Z$/i, "")
    .trim();

  let d = new Date(cleaned + " UTC");
  if (!isNaN(d)) return d;

  // 例: 0030Z on 25 May 2026
  const m = s.match(/(\d{4})Z\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (m) {
    const hhmm = m[1];
    const day = Number(m[2]);
    const month = monthIndex(m[3]);
    const year = Number(m[4]);

    if (month !== null) {
      return new Date(Date.UTC(
        year,
        month,
        day,
        Number(hhmm.slice(0, 2)),
        Number(hhmm.slice(2, 4)),
        0
      ));
    }
  }

  return null;
}

function parseIssuedDateFromBody(text) {
  const m = text.match(/Issued at\s+(\d{4})Z\s+on\s+(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})/i);
  if (!m) return null;

  const hhmm = m[1];
  const day = Number(m[2]);
  const month = monthIndex(m[3]);
  const year = Number(m[4]);

  if (month === null) return null;

  return new Date(Date.UTC(
    year,
    month,
    day,
    Number(hhmm.slice(0, 2)),
    Number(hhmm.slice(2, 4)),
    0
  ));
}

function parseValidDate(validRaw, issuedDate) {
  if (!validRaw) return null;

  // 例: 2026 May 25 0030 UTC
  let cleaned = validRaw
    .replace(/UTC/i, "")
    .replace(/Z$/i, "")
    .trim();

  let full = new Date(cleaned + " UTC");
  if (!isNaN(full)) return full;

  // よくある形式: 25/2400Z, 25/0000Z, 25/0030Z
  const m = validRaw.match(/(\d{1,2})\/(\d{4})Z/i);
  if (m && issuedDate) {
    const day = Number(m[1]);
    const hhmm = m[2];

    let hour = Number(hhmm.slice(0, 2));
    let minute = Number(hhmm.slice(2, 4));

    let year = issuedDate.getUTCFullYear();
    let month = issuedDate.getUTCMonth();

    // 月またぎ対策
    const issuedDay = issuedDate.getUTCDate();

    if (day > issuedDay + 15) {
      month -= 1;
    } else if (day < issuedDay - 15) {
      month += 1;
    }

    // 2400Z は翌日0000Zとして扱う
    if (hour === 24) {
      hour = 0;
      minute = 0;
      return new Date(Date.UTC(year, month, day + 1, hour, minute, 0));
    }

    return new Date(Date.UTC(year, month, day, hour, minute, 0));
  }

  return null;
}

function countRegions(text) {
  const lines = text.split(/\r?\n/);
  let inSection = false;
  let count = 0;

  for (const line of lines) {
    if (line.startsWith("I.  Regions with Sunspots")) {
      inSection = true;
      continue;
    }

    if (inSection && line.startsWith("IA.")) break;
    if (!inSection) continue;

    const m = line.trim().match(
      /^(\d{4})\s+([NS]\d{2}[EW]\d{2})\s+(\d+)\s+(\d+)\s+([A-Za-z]+)\s+(\d+)\s+(\d+)\s+(.+)$/
    );

    if (m) count++;
  }

  return count;
}

async function buildIndex() {
  const files = await fs.readdir(OUT_DIR);

  const entries = [];

  for (const file of files) {
    if (!/^(\d{8})\.txt$/.test(file)) continue;

    const fullPath = path.join(OUT_DIR, file);
    const text = await fs.readFile(fullPath, "utf8");
    const meta = parseSrsMeta(text);

    entries.push({
      file,
      date: file.slice(0, 8),
      valid_iso: meta.validDate.toISOString(),
      issued_raw: meta.issuedRaw,
      valid_raw: meta.validRaw,
      regions: meta.regionCount
    });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));

  const latest = entries.at(-1) || null;

  const index = {
    latest: latest ? latest.file : null,
    latest_valid_iso: latest ? latest.valid_iso : null,
    count: entries.length,
    entries
  };

  await writeFileIfChanged(
    INDEX_PATH,
    JSON.stringify(index, null, 2) + "\n"
  );

  console.log(`[SRS] index.json updated. count=${entries.length}`);
}

async function pruneOldFiles() {
  const files = await fs.readdir(OUT_DIR).catch(() => []);
  const now = Date.now();
  const keepMs = RETENTION_DAYS * 86400000;

  for (const file of files) {
    if (!/^(\d{8})\.txt$/.test(file)) continue;

    const y = Number(file.slice(0, 4));
    const m = Number(file.slice(4, 6)) - 1;
    const d = Number(file.slice(6, 8));

    const fileDate = Date.UTC(y, m, d, 0, 0, 0);
    const age = now - fileDate;

    if (age > keepMs) {
      await fs.unlink(path.join(OUT_DIR, file));
      console.log(`[SRS] Deleted old file: ${file}`);
    }
  }
}

async function writeFileIfChanged(filePath, content) {
  let old = null;

  try {
    old = await fs.readFile(filePath, "utf8");
  } catch {}

  if (old === content) {
    console.log(`[SRS] No change: ${path.basename(filePath)}`);
    return;
  }

  await fs.writeFile(filePath, content, "utf8");
}

function monthIndex(s) {
  const key = s.slice(0, 3).toLowerCase();

  const map = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11
  };

  return key in map ? map[key] : null;
}

function yyyymmdd(d) {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate())
  );
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error("[SRS] Failed:", err);
  process.exit(1);
});
