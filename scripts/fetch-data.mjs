// Fetches historical hourly wind speed for the site and writes it alongside
// a synthetic Swedish-style demand profile for the same timeline.
// Run with: node scripts/fetch-data.mjs
import { writeFile, mkdir, readFile } from "node:fs/promises";
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

async function fetchSolar() {
  const url =
    `https://archive-api.open-meteo.com/v1/archive` +
    `?latitude=${LATITUDE}&longitude=${LONGITUDE}` +
    `&start_date=${START_DATE}&end_date=${END_DATE}` +
    `&hourly=shortwave_radiation` +
    `&timezone=UTC`;

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
    unit: "W/m2",
    time: json.hourly.time,
    shortwaveRadiation: json.hourly.shortwave_radiation,
  };
}

// Real Swedish day-ahead spot prices (SE3 / Stockholm area) for every day of 2024, from the free
// elprisetjustnu.se API (sourced from ENTSO-E). One request per day since the API has no year/month
// endpoint. Timestamps come back in local CET/CEST; we convert to UTC to line up with the other data.
const PRICE_AREA = "SE3";
async function fetchElectricityPrices() {
  const days = [];
  const cursor = new Date(Date.UTC(2024, 0, 1));
  while (cursor.getUTCFullYear() === 2024) {
    days.push(
      `${cursor.getUTCFullYear()}/${String(cursor.getUTCMonth() + 1).padStart(2, "0")}-${String(cursor.getUTCDate()).padStart(2, "0")}`
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const time = [];
  const sekPerMWh = [];
  for (const day of days) {
    const url = `https://www.elprisetjustnu.se/api/v1/prices/${day}_${PRICE_AREA}.json`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`elprisetjustnu.se request failed for ${day}: ${res.status} ${res.statusText}`);
    }
    const hours = await res.json();
    for (const hour of hours) {
      const utcIso = new Date(hour.time_start).toISOString().slice(0, 16);
      time.push(utcIso);
      sekPerMWh.push(hour.SEK_per_kWh * 1000);
    }
  }

  return {
    site: "Stockholm / Södra Mellansverige (SE3), Sweden",
    source: "elprisetjustnu.se (day-ahead spot price, sourced from ENTSO-E), excl. VAT/fees/taxes",
    unit: "SEK/MWh",
    time,
    sekPerMWh,
  };
}


// Deterministic pseudo-random noise so regenerating the file is reproducible.
function seededNoise(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// Smooth annual cycle: winter peak (~Jan), summer trough (~Jul). No month-boundary jumps.
function seasonFactor(dayOfYear) {
  return 1 + 0.28 * Math.cos((2 * Math.PI * (dayOfYear - 15)) / 365);
}

// Smooth double-hump daily load shape (morning + evening peaks) using continuous hour-of-day.
function dailyFactor(hourFraction) {
  const morningPeak = Math.exp(-Math.pow((hourFraction - 8) / 2.5, 2));
  const eveningPeak = Math.exp(-Math.pow((hourFraction - 19) / 3, 2));
  return 0.82 + 0.28 * morningPeak + 0.32 * eveningPeak;
}

// Smooth weekly cycle (continuous, so weekday/weekend transition has no sharp corners).
function weeklyFactor(dayIndexContinuous) {
  return 1 - 0.07 * Math.cos((2 * Math.PI * (dayIndexContinuous - 5)) / 7);
}

function generateDemand(timestamps) {
  // Scaled to Sweden's nationwide electricity use (~140 TWh/year), not just one city/region.
  const BASE_LOAD_MW = 17000;
  const dayMs = 24 * 60 * 60 * 1000;
  const startMs = Date.parse(timestamps[0] + "Z");

  const demandMW = timestamps.map((iso, i) => {
    const ms = Date.parse(iso + "Z");
    const d = new Date(ms);
    const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
    const dayOfYear = (ms - startOfYear) / dayMs;
    const hourFraction = d.getUTCHours() + d.getUTCMinutes() / 60;
    const dayIndexContinuous = (ms - startMs) / dayMs;
    const noise = 0.98 + seededNoise(i) * 0.04;

    const mw =
      BASE_LOAD_MW *
      seasonFactor(dayOfYear) *
      dailyFactor(hourFraction) *
      weeklyFactor(dayIndexContinuous) *
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
  const demandOnly = process.argv.includes("--demand-only");
  const pricesOnly = process.argv.includes("--prices-only");

  if (pricesOnly) {
    const prices = await fetchElectricityPrices();
    await writeFile(path.join(dataDir, "price.json"), JSON.stringify(prices), "utf-8");
    console.log(`Wrote data/price.json (${prices.time.length} hourly points)`);
    return;
  }

  let wind;
  if (demandOnly) {
    wind = JSON.parse(await readFile(path.join(dataDir, "wind.json"), "utf-8"));
    console.log("Reusing existing data/wind.json (--demand-only)");
  } else {
    wind = await fetchWind();
    await writeFile(
      path.join(dataDir, "wind.json"),
      JSON.stringify(wind),
      "utf-8"
    );
    console.log(`Wrote data/wind.json (${wind.time.length} hourly points)`);
  }

  if (!demandOnly) {
    const solar = await fetchSolar();
    await writeFile(
      path.join(dataDir, "solar.json"),
      JSON.stringify(solar),
      "utf-8"
    );
    console.log(`Wrote data/solar.json (${solar.time.length} hourly points)`);

    const prices = await fetchElectricityPrices();
    await writeFile(path.join(dataDir, "price.json"), JSON.stringify(prices), "utf-8");
    console.log(`Wrote data/price.json (${prices.time.length} hourly points)`);
  }

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
