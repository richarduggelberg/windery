// Windery: wind + battery vs demand simulation, driven by static data files.

const CUT_IN_MS = 3;
const RATED_MS = 12;
const CUT_OUT_MS = 25;

// Sweden's approximate installed capacity as of 2025/2026, used as the 100% baseline for the capacity sliders.
const WIND_BASELINE_MW = 19000;
const BASELOAD_BASELINE_MW = 7000;
const VARIABLE_BASELINE_MW = 16500;

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

// Downsample a series to weekly (7-day) means, labeled by the first day of each week.
function weeklyAverage(time, values) {
  const buckets = new Map();
  time.forEach((iso, i) => {
    const dayIndex = Math.floor((Date.parse(iso + "Z") - Date.parse(time[0] + "Z")) / (24 * 60 * 60 * 1000));
    const weekStart = Math.floor(dayIndex / 7) * 7;
    if (!buckets.has(weekStart)) buckets.set(weekStart, { label: iso.slice(0, 10), values: [] });
    buckets.get(weekStart).values.push(values[i]);
  });
  const entries = [...buckets.values()];
  return {
    labels: entries.map((e) => e.label),
    means: entries.map((e) => e.values.reduce((a, b) => a + b, 0) / e.values.length),
  };
}

const PERIODS = {
  year: { label: "2024", preposition: "in", unit: "weekly" },
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
  let soc = batteryCapacityMWh; // batteries start fully charged

  // Demand is met additively, in priority order: base, then wind, then battery, then variable (last resort).
  for (let i = 0; i < totalHours; i++) {
    const windGen = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const firmGen = windGen + baseloadMW; // base + wind, neither is dispatchable
    const demand = demandMW[i];
    const net = firmGen - demand; // MW over a 1-hour step == MWh
    let discharge = 0;
    let variableGen = 0;

    if (net >= 0) {
      // Surplus base + wind generation charges the battery; variable capacity never charges it.
      const surplus = net;
      const chargeFromSurplus = Math.min(surplus, batteryCapacityMWh - soc);
      soc += chargeFromSurplus;
      // Any surplus beyond battery headroom is curtailed/exported (not modeled further).
    } else {
      let deficit = -net;
      discharge = Math.min(deficit, soc);
      soc -= discharge;
      deficit -= discharge;

      // Dispatchable gas/hydro is the last resort, covering only what base + wind + battery couldn't.
      variableGen = Math.min(deficit, variableCapacityMW);
      deficit -= variableGen;
      if (deficit > 0) unmet[i] = 1;
    }
    windGenMW[i] = windGen;
    batteryDischargeMW[i] = discharge;
    variableGenMW[i] = variableGen;
    socMWh[i] = soc;
  }

  return { windGenMW, batteryDischargeMW, variableGenMW, socMWh, unmet };
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
  const baseloadCapacityInput = document.getElementById("baseloadCapacity");
  const variableCapacityInput = document.getElementById("variableCapacity");
  const windCapacityValue = document.getElementById("windCapacityValue");
  const batteryCapacityValue = document.getElementById("batteryCapacityValue");
  const baseloadCapacityValue = document.getElementById("baseloadCapacityValue");
  const variableCapacityValue = document.getElementById("variableCapacityValue");
  const demandScaleValue = document.getElementById("demandScaleValue");
  const probabilityEl = document.getElementById("probability");
  const probabilityNoteEl = document.getElementById("probabilityNote");

  // The fetched profile already represents Sweden's current nationwide demand; the slider scales it up/down from there.
  const baseAnnualDemandMWh = demand.demandMW.reduce((a, b) => a + b, 0);

  // Resample a full-year series to the selected window, using hourly points for short windows,
  // daily means for medium windows, and weekly means for the full year so the chart stays readable.
  function resample(time, values, period, start, end) {
    const timeSlice = time.slice(start, end);
    const valueSlice = values.slice(start, end);
    if (PERIODS[period].unit === "hourly") {
      return { labels: timeSlice.map(hourlyLabel), values: valueSlice };
    }
    if (PERIODS[period].unit === "weekly") {
      const { labels, means } = weeklyAverage(timeSlice, valueSlice);
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
          label: "Base generation (MW)",
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
          label: "Wind generation (MW)",
          data: [],
          borderColor: "#2b7a78",
          backgroundColor: "rgba(43, 122, 120, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 2,
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
          order: 3,
        },
        {
          label: "Variable generation used (MW)",
          data: [],
          borderColor: "#e0a458",
          backgroundColor: "rgba(224, 164, 88, 0.35)",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
          stack: "gen",
          fill: "-1",
          order: 4,
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
          order: 5,
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
          fill: { target: 4 },
          order: 6,
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
          order: 7,
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
          order: 8,
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

    // Cap the battery slider at the total energy demand over the displayed window —
    // a battery bigger than that could never be more than fully useful there.
    // Step stays fixed (changing it can silently snap the current value to 0 in some browsers).
    const totalDemandMWh = scaledDemandMW.slice(start, end).reduce((a, b) => a + b, 0);
    const batteryMax = Math.max(100, Math.round(totalDemandMWh));
    batteryCapacityInput.max = batteryMax;
    if (Number(batteryCapacityInput.value) > batteryMax) {
      batteryCapacityInput.value = batteryMax;
    }

    const windCapacityMW = WIND_BASELINE_MW * (Number(windCapacityInput.value) / 100);
    const batteryCapacityMWh = Number(batteryCapacityInput.value);
    const baseloadMW = BASELOAD_BASELINE_MW * (Number(baseloadCapacityInput.value) / 100);
    const variableCapacityMW = VARIABLE_BASELINE_MW * (Number(variableCapacityInput.value) / 100);
    windCapacityValue.textContent = `${windCapacityInput.value}% (${formatQuantity(windCapacityMW, "MW")})`;
    batteryCapacityValue.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    baseloadCapacityValue.textContent = `${baseloadCapacityInput.value}% (${formatQuantity(baseloadMW, "MW")})`;
    variableCapacityValue.textContent = `${variableCapacityInput.value}% (${formatQuantity(variableCapacityMW, "MW")})`;

    // Always simulate the full year so battery state of charge carries over correctly,
    // then slice down to the selected window for display and the probability figure.
    const { windGenMW, batteryDischargeMW, variableGenMW, socMWh, unmet } = runSimulation(
      wind.windSpeed100m,
      scaledDemandMW,
      windCapacityMW,
      batteryCapacityMWh,
      baseloadMW,
      variableCapacityMW
    );

    const windResampled = resample(wind.time, windGenMW, period, start, end);
    const dischargeResampled = resample(wind.time, batteryDischargeMW, period, start, end);
    const variableResampled = resample(wind.time, variableGenMW, period, start, end);
    const socResampled = resample(wind.time, socMWh, period, start, end);
    const demandResampled = resample(demand.time, scaledDemandMW, period, start, end);
    const baseloadSeries = new Array(windResampled.values.length).fill(baseloadMW);
    const firmGenSeries = windResampled.values.map((v) => v + baseloadMW);

    // Pick one unit per axis (MW/GW/TW...) based on the largest value currently shown on it.
    const yTier = unitTier(
      Math.max(
        0,
        ...windResampled.values,
        ...baseloadSeries,
        ...dischargeResampled.values,
        ...variableResampled.values,
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
    chart.data.datasets[0].data = baseloadSeries.map((v) => v / yTier.factor);
    chart.data.datasets[0].label = `Base generation (${yUnit})`;
    chart.data.datasets[1].data = windResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[1].label = `Wind generation (${yUnit})`;
    chart.data.datasets[2].data = dischargeResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[2].label = `Battery discharge used (${yUnit})`;
    chart.data.datasets[3].data = variableResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[3].label = `Variable generation used (${yUnit})`;
    chart.data.datasets[4].data = firmGenSeries.map((v) => v / yTier.factor);
    chart.data.datasets[5].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[5].segment = { backgroundColor: (ctx) => gapColors[ctx.p0DataIndex] };
    chart.data.datasets[6].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[6].label = `Demand (${yUnit})`;
    chart.data.datasets[7].data = socResampled.values.map((v) => v / y1Tier.factor);
    chart.data.datasets[7].label = `Battery charge (${y1Unit})`;
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
  }

  periodInput.addEventListener("change", update);
  demandScaleInput.addEventListener("input", update);
  windCapacityInput.addEventListener("input", update);
  batteryCapacityInput.addEventListener("input", update);
  baseloadCapacityInput.addEventListener("input", update);
  variableCapacityInput.addEventListener("input", update);
  update();
}

main().catch((err) => {
  console.error(err);
  document.querySelector("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="error">Failed to load simulation data: ${err.message}</p>`
  );
});
