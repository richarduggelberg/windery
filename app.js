// Windery: wind + battery vs demand simulation, driven by static data files.

const CUT_IN_MS = 3;
const RATED_MS = 12;
const CUT_OUT_MS = 25;

// Sweden's approximate installed capacity as of 2025/2026, used as the 100% baseline for the wind slider
// and as the already-installed level (below which no build cost accrues) for the others.
const WIND_BASELINE_MW = 19000;
const SOLAR_BASELINE_MW = 4800; // Sweden's cumulative installed solar PV capacity reached 4.8 GW in 2024
const NUCLEAR_BASELINE_MW = 7000;
const COAL_BASELINE_MW = 0;
const HYDRO_BASELINE_MW = 16500;
const GAS_BASELINE_MW = 0;

// Battery slider moves through these discrete TWh notches (index-based) rather than a linear scale.
const BATTERY_CAPACITY_STEPS_TWH = [0, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 150];

function windCapacityFactor(speedMs) {
  if (speedMs < CUT_IN_MS || speedMs >= CUT_OUT_MS) return 0;
  if (speedMs >= RATED_MS) return 1;
  return Math.pow((speedMs - CUT_IN_MS) / (RATED_MS - CUT_IN_MS), 3);
}

// Simple flat-plate PV model: panels are rated at 1000 W/m2 (STC), so output scales linearly
// with irradiance up to that point (ignores temperature/tilt losses).
const SOLAR_RATED_WM2 = 1000;
function solarCapacityFactor(irradianceWm2) {
  return Math.min(1, Math.max(0, irradianceWm2) / SOLAR_RATED_WM2);
}

// Downsample a series to daily means for readable charts (data stays hourly for simulation).
function dailyAverage(time, values) {
  const buckets = new Map();
  time.forEach((iso, i) => {
    const day = iso.slice(0, 10);
    if (!buckets.has(day)) buckets.set(day, []);
    buckets.get(day).push(values[i]);
  });
  const labels = [...buckets.keys()];
  const means = labels.map((day) => {
    const vals = buckets.get(day);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  });
  return { labels, means };
}

// Downsample a series to half-week (3.5-day, i.e. two points per week) means, labeled by the bucket's first day.
function halfWeekAverage(time, values) {
  const buckets = new Map();
  time.forEach((iso, i) => {
    const hoursFromStart = Math.round((Date.parse(iso + "Z") - Date.parse(time[0] + "Z")) / (60 * 60 * 1000));
    const bucketStart = Math.floor(hoursFromStart / 84) * 84; // 84 hours = half a week
    if (!buckets.has(bucketStart)) buckets.set(bucketStart, { label: iso.slice(0, 10), values: [] });
    buckets.get(bucketStart).values.push(values[i]);
  });
  const entries = [...buckets.values()];
  return {
    labels: entries.map((e) => e.label),
    means: entries.map((e) => e.values.reduce((a, b) => a + b, 0) / e.values.length),
  };
}

const SIM_YEAR = 2024;
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dateUTC(month, day) {
  return new Date(Date.UTC(SIM_YEAR, month - 1, day));
}

function daysInMonth(month) {
  return new Date(Date.UTC(SIM_YEAR, month, 0)).getUTCDate();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

// Hours elapsed since Jan 1 00:00, i.e. the index into the hourly data arrays.
function hourIndexForDate(date) {
  return Math.round((date.getTime() - dateUTC(1, 1).getTime()) / 3600000);
}

function formatShortDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function formatWeekdayDate(date) {
  return date.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

// Weeks within a month start every 7 days from day 1; the last week's end date can spill into
// the next month (or, for December, the next year) since months aren't a multiple of 7 days.
function weeksInMonth(month) {
  const numDays = daysInMonth(month);
  const weeks = [];
  for (let startDay = 1, weekNum = 1; startDay <= numDays; startDay += 7, weekNum++) {
    const start = dateUTC(month, startDay);
    const end = addDays(start, 6);
    weeks.push({ weekNum, start, end });
  }
  return weeks;
}

function hourlyLabel(iso) {
  return iso.replace("T", " ");
}

// Picks the largest metric prefix (M, G, T, P) for which the value is still >= 1 of that unit.
const UNIT_PREFIXES = ["M", "G", "T", "P"];
function unitTier(maxAbsValue) {
  let idx = 0;
  let v = Math.abs(maxAbsValue);
  while (v >= 1000 && idx < UNIT_PREFIXES.length - 1) {
    v /= 1000;
    idx++;
  }
  return { idx, factor: Math.pow(1000, idx) };
}

function scaledUnit(baseUnit, idx) {
  return UNIT_PREFIXES[idx] + baseUnit.slice(1);
}

// Formats a raw SEK amount, scaling up through thousand/million/billion/trillion as needed.
const SEK_TIERS = ["SEK", "thousand SEK", "million SEK", "billion SEK", "trillion SEK"];
function formatSEK(value) {
  let idx = 0;
  let v = Math.abs(value);
  while (v >= 1000 && idx < SEK_TIERS.length - 1) {
    v /= 1000;
    idx++;
  }
  const decimals = v < 10 ? 2 : v < 100 ? 1 : 0;
  const sign = value < 0 ? "-" : "";
  return `${sign}${v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${SEK_TIERS[idx]}`;
}

// Formats a value (in baseUnit, e.g. "MW"/"MWh") scaling up to GW/TW/etc. once it exceeds 1000 of the current unit.
function formatQuantity(value, baseUnit) {
  const { idx, factor } = unitTier(value);
  const scaled = value / factor;
  const decimals = idx === 0 ? 0 : scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
  return `${scaled.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} ${scaledUnit(baseUnit, idx)}`;
}

function runSimulation(
  windSpeed,
  solarIrradiance,
  demandMW,
  windCapacityMW,
  solarCapacityMW,
  batteryCapacityMWh,
  baseloadMW,
  hydroCapacityMW,
  gasCapacityMW
) {
  const totalHours = windSpeed.length;
  const windGenMW = new Array(totalHours);
  const solarGenMW = new Array(totalHours);
  const batteryDischargeMW = new Array(totalHours);
  const hydroGenMW = new Array(totalHours);
  const gasGenMW = new Array(totalHours);
  const socMWh = new Array(totalHours);
  const unmet = new Uint8Array(totalHours);
  const exportMW = new Array(totalHours); // curtailed surplus beyond battery headroom
  const importMW = new Array(totalHours); // deficit left uncovered by base+wind+solar+battery+hydro+gas
  let soc = 0; // batteries start empty

  // Demand is met additively, in priority order: base, then wind+solar, then battery, then hydro,
  // then gas (both last-resort, freely dispatchable up to their own installed capacity).
  for (let i = 0; i < totalHours; i++) {
    const windGen = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const solarGen = solarCapacityMW * solarCapacityFactor(solarIrradiance[i]);
    const firmGen = windGen + solarGen + baseloadMW; // base + wind + solar, none of it is dispatchable
    const demand = demandMW[i];
    const net = firmGen - demand; // MW over a 1-hour step == MWh

    let discharge = 0;
    let hydroGen = 0;
    let gasGen = 0;
    let curtailed = 0;
    let unmetMW = 0;

    if (net >= 0) {
      // Surplus base + wind + solar generation charges the battery; hydro/gas never charge it.
      const surplus = net;
      const chargeFromSurplus = Math.min(surplus, batteryCapacityMWh - soc);
      soc += chargeFromSurplus;
      // Any surplus beyond battery headroom is curtailed/exported (not modeled further).
      curtailed = surplus - chargeFromSurplus;
    } else {
      let deficit = -net;
      discharge = Math.min(deficit, soc);
      soc -= discharge;
      deficit -= discharge;

      hydroGen = Math.min(deficit, hydroCapacityMW);
      deficit -= hydroGen;

      gasGen = Math.min(deficit, gasCapacityMW);
      deficit -= gasGen;
      if (deficit > 0) {
        unmet[i] = 1;
        unmetMW = deficit; // treated as imported from outside the modeled system
      }
    }
    windGenMW[i] = windGen;
    solarGenMW[i] = solarGen;
    batteryDischargeMW[i] = discharge;
    hydroGenMW[i] = hydroGen;
    gasGenMW[i] = gasGen;
    socMWh[i] = soc;
    exportMW[i] = curtailed;
    importMW[i] = unmetMW;
  }

  return {
    windGenMW,
    solarGenMW,
    batteryDischargeMW,
    hydroGenMW,
    gasGenMW,
    socMWh,
    unmet,
    exportMW,
    importMW,
  };
}

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

// Real price timestamps (local CET/CEST-derived) don't line up 1:1 with the UTC hourly grid used
// elsewhere, so look up by timestamp rather than assuming matching array indices; forward/back-fill
// the rare missing hour (e.g. right at the edges of the year) so the reference series has no gaps.
function alignHistoricalPrices(time, priceTime, priceSekMwh) {
  const byTime = new Map(priceTime.map((t, i) => [t, priceSekMwh[i]]));
  const aligned = time.map((t) => byTime.get(t) ?? null);
  let lastKnown = aligned.find((v) => v !== null) ?? 0;
  for (let i = 0; i < aligned.length; i++) {
    if (aligned[i] === null) aligned[i] = lastKnown;
    else lastKnown = aligned[i];
  }
  return aligned;
}

async function main() {
  const [wind, solar, demand, price] = await Promise.all([
    loadJSON("data/wind.json"),
    loadJSON("data/solar.json"),
    loadJSON("data/demand.json"),
    loadJSON("data/price.json"),
  ]);
  const historicalPriceSekMwh = alignHistoricalPrices(wind.time, price.time, price.sekPerMWh);

  const periodMonthInput = document.getElementById("periodMonth");
  const periodWeekInput = document.getElementById("periodWeek");
  const periodDayInput = document.getElementById("periodDay");
  const periodWeekControl = document.getElementById("periodWeekControl");
  const periodDayControl = document.getElementById("periodDayControl");
  const demandScaleInput = document.getElementById("demandScale");
  const windCapacityInput = document.getElementById("windCapacity");
  const solarCapacityInput = document.getElementById("solarCapacity");
  const batteryCapacityInput = document.getElementById("batteryCapacity");
  const nuclearCapacityInput = document.getElementById("nuclearCapacity");
  const coalCapacityInput = document.getElementById("coalCapacity");
  const hydroCapacityInput = document.getElementById("hydroCapacity");
  const gasCapacityInput = document.getElementById("gasCapacity");
  const windCapacityValue = document.getElementById("windCapacityValue");
  const solarCapacityValue = document.getElementById("solarCapacityValue");
  const batteryCapacityValue = document.getElementById("batteryCapacityValue");
  const nuclearCapacityValue = document.getElementById("nuclearCapacityValue");
  const coalCapacityValue = document.getElementById("coalCapacityValue");
  const hydroCapacityValue = document.getElementById("hydroCapacityValue");
  const gasCapacityValue = document.getElementById("gasCapacityValue");
  const demandScaleValue = document.getElementById("demandScaleValue");
  const probabilityEl = document.getElementById("probability");
  const probabilityNoteEl = document.getElementById("probabilityNote");
  const capNuclearInstalled = document.getElementById("capNuclearInstalled");
  const capNuclearShare = document.getElementById("capNuclearShare");
  const capNuclearUsed = document.getElementById("capNuclearUsed");
  const capNuclearGenShare = document.getElementById("capNuclearGenShare");
  const capNuclearUsageShare = document.getElementById("capNuclearUsageShare");
  const capCoalInstalled = document.getElementById("capCoalInstalled");
  const capCoalShare = document.getElementById("capCoalShare");
  const capCoalUsed = document.getElementById("capCoalUsed");
  const capCoalGenShare = document.getElementById("capCoalGenShare");
  const capCoalUsageShare = document.getElementById("capCoalUsageShare");
  const capWindInstalled = document.getElementById("capWindInstalled");
  const capWindShare = document.getElementById("capWindShare");
  const capWindUsed = document.getElementById("capWindUsed");
  const capWindGenShare = document.getElementById("capWindGenShare");
  const capWindUsageShare = document.getElementById("capWindUsageShare");
  const capSolarInstalled = document.getElementById("capSolarInstalled");
  const capSolarShare = document.getElementById("capSolarShare");
  const capSolarUsed = document.getElementById("capSolarUsed");
  const capSolarGenShare = document.getElementById("capSolarGenShare");
  const capSolarUsageShare = document.getElementById("capSolarUsageShare");
  const capHydroInstalled = document.getElementById("capHydroInstalled");
  const capHydroShare = document.getElementById("capHydroShare");
  const capHydroUsed = document.getElementById("capHydroUsed");
  const capHydroGenShare = document.getElementById("capHydroGenShare");
  const capHydroUsageShare = document.getElementById("capHydroUsageShare");
  const capGasInstalled = document.getElementById("capGasInstalled");
  const capGasShare = document.getElementById("capGasShare");
  const capGasUsed = document.getElementById("capGasUsed");
  const capGasGenShare = document.getElementById("capGasGenShare");
  const capGasUsageShare = document.getElementById("capGasUsageShare");
  const capBatteryInstalled = document.getElementById("capBatteryInstalled");
  const capBatteryUsed = document.getElementById("capBatteryUsed");
  const capBatteryGenShare = document.getElementById("capBatteryGenShare");
  const capBatteryUsageShare = document.getElementById("capBatteryUsageShare");
  const capImportsUsageShare = document.getElementById("capImportsUsageShare");
  const costNuclearInput = document.getElementById("costNuclear");
  const costCoalInput = document.getElementById("costCoal");
  const costWindInput = document.getElementById("costWind");
  const costSolarInput = document.getElementById("costSolar");
  const costHydroInput = document.getElementById("costHydro");
  const costGasInput = document.getElementById("costGas");
  const costBatteryInput = document.getElementById("costBattery");
  const costAddedNuclear = document.getElementById("costAddedNuclear");
  const costSekNuclear = document.getElementById("costSekNuclear");
  const costAddedCoal = document.getElementById("costAddedCoal");
  const costSekCoal = document.getElementById("costSekCoal");
  const costAddedWind = document.getElementById("costAddedWind");
  const costSekWind = document.getElementById("costSekWind");
  const costAddedSolar = document.getElementById("costAddedSolar");
  const costSekSolar = document.getElementById("costSekSolar");
  const costAddedHydro = document.getElementById("costAddedHydro");
  const costSekHydro = document.getElementById("costSekHydro");
  const costAddedGas = document.getElementById("costAddedGas");
  const costSekGas = document.getElementById("costSekGas");
  const costAddedBattery = document.getElementById("costAddedBattery");
  const costSekBattery = document.getElementById("costSekBattery");
  const costSekTotal = document.getElementById("costSekTotal");
  const costMarginalNuclearInput = document.getElementById("costMarginalNuclear");
  const costMarginalCoalInput = document.getElementById("costMarginalCoal");
  const costMarginalWindInput = document.getElementById("costMarginalWind");
  const costMarginalSolarInput = document.getElementById("costMarginalSolar");
  const costMarginalHydroInput = document.getElementById("costMarginalHydro");
  const costPriceDeepSurplusInput = document.getElementById("costPriceDeepSurplus");
  const costPriceBalancedInput = document.getElementById("costPriceBalanced");
  const costPriceHydroTopInput = document.getElementById("costPriceHydroTop");
  const costPriceGasTopInput = document.getElementById("costPriceGasTop");
  const costPriceScarcityInput = document.getElementById("costPriceScarcity");
  const avgSimPriceEl = document.getElementById("avgSimPrice");
  const avgHistPriceEl = document.getElementById("avgHistPrice");
  const opGenNuclear = document.getElementById("opGenNuclear");
  const opCostNuclear = document.getElementById("opCostNuclear");
  const opGenCoal = document.getElementById("opGenCoal");
  const opCostCoal = document.getElementById("opCostCoal");
  const opGenWind = document.getElementById("opGenWind");
  const opCostWind = document.getElementById("opCostWind");
  const opGenSolar = document.getElementById("opGenSolar");
  const opCostSolar = document.getElementById("opCostSolar");
  const opGenHydro = document.getElementById("opGenHydro");
  const opCostHydro = document.getElementById("opCostHydro");
  const opGenGas = document.getElementById("opGenGas");
  const opCostGas = document.getElementById("opCostGas");
  const opGenBattery = document.getElementById("opGenBattery");
  const opCostBattery = document.getElementById("opCostBattery");
  const opGenImport = document.getElementById("opGenImport");
  const opCostImport = document.getElementById("opCostImport");
  const opGenExport = document.getElementById("opGenExport");
  const opCostExport = document.getElementById("opCostExport");
  const opCostTotal = document.getElementById("opCostTotal");
  const householdApartmentAnnualKwhInput = document.getElementById("householdApartmentAnnualKwh");
  const householdHouseAnnualKwhInput = document.getElementById("householdHouseAnnualKwh");
  const householdApartmentDemandEl = document.getElementById("householdApartmentDemand");
  const householdApartmentCostEl = document.getElementById("householdApartmentCost");
  const householdHouseDemandEl = document.getElementById("householdHouseDemand");
  const householdHouseCostEl = document.getElementById("householdHouseCost");

  // The fetched profile already represents Sweden's current nationwide demand; the slider scales it up/down from there.
  const baseAnnualDemandMWh = demand.demandMW.reduce((a, b) => a + b, 0);

  // Populates the week dropdown for the currently selected month (or hides it for "Full year").
  function rebuildWeekOptions() {
    if (periodMonthInput.value === "year") {
      periodWeekControl.classList.add("hidden");
      periodWeekInput.innerHTML = '<option value="whole" selected>Whole month</option>';
      return;
    }
    periodWeekControl.classList.remove("hidden");
    const month = Number(periodMonthInput.value);
    const weekOptions = weeksInMonth(month)
      .map(
        (week) =>
          `<option value="${week.weekNum}">Week ${week.weekNum} (${formatShortDate(week.start)} \u2013 ${formatShortDate(week.end)})</option>`
      )
      .join("");
    periodWeekInput.innerHTML = `<option value="whole" selected>Whole month</option>${weekOptions}`;
  }

  // Populates the day dropdown for the currently selected week (or hides it for "Whole month"/"Whole year").
  function rebuildDayOptions() {
    if (periodMonthInput.value === "year" || periodWeekInput.value === "whole") {
      periodDayControl.classList.add("hidden");
      periodDayInput.innerHTML = '<option value="whole" selected>Whole week</option>';
      return;
    }
    periodDayControl.classList.remove("hidden");
    const month = Number(periodMonthInput.value);
    const week = weeksInMonth(month)[Number(periodWeekInput.value) - 1];
    const dayOptions = Array.from({ length: 7 }, (_, i) => addDays(week.start, i))
      .map((day, i) => `<option value="${i}">${formatWeekdayDate(day)}</option>`)
      .join("");
    periodDayInput.innerHTML = `<option value="whole" selected>Whole week</option>${dayOptions}`;
  }

  // Translates the month/week/day dropdowns into an hourly index range plus a display label,
  // choosing chart granularity (hourly/daily/half-weekly) based on the span selected.
  function getPeriodSelection() {
    const totalHours = wind.time.length;
    let rawStart;
    let rawEnd;
    let label;
    let preposition;
    let unit;
    if (periodMonthInput.value === "year") {
      rawStart = 0;
      rawEnd = totalHours;
      label = `${SIM_YEAR}`;
      preposition = "in";
      unit = "halfWeekly";
    } else {
      const month = Number(periodMonthInput.value);
      if (periodWeekInput.value === "whole") {
        rawStart = hourIndexForDate(dateUTC(month, 1));
        rawEnd = hourIndexForDate(dateUTC(month, daysInMonth(month))) + 24;
        label = `${MONTH_NAMES[month - 1]} ${SIM_YEAR}`;
        preposition = "in";
        unit = "daily";
      } else {
        const week = weeksInMonth(month)[Number(periodWeekInput.value) - 1];
        if (periodDayInput.value === "whole") {
          rawStart = hourIndexForDate(week.start);
          rawEnd = hourIndexForDate(week.end) + 24;
          label = `${formatShortDate(week.start)}\u2013${formatShortDate(week.end)}, ${SIM_YEAR}`;
          preposition = "in the week of";
          unit = "hourly";
        } else {
          const day = addDays(week.start, Number(periodDayInput.value));
          rawStart = hourIndexForDate(day);
          rawEnd = rawStart + 24;
          label = formatWeekdayDate(day);
          preposition = "on";
          unit = "hourly";
        }
      }
    }
    // Weeks/days near year-end can nominally spill past Dec 31 (into data the 2024 dataset doesn't have);
    // clamp to the available range so there's always at least one hour to show.
    const start = Math.min(Math.max(rawStart, 0), totalHours - 1);
    const end = Math.min(Math.max(rawEnd, start + 1), totalHours);
    return { start, end, label, preposition, unit };
  }

  // Resample a full-year series to the selected window, using hourly points for short windows,
  // daily means for medium windows, and half-week means for the full year so the chart stays readable.
  function resample(time, values, unit, start, end) {
    const timeSlice = time.slice(start, end);
    const valueSlice = values.slice(start, end);
    if (unit === "hourly") {
      return { labels: timeSlice.map(hourlyLabel), values: valueSlice };
    }
    if (unit === "halfWeekly") {
      const { labels, means } = halfWeekAverage(timeSlice, valueSlice);
      return { labels, values: means };
    }
    const { labels, means } = dailyAverage(timeSlice, valueSlice);
    return { labels, values: means };
  }

  const chart = new Chart(document.getElementById("combinedChart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Nuclear generation (MW)",
          data: [],
          borderColor: "#7a5c2b",
          backgroundColor: "rgba(122, 92, 43, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "origin",
          order: 1,
        },
        {
          label: "Coal generation (MW)",
          data: [],
          borderColor: "#4a4a4a",
          backgroundColor: "rgba(74, 74, 74, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 2,
        },
        {
          label: "Wind generation (MW)",
          data: [],
          borderColor: "#2b7a78",
          backgroundColor: "rgba(43, 122, 120, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 3,
        },
        {
          label: "Solar generation (MW)",
          data: [],
          borderColor: "#e8b93a",
          backgroundColor: "rgba(232, 185, 58, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 4,
        },
        {
          label: "Battery discharge used (MW)",
          data: [],
          borderColor: "#5b7fd6",
          backgroundColor: "rgba(91, 127, 214, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 5,
        },
        {
          label: "Hydro generation used (MW)",
          data: [],
          borderColor: "#3a6ea5",
          backgroundColor: "rgba(58, 110, 165, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 6,
        },
        {
          label: "Gas generation used (MW)",
          data: [],
          borderColor: "#e0a458",
          backgroundColor: "rgba(224, 164, 88, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 7,
        },
        {
          // Invisible; only exists as a fill target so the gap dataset can shade base+wind+solar vs demand.
          label: "Base + wind + solar (firm generation)",
          data: [],
          borderWidth: 0,
          pointRadius: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          yAxisID: "y",
          stack: "firmgen",
          fill: false,
          order: 8,
          hideInLegend: true,
        },
        {
          // Shades the gap between firm (base+wind+solar) generation and demand: red where demand isn't
          // met by base+wind+solar alone (battery/variable had to help), green where there's a surplus.
          label: "Surplus / shortfall vs. demand",
          data: [],
          borderWidth: 0,
          pointRadius: 0,
          borderColor: "transparent",
          yAxisID: "y",
          stack: "gap",
          fill: { target: 7 },
          order: 9,
          hideInLegend: true,
        },
        {
          label: "Demand (MW)",
          data: [],
          borderColor: "#c44536",
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: "y",
          stack: "demand",
          fill: false,
          order: 10,
        },
        {
          label: "Battery charge (MWh)",
          data: [],
          borderColor: "#5b7fd6",
          borderDash: [4, 3],
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y1",
          fill: false,
          order: 11,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          labels: {
            filter: (item, data) => !data.datasets[item.datasetIndex].hideInLegend,
          },
        },
        tooltip: {
          filter: (item) => Math.abs(item.parsed.y) > 0.1,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: { stacked: true, min: 0, title: { display: true, text: "MW" } },
        y1: {
          position: "right",
          title: { display: true, text: "MWh" },
          min: 0,
          grid: { drawOnChartArea: false },
        },
      },
    },
  });

  const priceChart = new Chart(document.getElementById("priceChart"), {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Simulated price (SEK/MWh)",
          data: [],
          borderColor: "#c44536",
          pointRadius: 0,
          borderWidth: 1.5,
          fill: false,
          order: 1,
        },
        {
          label: "Historical SE3 spot price, 2024 (SEK/MWh)",
          data: [],
          borderColor: "#8a8a8a",
          borderDash: [4, 3],
          pointRadius: 0,
          borderWidth: 1.5,
          fill: false,
          order: 2,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: {
        tooltip: {
          filter: (item) => Math.abs(item.parsed.y) > 0.1,
          itemSort: (a, b) => b.parsed.y - a.parsed.y,
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: { title: { display: true, text: "SEK/MWh" } },
      },
    },
  });

  function update() {
    const { start, end, label: periodLabel, preposition, unit } = getPeriodSelection();

    const demandScalePercent = Number(demandScaleInput.value);
    const demandFactor = demandScalePercent / 100;
    const scaledDemandMW = demand.demandMW.map((v) => v * demandFactor);
    demandScaleValue.textContent = `${demandScalePercent}% (${formatQuantity(baseAnnualDemandMWh * demandFactor, "MWh")}/yr)`;

    const windCapacityMW = WIND_BASELINE_MW * (Number(windCapacityInput.value) / 100);
    const solarCapacityMW = SOLAR_BASELINE_MW * (Number(solarCapacityInput.value) / 100);
    // Battery slider moves through fixed TWh notches (index into BATTERY_CAPACITY_STEPS_TWH).
    const batteryCapacityTWh = BATTERY_CAPACITY_STEPS_TWH[Number(batteryCapacityInput.value)];
    const batteryCapacityMWh = batteryCapacityTWh * 1e6;
    // Nuclear/hydro sliders are % of baseline (non-zero defaults); coal/gas are absolute GW (zero default).
    const nuclearMW = NUCLEAR_BASELINE_MW * (Number(nuclearCapacityInput.value) / 100);
    const coalMW = Number(coalCapacityInput.value) * 1000;
    const hydroMW = HYDRO_BASELINE_MW * (Number(hydroCapacityInput.value) / 100);
    const gasMW = Number(gasCapacityInput.value) * 1000;
    const baseloadMW = nuclearMW + coalMW;
    windCapacityValue.textContent = `${windCapacityInput.value}% (${formatQuantity(windCapacityMW, "MW")})`;
    solarCapacityValue.textContent = `${solarCapacityInput.value}% (${formatQuantity(solarCapacityMW, "MW")})`;
    batteryCapacityValue.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    nuclearCapacityValue.textContent = `${nuclearCapacityInput.value}% (${formatQuantity(nuclearMW, "MW")})`;
    coalCapacityValue.textContent = formatQuantity(coalMW, "MW");
    hydroCapacityValue.textContent = `${hydroCapacityInput.value}% (${formatQuantity(hydroMW, "MW")})`;
    gasCapacityValue.textContent = formatQuantity(gasMW, "MW");

    // Always simulate the full year so battery state of charge carries over correctly,
    // then slice down to the selected window for display and the probability figure.
    const {
      windGenMW,
      solarGenMW,
      batteryDischargeMW,
      hydroGenMW,
      gasGenMW,
      socMWh,
      unmet,
      exportMW,
      importMW,
    } = runSimulation(
      wind.windSpeed100m,
      solar.shortwaveRadiation,
      scaledDemandMW,
      windCapacityMW,
      solarCapacityMW,
      batteryCapacityMWh,
      baseloadMW,
      hydroMW,
      gasMW
    );

    const windResampled = resample(wind.time, windGenMW, unit, start, end);
    const solarResampled = resample(wind.time, solarGenMW, unit, start, end);
    const dischargeResampled = resample(wind.time, batteryDischargeMW, unit, start, end);
    const hydroResampled = resample(wind.time, hydroGenMW, unit, start, end);
    const gasResampled = resample(wind.time, gasGenMW, unit, start, end);
    const socResampled = resample(wind.time, socMWh, unit, start, end);
    const demandResampled = resample(demand.time, scaledDemandMW, unit, start, end);
    const nuclearSeries = new Array(windResampled.values.length).fill(nuclearMW);
    const coalSeries = new Array(windResampled.values.length).fill(coalMW);
    const firmGenSeries = windResampled.values.map((v, i) => v + solarResampled.values[i] + baseloadMW);

    // Each hour's price sits on a continuous curve running through five anchor points, positioned by
    // how deep the deficit (or surplus/curtailment) that hour is relative to installed hydro/gas capacity
    // — a simplified merit-order supply curve. This gives smooth, weather/demand-driven variability
    // instead of a few fixed numbers, and can dip below zero during extreme oversupply, like real prices.
    const deepSurplusPrice = Number(costPriceDeepSurplusInput.value);
    const balancedPrice = Number(costPriceBalancedInput.value);
    const hydroTopPrice = Number(costPriceHydroTopInput.value);
    const gasTopPrice = Number(costPriceGasTopInput.value);
    const scarcityPrice = Number(costPriceScarcityInput.value);
    const avgDemandMW = scaledDemandMW.reduce((a, b) => a + b, 0) / scaledDemandMW.length;
    // Tier widths are capped relative to average demand: real SE3 prices swing across their full range
    // over a deficit/surplus of a few GW, not over Sweden's full multi-GW nameplate capacity (regional
    // transmission bottlenecks mean only a fraction of that capacity is actually available to set the
    // local price) — so more installed hydro/gas narrows the tier (cheaper, as expected) up to this cap.
    const hydroTierWidthMW = Math.min(hydroMW, avgDemandMW * 0.6);
    const gasTierWidthMW = Math.min(gasMW, avgDemandMW * 0.6);
    const priceCurvePoints = [
      [-avgDemandMW * 0.2, deepSurplusPrice],
      [0, balancedPrice],
      [hydroTierWidthMW, hydroTopPrice],
      [hydroTierWidthMW + gasTierWidthMW, gasTopPrice],
      [hydroTierWidthMW + gasTierWidthMW + avgDemandMW * 0.9, scarcityPrice],
    ].reduce((points, point) => {
      // Collapse zero-width segments (e.g. gasMW = 0) so a zero-capacity tier is skipped, not priced.
      if (points.length && points[points.length - 1][0] === point[0]) return points;
      points.push(point);
      return points;
    }, []);
    // Curved (not linear) interpolation within each segment: price stays close to the "normal" end for
    // most of a tier's range and only swings toward the extreme near the top, like a real convex
    // merit-order supply curve — this is what produces realistic day-to-day price swings instead of a
    // flat, low-variance average.
    const CURVE_POWER = 1.8;
    function priceAt(residualLoadMW) {
      if (residualLoadMW <= priceCurvePoints[0][0]) return priceCurvePoints[0][1];
      for (let i = 1; i < priceCurvePoints.length; i++) {
        const [x0, y0] = priceCurvePoints[i - 1];
        const [x1, y1] = priceCurvePoints[i];
        if (residualLoadMW > x1) continue;
        if (i === 1) {
          // Surplus segment runs "backwards" (0 = normal/balanced, x0 = the extreme deep-surplus end).
          const s = (x1 - residualLoadMW) / (x1 - x0);
          return y1 + Math.pow(s, CURVE_POWER) * (y0 - y1);
        }
        const t = (residualLoadMW - x0) / (x1 - x0);
        return y0 + Math.pow(t, CURVE_POWER) * (y1 - y0);
      }
      const [xPrev, yPrev] = priceCurvePoints[priceCurvePoints.length - 2];
      const [xLast, yLast] = priceCurvePoints[priceCurvePoints.length - 1];
      const tangentSlope = (CURVE_POWER * (yLast - yPrev)) / (xLast - xPrev);
      return yLast + tangentSlope * (residualLoadMW - xLast);
    }
    // Deficit still uncovered by battery (hydro + gas + imports), net of any curtailed/exported surplus.
    const residualLoadMW = hydroGenMW.map((v, i) => v + gasGenMW[i] + importMW[i] - exportMW[i]);
    const priceSekMwh = residualLoadMW.map(priceAt);
    const priceResampled = resample(wind.time, priceSekMwh, unit, start, end);
    const histPriceResampled = resample(wind.time, historicalPriceSekMwh, unit, start, end);

    // Pick one unit per axis (MW/GW/TW...) based on the largest value currently shown on it.
    const yTier = unitTier(
      Math.max(
        0,
        ...windResampled.values,
        ...solarResampled.values,
        ...nuclearSeries,
        ...coalSeries,
        ...dischargeResampled.values,
        ...hydroResampled.values,
        ...gasResampled.values,
        ...demandResampled.values
      )
    );
    const yUnit = scaledUnit("MW", yTier.idx);
    const y1Tier = unitTier(Math.max(batteryCapacityMWh, 0, ...socResampled.values));
    const y1Unit = scaledUnit("MWh", y1Tier.idx);

    // Red where base + wind + solar alone fall short of demand (battery/hydro/gas had to cover the rest),
    // green where base + wind + solar exceed demand (surplus charges the battery or is exported).
    const gapColors = firmGenSeries.map((firmGen, i) =>
      firmGen < demandResampled.values[i] ? "rgba(196, 69, 54, 0.25)" : "rgba(76, 154, 90, 0.25)"
    );

    chart.data.labels = demandResampled.labels;
    chart.data.datasets[0].data = nuclearSeries.map((v) => v / yTier.factor);
    chart.data.datasets[0].label = `Nuclear generation (${yUnit})`;
    chart.data.datasets[1].data = coalSeries.map((v) => v / yTier.factor);
    chart.data.datasets[1].label = `Coal generation (${yUnit})`;
    chart.data.datasets[2].data = windResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[2].label = `Wind generation (${yUnit})`;
    chart.data.datasets[3].data = solarResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[3].label = `Solar generation (${yUnit})`;
    chart.data.datasets[4].data = dischargeResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[4].label = `Battery discharge used (${yUnit})`;
    chart.data.datasets[5].data = hydroResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[5].label = `Hydro generation used (${yUnit})`;
    chart.data.datasets[6].data = gasResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[6].label = `Gas generation used (${yUnit})`;
    chart.data.datasets[7].data = firmGenSeries.map((v) => v / yTier.factor);
    chart.data.datasets[8].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[8].segment = { backgroundColor: (ctx) => gapColors[ctx.p0DataIndex] };
    chart.data.datasets[9].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[9].label = `Demand (${yUnit})`;
    chart.data.datasets[10].data = socResampled.values.map((v) => v / y1Tier.factor);
    chart.data.datasets[10].label = `Battery charge (${y1Unit})`;
    chart.options.scales.y.title.text = yUnit;
    chart.options.scales.y1.title.text = y1Unit;
    chart.options.scales.y1.max = batteryCapacityMWh / y1Tier.factor;
    chart.update("none");

    priceChart.data.labels = priceResampled.labels;
    priceChart.data.datasets[0].data = priceResampled.values;
    priceChart.data.datasets[1].data = histPriceResampled.values;
    priceChart.update("none");

    const windowHours = end - start;
    const unmetHours = unmet.slice(start, end).reduce((a, b) => a + b, 0);
    const probability = 1 - unmetHours / windowHours;
    probabilityEl.textContent = `${(probability * 100).toFixed(1)}%`;
    probabilityNoteEl.textContent =
      `Share of the ${windowHours.toLocaleString()} hourly intervals ${preposition} ${periodLabel} ` +
      `where base, wind, solar, battery discharge, and hydro/gas generation together fully cover demand. Batteries start the year empty.`;

    // Installed mix: each source's share of total installed generation capacity (battery excluded, different unit).
    const totalInstalledMW = nuclearMW + coalMW + windCapacityMW + solarCapacityMW + hydroMW + gasMW;
    const sharePct = (mw) => (totalInstalledMW > 0 ? (mw / totalInstalledMW) * 100 : 0);

    // Utilization: average output over the displayed window as a share of that source's own installed capacity.
    const windowAverage = (values) => values.slice(start, end).reduce((a, b) => a + b, 0) / windowHours;
    const usedPct = (avgMW, installedMW) => (installedMW > 0 ? (avgMW / installedMW) * 100 : 0);

    // Curtailment (export) comes out of base + wind + solar's surplus; wind and solar are curtailed
    // first (split between them by their own generation), then base, since hydro/gas capacity never
    // runs during a surplus so it's never curtailed.
    const exportAvgMW = windowAverage(exportMW);
    const windAvgMW = windowAverage(windGenMW);
    const solarAvgMW = windowAverage(solarGenMW);
    const windSolarAvgMW = windAvgMW + solarAvgMW;
    const baseFullAvgMW = nuclearMW + coalMW;
    const windSolarExportAvgMW = Math.min(windSolarAvgMW, exportAvgMW);
    const baseExportAvgMW = exportAvgMW - windSolarExportAvgMW;
    const windExportAvgMW = windSolarExportAvgMW * (windSolarAvgMW > 0 ? windAvgMW / windSolarAvgMW : 0);
    const solarExportAvgMW = windSolarExportAvgMW * (windSolarAvgMW > 0 ? solarAvgMW / windSolarAvgMW : 0);
    const nuclearExportAvgMW = baseExportAvgMW * (baseFullAvgMW > 0 ? nuclearMW / baseFullAvgMW : 0);
    const coalExportAvgMW = baseExportAvgMW * (baseFullAvgMW > 0 ? coalMW / baseFullAvgMW : 0);
    const exportedPct = (avgMW, installedMW) => (installedMW > 0 ? (avgMW / installedMW) * 100 : 0);
    const exportedNote = (avgMW, installedMW) => {
      const pct = exportedPct(avgMW, installedMW);
      return pct >= 0.5 ? ` (${pct.toFixed(0)}% exported)` : "";
    };

    // Baseload (nuclear + coal) always runs at full output, so each part is 100% used whenever installed.
    capNuclearInstalled.textContent = formatQuantity(nuclearMW, "MW");
    capNuclearShare.textContent = `${sharePct(nuclearMW).toFixed(0)}%`;
    capNuclearUsed.textContent = `${nuclearMW > 0 ? "100" : "0"}%${exportedNote(nuclearExportAvgMW, nuclearMW)}`;

    capCoalInstalled.textContent = formatQuantity(coalMW, "MW");
    capCoalShare.textContent = `${sharePct(coalMW).toFixed(0)}%`;
    capCoalUsed.textContent = `${coalMW > 0 ? "100" : "0"}%${exportedNote(coalExportAvgMW, coalMW)}`;

    capWindInstalled.textContent = formatQuantity(windCapacityMW, "MW");
    capWindShare.textContent = `${sharePct(windCapacityMW).toFixed(0)}%`;
    capWindUsed.textContent = `${usedPct(windAvgMW, windCapacityMW).toFixed(0)}%${exportedNote(windExportAvgMW, windCapacityMW)}`;

    capSolarInstalled.textContent = formatQuantity(solarCapacityMW, "MW");
    capSolarShare.textContent = `${sharePct(solarCapacityMW).toFixed(0)}%`;
    capSolarUsed.textContent = `${usedPct(solarAvgMW, solarCapacityMW).toFixed(0)}%${exportedNote(solarExportAvgMW, solarCapacityMW)}`;

    // Hydro and gas are both treated as last-resort dispatchable sources, freely usable up to their
    // own installed capacity (no fuel/energy constraint modeled).
    const hydroAvgMW = windowAverage(hydroGenMW);
    const gasAvgMW = windowAverage(gasGenMW);

    capHydroInstalled.textContent = formatQuantity(hydroMW, "MW");
    capHydroShare.textContent = `${sharePct(hydroMW).toFixed(0)}%`;
    capHydroUsed.textContent = `${usedPct(hydroAvgMW, hydroMW).toFixed(0)}%`;

    capGasInstalled.textContent = formatQuantity(gasMW, "MW");
    capGasShare.textContent = `${sharePct(gasMW).toFixed(0)}%`;
    capGasUsed.textContent = `${usedPct(gasAvgMW, gasMW).toFixed(0)}%`;

    // Battery has no "installed mix" share (it stores energy rather than generating it); "used" is its
    // average state of charge over the window, as a share of its own energy capacity.
    const avgSocMWh = windowAverage(socMWh);
    capBatteryInstalled.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    capBatteryUsed.textContent = `${usedPct(avgSocMWh, batteryCapacityMWh).toFixed(0)}% avg. charge`;

    // Share of actual generation: each source's own raw average output (nuclear/coal/wind/solar at full
    // generation before any curtailment, hydro/gas dispatched output, battery discharge) as a share
    // of total generation. Exported energy is included here (it was generated), not split out.
    const dischargeAvgMW = windowAverage(batteryDischargeMW);
    const totalGenAvgMW = nuclearMW + coalMW + windAvgMW + solarAvgMW + hydroAvgMW + gasAvgMW + dischargeAvgMW;
    const genSharePct = (avgMW) => (totalGenAvgMW > 0 ? (avgMW / totalGenAvgMW) * 100 : 0);

    capNuclearGenShare.textContent = `${genSharePct(nuclearMW).toFixed(0)}%`;
    capCoalGenShare.textContent = `${genSharePct(coalMW).toFixed(0)}%`;
    capWindGenShare.textContent = `${genSharePct(windAvgMW).toFixed(0)}%`;
    capSolarGenShare.textContent = `${genSharePct(solarAvgMW).toFixed(0)}%`;
    capHydroGenShare.textContent = `${genSharePct(hydroAvgMW).toFixed(0)}%`;
    capGasGenShare.textContent = `${genSharePct(gasAvgMW).toFixed(0)}%`;
    capBatteryGenShare.textContent = `${genSharePct(dischargeAvgMW).toFixed(0)}%`;

    // Share of actual usage: how much of demand was met by each source, plus imports for any deficit
    // that base + wind + solar + battery + hydro + gas couldn't cover. Never affects the probability figure above.
    const totalHours = windGenMW.length;
    const baseUsedMW = new Array(totalHours);
    const windSolarUsedMW = new Array(totalHours);
    for (let i = 0; i < totalHours; i++) {
      const used = Math.min(baseloadMW, scaledDemandMW[i]);
      baseUsedMW[i] = used;
      windSolarUsedMW[i] = Math.min(windGenMW[i] + solarGenMW[i], scaledDemandMW[i] - used);
    }
    const baseUsedAvgMW = windowAverage(baseUsedMW);
    const windSolarUsedAvgMW = windowAverage(windSolarUsedMW);
    const nuclearUsedAvgMW = baseUsedAvgMW * (baseloadMW > 0 ? nuclearMW / baseloadMW : 0);
    const coalUsedAvgMW = baseUsedAvgMW * (baseloadMW > 0 ? coalMW / baseloadMW : 0);
    const windUsedAvgMW = windSolarUsedAvgMW * (windSolarAvgMW > 0 ? windAvgMW / windSolarAvgMW : 0);
    const solarUsedAvgMW = windSolarUsedAvgMW * (windSolarAvgMW > 0 ? solarAvgMW / windSolarAvgMW : 0);
    const importAvgMW = windowAverage(importMW);
    const totalUsageAvgMW =
      nuclearUsedAvgMW + coalUsedAvgMW + windUsedAvgMW + solarUsedAvgMW + hydroAvgMW + gasAvgMW + dischargeAvgMW + importAvgMW;
    const usageSharePct = (avgMW) => (totalUsageAvgMW > 0 ? (avgMW / totalUsageAvgMW) * 100 : 0);

    capNuclearUsageShare.textContent = `${usageSharePct(nuclearUsedAvgMW).toFixed(0)}%`;
    capCoalUsageShare.textContent = `${usageSharePct(coalUsedAvgMW).toFixed(0)}%`;
    capWindUsageShare.textContent = `${usageSharePct(windUsedAvgMW).toFixed(0)}%`;
    capSolarUsageShare.textContent = `${usageSharePct(solarUsedAvgMW).toFixed(0)}%`;
    capHydroUsageShare.textContent = `${usageSharePct(hydroAvgMW).toFixed(0)}%`;
    capGasUsageShare.textContent = `${usageSharePct(gasAvgMW).toFixed(0)}%`;
    capBatteryUsageShare.textContent = `${usageSharePct(dischargeAvgMW).toFixed(0)}%`;
    capImportsUsageShare.textContent = `${usageSharePct(importAvgMW).toFixed(0)}%`;

    // Operating cost & revenue: nuclear/coal/wind/solar/hydro are valued at their own fuel + O&M cost
    // (what it costs to run them, regardless of the market); gas, battery discharge, imports, and
    // exports are valued at that hour's actual price (they're the flexible/traded side of the system).
    const windowValueSEK = (genArray) => {
      let sum = 0;
      for (let i = start; i < end; i++) sum += genArray[i] * priceSekMwh[i];
      return sum;
    };
    // Exports are sold into the wider regional market, not at the (sometimes negative) domestic
    // curtailment price, so they're floored at 0 — always a revenue, never an extra cost. Neighboring
    // markets' own demand for imported surplus has diminishing returns too, though: the first bit of
    // export sells near the full domestic price, but as the exported volume grows relative to a rough
    // interconnector-capacity scale, the marginal price it fetches abroad tails off (saturating demand
    // curve), instead of staying flat no matter how much is dumped on neighboring grids.
    const exportSaturationMW = avgDemandMW * 0.5;
    const exportRevenueSEK = (genArray) => {
      let sum = 0;
      for (let i = start; i < end; i++) {
        const basePrice = Math.max(priceSekMwh[i], 0);
        const effectivePrice = basePrice / (1 + genArray[i] / exportSaturationMW);
        sum += genArray[i] * effectivePrice;
      }
      return sum;
    };
    const marginalNuclear = Number(costMarginalNuclearInput.value);
    const marginalCoal = Number(costMarginalCoalInput.value);
    const marginalWind = Number(costMarginalWindInput.value);
    const marginalSolar = Number(costMarginalSolarInput.value);
    const marginalHydro = Number(costMarginalHydroInput.value);
    const nuclearOpCostSEK = nuclearMW * windowHours * marginalNuclear;
    const coalOpCostSEK = coalMW * windowHours * marginalCoal;
    const windOpCostSEK = windAvgMW * windowHours * marginalWind;
    const solarOpCostSEK = solarAvgMW * windowHours * marginalSolar;
    const hydroOpCostSEK = hydroAvgMW * windowHours * marginalHydro;
    const gasOpCostSEK = windowValueSEK(gasGenMW);
    const batteryOpCostSEK = windowValueSEK(batteryDischargeMW);
    const importOpCostSEK = windowValueSEK(importMW);
    const exportOpCostSEK = -exportRevenueSEK(exportMW);
    const totalOpCostSEK =
      nuclearOpCostSEK +
      coalOpCostSEK +
      windOpCostSEK +
      solarOpCostSEK +
      hydroOpCostSEK +
      gasOpCostSEK +
      batteryOpCostSEK +
      importOpCostSEK +
      exportOpCostSEK;

    opGenNuclear.textContent = formatQuantity(nuclearMW * windowHours, "MWh");
    opCostNuclear.textContent = formatSEK(nuclearOpCostSEK);
    opGenCoal.textContent = formatQuantity(coalMW * windowHours, "MWh");
    opCostCoal.textContent = formatSEK(coalOpCostSEK);
    opGenWind.textContent = formatQuantity(windAvgMW * windowHours, "MWh");
    opCostWind.textContent = formatSEK(windOpCostSEK);
    opGenSolar.textContent = formatQuantity(solarAvgMW * windowHours, "MWh");
    opCostSolar.textContent = formatSEK(solarOpCostSEK);
    opGenHydro.textContent = formatQuantity(hydroAvgMW * windowHours, "MWh");
    opCostHydro.textContent = formatSEK(hydroOpCostSEK);
    opGenGas.textContent = formatQuantity(gasAvgMW * windowHours, "MWh");
    opCostGas.textContent = formatSEK(gasOpCostSEK);
    opGenBattery.textContent = formatQuantity(dischargeAvgMW * windowHours, "MWh");
    opCostBattery.textContent = formatSEK(batteryOpCostSEK);
    opGenImport.textContent = formatQuantity(importAvgMW * windowHours, "MWh");
    opCostImport.textContent = formatSEK(importOpCostSEK);
    opGenExport.textContent = formatQuantity(exportAvgMW * windowHours, "MWh");
    opCostExport.textContent = formatSEK(exportOpCostSEK);
    opCostTotal.textContent = formatSEK(totalOpCostSEK);

    const avgSimPriceMwh = priceSekMwh.slice(start, end).reduce((a, b) => a + b, 0) / windowHours;
    const avgHistPriceMwh = historicalPriceSekMwh.slice(start, end).reduce((a, b) => a + b, 0) / windowHours;
    avgSimPriceEl.textContent = `${avgSimPriceMwh.toFixed(0)} SEK/MWh`;
    avgHistPriceEl.textContent = `${avgHistPriceMwh.toFixed(0)} SEK/MWh`;

    // Illustrative household cost: annual demand assumption prorated to the selected period, at the
    // average simulated price (not a real bill — no grid fees, taxes, or household usage-shape effects).
    const apartmentAnnualKwh = Number(householdApartmentAnnualKwhInput.value);
    const houseAnnualKwh = Number(householdHouseAnnualKwhInput.value);
    const apartmentDemandMWh = (apartmentAnnualKwh / 1000) * (windowHours / totalHours);
    const houseDemandMWh = (houseAnnualKwh / 1000) * (windowHours / totalHours);
    householdApartmentDemandEl.textContent = formatQuantity(apartmentDemandMWh, "MWh");
    householdApartmentCostEl.textContent = formatSEK(apartmentDemandMWh * avgSimPriceMwh);
    householdHouseDemandEl.textContent = formatQuantity(houseDemandMWh, "MWh");
    householdHouseCostEl.textContent = formatSEK(houseDemandMWh * avgSimPriceMwh);

    // Build cost: only capacity currently above each source's already-installed baseline counts,
    // computed from the slider's current position so lowering it back down reduces cost accordingly.
    const addedWindMW = Math.max(0, windCapacityMW - WIND_BASELINE_MW);
    const addedSolarMW = Math.max(0, solarCapacityMW - SOLAR_BASELINE_MW);
    const addedNuclearMW = Math.max(0, nuclearMW - NUCLEAR_BASELINE_MW);
    const addedCoalMW = Math.max(0, coalMW - COAL_BASELINE_MW);
    const addedHydroMW = Math.max(0, hydroMW - HYDRO_BASELINE_MW);
    const addedGasMW = Math.max(0, gasMW - GAS_BASELINE_MW);
    const addedBatteryTWh = batteryCapacityTWh;

    // Cost inputs are billion SEK per GW (generation) or per TWh (battery).
    const sekPerMW = (billionPerGW) => (Number(billionPerGW) * 1e9) / 1000;
    const nuclearCostSEK = addedNuclearMW * sekPerMW(costNuclearInput.value);
    const coalCostSEK = addedCoalMW * sekPerMW(costCoalInput.value);
    const windCostSEK = addedWindMW * sekPerMW(costWindInput.value);
    const solarCostSEK = addedSolarMW * sekPerMW(costSolarInput.value);
    const hydroCostSEK = addedHydroMW * sekPerMW(costHydroInput.value);
    const gasCostSEK = addedGasMW * sekPerMW(costGasInput.value);
    const batteryCostSEK = addedBatteryTWh * Number(costBatteryInput.value) * 1e9;
    const totalCostSEK =
      nuclearCostSEK + coalCostSEK + windCostSEK + solarCostSEK + hydroCostSEK + gasCostSEK + batteryCostSEK;

    costAddedNuclear.textContent = formatQuantity(addedNuclearMW, "MW");
    costSekNuclear.textContent = formatSEK(nuclearCostSEK);
    costAddedCoal.textContent = formatQuantity(addedCoalMW, "MW");
    costSekCoal.textContent = formatSEK(coalCostSEK);
    costAddedWind.textContent = formatQuantity(addedWindMW, "MW");
    costSekWind.textContent = formatSEK(windCostSEK);
    costAddedSolar.textContent = formatQuantity(addedSolarMW, "MW");
    costSekSolar.textContent = formatSEK(solarCostSEK);
    costAddedHydro.textContent = formatQuantity(addedHydroMW, "MW");
    costSekHydro.textContent = formatSEK(hydroCostSEK);
    costAddedGas.textContent = formatQuantity(addedGasMW, "MW");
    costSekGas.textContent = formatSEK(gasCostSEK);
    costAddedBattery.textContent = formatQuantity(addedBatteryTWh * 1e6, "MWh");
    costSekBattery.textContent = formatSEK(batteryCostSEK);
    costSekTotal.textContent = formatSEK(totalCostSEK);
  }

  periodMonthInput.addEventListener("change", () => {
    rebuildWeekOptions();
    rebuildDayOptions();
    update();
  });
  periodWeekInput.addEventListener("change", () => {
    rebuildDayOptions();
    update();
  });
  periodDayInput.addEventListener("change", update);
  demandScaleInput.addEventListener("input", update);
  windCapacityInput.addEventListener("input", update);
  solarCapacityInput.addEventListener("input", update);
  batteryCapacityInput.addEventListener("input", update);
  nuclearCapacityInput.addEventListener("input", update);
  coalCapacityInput.addEventListener("input", update);
  hydroCapacityInput.addEventListener("input", update);
  gasCapacityInput.addEventListener("input", update);
  costNuclearInput.addEventListener("input", update);
  costCoalInput.addEventListener("input", update);
  costWindInput.addEventListener("input", update);
  costSolarInput.addEventListener("input", update);
  costHydroInput.addEventListener("input", update);
  costGasInput.addEventListener("input", update);
  costBatteryInput.addEventListener("input", update);
  costMarginalNuclearInput.addEventListener("input", update);
  costMarginalCoalInput.addEventListener("input", update);
  costMarginalWindInput.addEventListener("input", update);
  costMarginalSolarInput.addEventListener("input", update);
  costMarginalHydroInput.addEventListener("input", update);
  costPriceDeepSurplusInput.addEventListener("input", update);
  costPriceBalancedInput.addEventListener("input", update);
  costPriceHydroTopInput.addEventListener("input", update);
  costPriceGasTopInput.addEventListener("input", update);
  costPriceScarcityInput.addEventListener("input", update);
  householdApartmentAnnualKwhInput.addEventListener("input", update);
  householdHouseAnnualKwhInput.addEventListener("input", update);
  rebuildWeekOptions();
  rebuildDayOptions();
  update();
}

main().catch((err) => {
  console.error(err);
  document.querySelector("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="error">Failed to load simulation data: ${err.message}</p>`
  );
});
