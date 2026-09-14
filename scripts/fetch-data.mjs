// Fetches historical hourly wind speed for the site and writes it alongside
// a synthetic Swedish-style demand profile for the same timeline.
// Run with: node scripts/fetch-data.mjs
import { writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");

// Stockholm area
const LATITUDE = 59.33;
const LONGITUDE = 18.06;
const START_DATE = "2024-01-01";
const END_DATE = "2024-12-31";

async function fetchWind() {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&hourly=wind_speed_10m,wind_speed_100m` +
    `&wind_speed_unit=ms&timezone=UTC`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return {
    site: "Stockholm, Sweden",
    latitude: LATITUDE,
    longitude: LONGITUDE,
    source: "Open-Meteo historical archive (ERA5)",
    unit: "m/s",
    time: json.hourly.time,
    windSpeed10m: json.hourly.wind_speed_10m,
    windSpeed100m: json.hourly.wind_speed_100m,
  };
}

// Deterministic pseudo-random noise so regenerating the file is reproducible.
function seededNoise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

function seasonFactor(month) {
  // Dec/Jan/Feb winter peak, Jun/Jul/Aug summer low, shoulder otherwise.
  if ([12, 1, 2].includes(month)) return 1.3;
  if ([6, 7, 8].includes(month)) return 0.8;
  return 1.05;
}

function dailyFactor(hour) {
  if (hour < 6) return 0.75;
  if (hour < 9) return 1.05;
  if (hour < 16) return 0.95;
  if (hour < 20) return 1.15;
  return 0.85;
}

function generateDemand(timestamps) {
  const BASE_LOAD_MW = 12000;
  const demandMW = timestamps.map((iso, i) => {
    const d = new Date(iso + "Z");
    const month = d.getUTCMonth() + 1;
    const hour = d.getUTCHours();
    const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
    const weekendFactor = day === 0 || day === 6 ? 0.9 : 1.0;
    const noise = 0.97 + seededNoise(i) * 0.06;
    const mw =
      BASE_LOAD_MW *
      seasonFactor(month) *
      dailyFactor(hour) *
      weekendFactor *
      noise;
    return Math.round(mw);
  });

  return {
    description:
      "Synthetic illustrative Swedish demand profile (not real metered data)",
    unit: "MW",
    time: timestamps,
    demandMW,
  };
}

async function main() {
  await mkdir(dataDir, { recursive: true });

  const wind = await fetchWind();
  await writeFile(
    path.join(dataDir, "wind.json"),
    JSON.stringify(wind),
    "utf-8"
  );
  console.log(`Wrote data/wind.json (${wind.time.length} hourly points)`);

  const demand = generateDemand(wind.time);
  await writeFile(
    path.join(dataDir, "demand.json"),
    JSON.stringify(demand),
    "utf-8"
  );
  console.log(`Wrote data/demand.json (${demand.time.length} hourly points)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
