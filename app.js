// Windery: wind + battery vs demand simulation, driven by static data files.

const CUT_IN_MS = 3;
const RATED_MS = 12;
const CUT_OUT_MS = 25;

// Sweden's approximate installed capacity as of 2025/2026, used as the 100% baseline for the wind slider
// and as the already-installed level (below which no build cost accrues) for the others.
const WIND_BASELINE_MW = 19000;
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

const PERIODS = {
  year: { label: "2024", preposition: "in", unit: "halfWeekly" },
  january: { label: "January 2024", preposition: "in", unit: "daily" },
  week1: { label: "the first week of January 2024", preposition: "in", unit: "hourly" },
  day1: { label: "January 1, 2024", preposition: "on", unit: "hourly" },
};

// Data starts at hour 0 of Jan 1, so each period is just a slice of the first N hours/days.
function periodIndexRange(time, period) {
  const year = time[0].slice(0, 4);
  if (period === "january") {
    let end = time.findIndex((t) => !t.startsWith(`${year}-01`));
    if (end === -1) end = time.length;
    return [0, end];
  }
  if (period === "week1") return [0, Math.min(7 * 24, time.length)];
  if (period === "day1") return [0, Math.min(24, time.length)];
  return [0, time.length];
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
  demandMW,
  windCapacityMW,
  batteryCapacityMWh,
  baseloadMW,
  variableCapacityMW
) {
  const totalHours = windSpeed.length;
  const windGenMW = new Array(totalHours);
  const batteryDischargeMW = new Array(totalHours);
  const variableGenMW = new Array(totalHours);
  const socMWh = new Array(totalHours);
  const unmet = new Uint8Array(totalHours);
  const exportMW = new Array(totalHours); // curtailed surplus beyond battery headroom
  const importMW = new Array(totalHours); // deficit left uncovered by base+wind+battery+variable
  let soc = batteryCapacityMWh; // batteries start fully charged

  // Demand is met additively, in priority order: base, then wind, then battery, then variable (last resort).
  for (let i = 0; i < totalHours; i++) {
    const windGen = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const firmGen = windGen + baseloadMW; // base + wind, neither is dispatchable
    const demand = demandMW[i];
    const net = firmGen - demand; // MW over a 1-hour step == MWh
    let discharge = 0;
    let variableGen = 0;
    let curtailed = 0;
    let unmetMW = 0;

    if (net >= 0) {
      // Surplus base + wind generation charges the battery; variable capacity never charges it.
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

      // Dispatchable gas/hydro is the last resort, covering only what base + wind + battery couldn't.
      variableGen = Math.min(deficit, variableCapacityMW);
      deficit -= variableGen;
      if (deficit > 0) {
        unmet[i] = 1;
        unmetMW = deficit; // treated as imported from outside the modeled system
      }
    }
    windGenMW[i] = windGen;
    batteryDischargeMW[i] = discharge;
    variableGenMW[i] = variableGen;
    socMWh[i] = soc;
    exportMW[i] = curtailed;
    importMW[i] = unmetMW;
  }

  return { windGenMW, batteryDischargeMW, variableGenMW, socMWh, unmet, exportMW, importMW };
}

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}

async function main() {
  const [wind, demand] = await Promise.all([
    loadJSON("data/wind.json"),
    loadJSON("data/demand.json"),
  ]);

  const periodInput = document.getElementById("period");
  const demandScaleInput = document.getElementById("demandScale");
  const windCapacityInput = document.getElementById("windCapacity");
  const batteryCapacityInput = document.getElementById("batteryCapacity");
  const nuclearCapacityInput = document.getElementById("nuclearCapacity");
  const coalCapacityInput = document.getElementById("coalCapacity");
  const hydroCapacityInput = document.getElementById("hydroCapacity");
  const gasCapacityInput = document.getElementById("gasCapacity");
  const windCapacityValue = document.getElementById("windCapacityValue");
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
  const capExportsGenShare = document.getElementById("capExportsGenShare");
  const costNuclearInput = document.getElementById("costNuclear");
  const costCoalInput = document.getElementById("costCoal");
  const costWindInput = document.getElementById("costWind");
  const costHydroInput = document.getElementById("costHydro");
  const costGasInput = document.getElementById("costGas");
  const costBatteryInput = document.getElementById("costBattery");
  const costAddedNuclear = document.getElementById("costAddedNuclear");
  const costSekNuclear = document.getElementById("costSekNuclear");
  const costAddedCoal = document.getElementById("costAddedCoal");
  const costSekCoal = document.getElementById("costSekCoal");
  const costAddedWind = document.getElementById("costAddedWind");
  const costSekWind = document.getElementById("costSekWind");
  const costAddedHydro = document.getElementById("costAddedHydro");
  const costSekHydro = document.getElementById("costSekHydro");
  const costAddedGas = document.getElementById("costAddedGas");
  const costSekGas = document.getElementById("costSekGas");
  const costAddedBattery = document.getElementById("costAddedBattery");
  const costSekBattery = document.getElementById("costSekBattery");
  const costSekTotal = document.getElementById("costSekTotal");

  // The fetched profile already represents Sweden's current nationwide demand; the slider scales it up/down from there.
  const baseAnnualDemandMWh = demand.demandMW.reduce((a, b) => a + b, 0);

  // Resample a full-year series to the selected window, using hourly points for short windows,
  // daily means for medium windows, and half-week means for the full year so the chart stays readable.
  function resample(time, values, period, start, end) {
    const timeSlice = time.slice(start, end);
    const valueSlice = values.slice(start, end);
    if (PERIODS[period].unit === "hourly") {
      return { labels: timeSlice.map(hourlyLabel), values: valueSlice };
    }
    if (PERIODS[period].unit === "halfWeekly") {
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
          label: "Battery discharge used (MW)",
          data: [],
          borderColor: "#5b7fd6",
          backgroundColor: "rgba(91, 127, 214, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 4,
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
          order: 5,
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
          order: 6,
        },
        {
          // Invisible; only exists as a fill target so the gap dataset can shade base+wind vs demand.
          label: "Base + wind (firm generation)",
          data: [],
          borderWidth: 0,
          pointRadius: 0,
          borderColor: "transparent",
          backgroundColor: "transparent",
          yAxisID: "y",
          stack: "firmgen",
          fill: false,
          order: 7,
          hideInLegend: true,
        },
        {
          // Shades the gap between firm (base+wind) generation and demand: red where demand isn't
          // met by base+wind alone (battery/variable had to help), green where there's a surplus.
          label: "Surplus / shortfall vs. demand",
          data: [],
          borderWidth: 0,
          pointRadius: 0,
          borderColor: "transparent",
          yAxisID: "y",
          stack: "gap",
          fill: { target: 6 },
          order: 8,
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
          order: 9,
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
          order: 10,
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

  function update() {
    const period = periodInput.value;
    const [start, end] = periodIndexRange(wind.time, period);

    const demandScalePercent = Number(demandScaleInput.value);
    const demandFactor = demandScalePercent / 100;
    const scaledDemandMW = demand.demandMW.map((v) => v * demandFactor);
    demandScaleValue.textContent = `${demandScalePercent}% (${formatQuantity(baseAnnualDemandMWh * demandFactor, "MWh")}/yr)`;

    const windCapacityMW = WIND_BASELINE_MW * (Number(windCapacityInput.value) / 100);
    // Battery slider moves through fixed TWh notches (index into BATTERY_CAPACITY_STEPS_TWH).
    const batteryCapacityTWh = BATTERY_CAPACITY_STEPS_TWH[Number(batteryCapacityInput.value)];
    const batteryCapacityMWh = batteryCapacityTWh * 1e6;
    // Nuclear/hydro sliders are % of baseline (non-zero defaults); coal/gas are absolute GW (zero default).
    const nuclearMW = NUCLEAR_BASELINE_MW * (Number(nuclearCapacityInput.value) / 100);
    const coalMW = Number(coalCapacityInput.value) * 1000;
    const hydroMW = HYDRO_BASELINE_MW * (Number(hydroCapacityInput.value) / 100);
    const gasMW = Number(gasCapacityInput.value) * 1000;
    const baseloadMW = nuclearMW + coalMW;
    const variableCapacityMW = hydroMW + gasMW;
    windCapacityValue.textContent = `${windCapacityInput.value}% (${formatQuantity(windCapacityMW, "MW")})`;
    batteryCapacityValue.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    nuclearCapacityValue.textContent = `${nuclearCapacityInput.value}% (${formatQuantity(nuclearMW, "MW")})`;
    coalCapacityValue.textContent = formatQuantity(coalMW, "MW");
    hydroCapacityValue.textContent = `${hydroCapacityInput.value}% (${formatQuantity(hydroMW, "MW")})`;
    gasCapacityValue.textContent = formatQuantity(gasMW, "MW");

    // Always simulate the full year so battery state of charge carries over correctly,
    // then slice down to the selected window for display and the probability figure.
    const { windGenMW, batteryDischargeMW, variableGenMW, socMWh, unmet, exportMW, importMW } = runSimulation(
      wind.windSpeed100m,
      scaledDemandMW,
      windCapacityMW,
      batteryCapacityMWh,
      baseloadMW,
      variableCapacityMW
    );

    // Hydro and gas share one dispatchable pool in the simulation; split its output between them
    // proportionally to their installed capacity so each gets its own chart curve.
    const hydroShare = variableCapacityMW > 0 ? hydroMW / variableCapacityMW : 0;
    const gasShare = variableCapacityMW > 0 ? gasMW / variableCapacityMW : 0;
    const hydroGenMW = variableGenMW.map((v) => v * hydroShare);
    const gasGenMW = variableGenMW.map((v) => v * gasShare);

    const windResampled = resample(wind.time, windGenMW, period, start, end);
    const dischargeResampled = resample(wind.time, batteryDischargeMW, period, start, end);
    const hydroResampled = resample(wind.time, hydroGenMW, period, start, end);
    const gasResampled = resample(wind.time, gasGenMW, period, start, end);
    const socResampled = resample(wind.time, socMWh, period, start, end);
    const demandResampled = resample(demand.time, scaledDemandMW, period, start, end);
    const nuclearSeries = new Array(windResampled.values.length).fill(nuclearMW);
    const coalSeries = new Array(windResampled.values.length).fill(coalMW);
    const firmGenSeries = windResampled.values.map((v) => v + baseloadMW);

    // Pick one unit per axis (MW/GW/TW...) based on the largest value currently shown on it.
    const yTier = unitTier(
      Math.max(
        0,
        ...windResampled.values,
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

    // Red where base + wind alone fall short of demand (battery/variable had to cover the rest),
    // green where base + wind exceed demand (surplus charges the battery or is exported).
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
    chart.data.datasets[3].data = dischargeResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[3].label = `Battery discharge used (${yUnit})`;
    chart.data.datasets[4].data = hydroResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[4].label = `Hydro generation used (${yUnit})`;
    chart.data.datasets[5].data = gasResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[5].label = `Gas generation used (${yUnit})`;
    chart.data.datasets[6].data = firmGenSeries.map((v) => v / yTier.factor);
    chart.data.datasets[7].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[7].segment = { backgroundColor: (ctx) => gapColors[ctx.p0DataIndex] };
    chart.data.datasets[8].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[8].label = `Demand (${yUnit})`;
    chart.data.datasets[9].data = socResampled.values.map((v) => v / y1Tier.factor);
    chart.data.datasets[9].label = `Battery charge (${y1Unit})`;
    chart.options.scales.y.title.text = yUnit;
    chart.options.scales.y1.title.text = y1Unit;
    chart.options.scales.y1.max = batteryCapacityMWh / y1Tier.factor;
    chart.update("none");

    const windowHours = end - start;
    const unmetHours = unmet.slice(start, end).reduce((a, b) => a + b, 0);
    const probability = 1 - unmetHours / windowHours;
    probabilityEl.textContent = `${(probability * 100).toFixed(1)}%`;
    probabilityNoteEl.textContent =
      `Share of the ${windowHours.toLocaleString()} hourly intervals ${PERIODS[period].preposition} ${PERIODS[period].label} ` +
      `where base, wind, battery discharge, and variable generation together fully cover demand. Batteries start the year fully charged.`;

    // Installed mix: each source's share of total installed generation capacity (battery excluded, different unit).
    const totalInstalledMW = nuclearMW + coalMW + windCapacityMW + hydroMW + gasMW;
    const sharePct = (mw) => (totalInstalledMW > 0 ? (mw / totalInstalledMW) * 100 : 0);

    // Utilization: average output over the displayed window as a share of that source's own installed capacity.
    const windowAverage = (values) => values.slice(start, end).reduce((a, b) => a + b, 0) / windowHours;
    const usedPct = (avgMW, installedMW) => (installedMW > 0 ? (avgMW / installedMW) * 100 : 0);

    // Baseload (nuclear + coal) always runs at full output, so each part is 100% used whenever installed.
    capNuclearInstalled.textContent = formatQuantity(nuclearMW, "MW");
    capNuclearShare.textContent = `${sharePct(nuclearMW).toFixed(0)}%`;
    capNuclearUsed.textContent = `${nuclearMW > 0 ? "100" : "0"}%`;

    capCoalInstalled.textContent = formatQuantity(coalMW, "MW");
    capCoalShare.textContent = `${sharePct(coalMW).toFixed(0)}%`;
    capCoalUsed.textContent = `${coalMW > 0 ? "100" : "0"}%`;

    const windAvgMW = windowAverage(windGenMW);
    capWindInstalled.textContent = formatQuantity(windCapacityMW, "MW");
    capWindShare.textContent = `${sharePct(windCapacityMW).toFixed(0)}%`;
    capWindUsed.textContent = `${usedPct(windAvgMW, windCapacityMW).toFixed(0)}%`;

    // Hydro and gas share one dispatchable pool in the simulation, so both are assumed used at the pool's
    // overall utilization rate (there's no way to attribute dispatch to one vs. the other individually).
    const variableAvgMW = windowAverage(variableGenMW);
    const variableUsedPct = usedPct(variableAvgMW, variableCapacityMW);

    capHydroInstalled.textContent = formatQuantity(hydroMW, "MW");
    capHydroShare.textContent = `${sharePct(hydroMW).toFixed(0)}%`;
    capHydroUsed.textContent = `${variableUsedPct.toFixed(0)}%`;

    capGasInstalled.textContent = formatQuantity(gasMW, "MW");
    capGasShare.textContent = `${sharePct(gasMW).toFixed(0)}%`;
    capGasUsed.textContent = `${variableUsedPct.toFixed(0)}%`;

    // Battery has no "installed mix" share (it stores energy rather than generating it); "used" is its
    // average state of charge over the window, as a share of its own energy capacity.
    const avgSocMWh = windowAverage(socMWh);
    capBatteryInstalled.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    capBatteryUsed.textContent = `${usedPct(avgSocMWh, batteryCapacityMWh).toFixed(0)}% avg. charge`;

    // Share of actual generation: nuclear/coal/wind full output, hydro/gas dispatched output, battery
    // discharge, and exports (curtailed surplus) — sums to ~100% of all delivered + exported energy.
    const dischargeAvgMW = windowAverage(batteryDischargeMW);
    const exportAvgMW = windowAverage(exportMW);
    const nuclearFullAvgMW = nuclearMW; // baseload runs constant, so its average output equals its capacity
    const coalFullAvgMW = coalMW;
    const hydroAvgMW = variableAvgMW * (variableCapacityMW > 0 ? hydroMW / variableCapacityMW : 0);
    const gasAvgMW = variableAvgMW * (variableCapacityMW > 0 ? gasMW / variableCapacityMW : 0);

    // Curtailment comes out of base + wind's own output; attribute it to wind first, then to base,
    // so it isn't double-counted inside each source's row as well as in the "Exports" row.
    const baseFullAvgMW = nuclearFullAvgMW + coalFullAvgMW;
    const windExportAvgMW = Math.min(windAvgMW, exportAvgMW);
    const baseExportAvgMW = exportAvgMW - windExportAvgMW;
    const windAvgMWNet = windAvgMW - windExportAvgMW;
    const nuclearAvgMW = nuclearFullAvgMW - baseExportAvgMW * (baseFullAvgMW > 0 ? nuclearFullAvgMW / baseFullAvgMW : 0);
    const coalAvgMW = coalFullAvgMW - baseExportAvgMW * (baseFullAvgMW > 0 ? coalFullAvgMW / baseFullAvgMW : 0);

    const totalGenAvgMW =
      nuclearAvgMW + coalAvgMW + windAvgMWNet + hydroAvgMW + gasAvgMW + dischargeAvgMW + exportAvgMW;
    const genSharePct = (avgMW) => (totalGenAvgMW > 0 ? (avgMW / totalGenAvgMW) * 100 : 0);

    capNuclearGenShare.textContent = `${genSharePct(nuclearAvgMW).toFixed(0)}%`;
    capCoalGenShare.textContent = `${genSharePct(coalAvgMW).toFixed(0)}%`;
    capWindGenShare.textContent = `${genSharePct(windAvgMWNet).toFixed(0)}%`;
    capHydroGenShare.textContent = `${genSharePct(hydroAvgMW).toFixed(0)}%`;
    capGasGenShare.textContent = `${genSharePct(gasAvgMW).toFixed(0)}%`;
    capBatteryGenShare.textContent = `${genSharePct(dischargeAvgMW).toFixed(0)}%`;
    capExportsGenShare.textContent = `${genSharePct(exportAvgMW).toFixed(0)}%`;

    // Share of actual usage: how much of demand was met by each source, plus imports for any deficit
    // that base + wind + battery + variable couldn't cover. Never affects the probability figure above.
    const totalHours = windGenMW.length;
    const baseUsedMW = new Array(totalHours);
    const windUsedMW = new Array(totalHours);
    for (let i = 0; i < totalHours; i++) {
      const used = Math.min(baseloadMW, scaledDemandMW[i]);
      baseUsedMW[i] = used;
      windUsedMW[i] = Math.min(windGenMW[i], scaledDemandMW[i] - used);
    }
    const baseUsedAvgMW = windowAverage(baseUsedMW);
    const windUsedAvgMW = windowAverage(windUsedMW);
    const nuclearUsedAvgMW = baseUsedAvgMW * (baseloadMW > 0 ? nuclearMW / baseloadMW : 0);
    const coalUsedAvgMW = baseUsedAvgMW * (baseloadMW > 0 ? coalMW / baseloadMW : 0);
    const importAvgMW = windowAverage(importMW);
    const totalUsageAvgMW =
      nuclearUsedAvgMW + coalUsedAvgMW + windUsedAvgMW + hydroAvgMW + gasAvgMW + dischargeAvgMW + importAvgMW;
    const usageSharePct = (avgMW) => (totalUsageAvgMW > 0 ? (avgMW / totalUsageAvgMW) * 100 : 0);

    capNuclearUsageShare.textContent = `${usageSharePct(nuclearUsedAvgMW).toFixed(0)}%`;
    capCoalUsageShare.textContent = `${usageSharePct(coalUsedAvgMW).toFixed(0)}%`;
    capWindUsageShare.textContent = `${usageSharePct(windUsedAvgMW).toFixed(0)}%`;
    capHydroUsageShare.textContent = `${usageSharePct(hydroAvgMW).toFixed(0)}%`;
    capGasUsageShare.textContent = `${usageSharePct(gasAvgMW).toFixed(0)}%`;
    capBatteryUsageShare.textContent = `${usageSharePct(dischargeAvgMW).toFixed(0)}%`;
    capImportsUsageShare.textContent = `${usageSharePct(importAvgMW).toFixed(0)}%`;

    // Build cost: only capacity currently above each source's already-installed baseline counts,
    // computed from the slider's current position so lowering it back down reduces cost accordingly.
    const addedWindMW = Math.max(0, windCapacityMW - WIND_BASELINE_MW);
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
    const hydroCostSEK = addedHydroMW * sekPerMW(costHydroInput.value);
    const gasCostSEK = addedGasMW * sekPerMW(costGasInput.value);
    const batteryCostSEK = addedBatteryTWh * Number(costBatteryInput.value) * 1e9;
    const totalCostSEK =
      nuclearCostSEK + coalCostSEK + windCostSEK + hydroCostSEK + gasCostSEK + batteryCostSEK;

    costAddedNuclear.textContent = formatQuantity(addedNuclearMW, "MW");
    costSekNuclear.textContent = formatSEK(nuclearCostSEK);
    costAddedCoal.textContent = formatQuantity(addedCoalMW, "MW");
    costSekCoal.textContent = formatSEK(coalCostSEK);
    costAddedWind.textContent = formatQuantity(addedWindMW, "MW");
    costSekWind.textContent = formatSEK(windCostSEK);
    costAddedHydro.textContent = formatQuantity(addedHydroMW, "MW");
    costSekHydro.textContent = formatSEK(hydroCostSEK);
    costAddedGas.textContent = formatQuantity(addedGasMW, "MW");
    costSekGas.textContent = formatSEK(gasCostSEK);
    costAddedBattery.textContent = formatQuantity(addedBatteryTWh * 1e6, "MWh");
    costSekBattery.textContent = formatSEK(batteryCostSEK);
    costSekTotal.textContent = formatSEK(totalCostSEK);
  }

  periodInput.addEventListener("change", update);
  demandScaleInput.addEventListener("input", update);
  windCapacityInput.addEventListener("input", update);
  batteryCapacityInput.addEventListener("input", update);
  nuclearCapacityInput.addEventListener("input", update);
  coalCapacityInput.addEventListener("input", update);
  hydroCapacityInput.addEventListener("input", update);
  gasCapacityInput.addEventListener("input", update);
  costNuclearInput.addEventListener("input", update);
  costCoalInput.addEventListener("input", update);
  costWindInput.addEventListener("input", update);
  costHydroInput.addEventListener("input", update);
  costGasInput.addEventListener("input", update);
  costBatteryInput.addEventListener("input", update);
  update();
}

main().catch((err) => {
  console.error(err);
  document.querySelector("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="error">Failed to load simulation data: ${err.message}</p>`
  );
});
