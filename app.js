// Windery: wind + battery vs demand simulation, driven by static data files.

const CUT_IN_MS = 3;
const RATED_MS = 12;
const CUT_OUT_MS = 25;

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

const PERIODS = {
  year: { label: "2024", preposition: "in", unit: "daily" },
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
  const generationMW = new Array(totalHours);
  const variableGenMW = new Array(totalHours);
  const socMWh = new Array(totalHours);
  const unmet = new Uint8Array(totalHours);
  let soc = batteryCapacityMWh; // batteries start fully charged

  for (let i = 0; i < totalHours; i++) {
    const windGen = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const generation = windGen + baseloadMW; // baseload runs constantly
    const demand = demandMW[i];
    const net = generation - demand; // MW over a 1-hour step == MWh
    let variableGen = 0;

    if (net >= 0) {
      // Surplus wind + base generation charges the battery first.
      const surplus = net;
      const chargeFromSurplus = Math.min(surplus, batteryCapacityMWh - soc);
      soc += chargeFromSurplus;

      // Any remaining battery headroom is topped up by idle variable capacity.
      const chargeRoom = batteryCapacityMWh - soc;
      const chargeFromVariable = Math.min(chargeRoom, variableCapacityMW);
      soc += chargeFromVariable;
      variableGen = chargeFromVariable;
    } else {
      let deficit = -net;
      const discharge = Math.min(deficit, soc);
      soc -= discharge;
      deficit -= discharge;

      // Dispatchable gas/hydro is the last resort, covering only what wind + base + battery couldn't.
      const coverDeficit = Math.min(deficit, variableCapacityMW);
      deficit -= coverDeficit;
      if (deficit > 0) unmet[i] = 1;

      // Any leftover variable capacity charges the battery if it still has room.
      const leftoverVariableCap = variableCapacityMW - coverDeficit;
      const chargeRoom = batteryCapacityMWh - soc;
      const chargeFromVariable = Math.min(leftoverVariableCap, chargeRoom);
      soc += chargeFromVariable;
      variableGen = coverDeficit + chargeFromVariable;
    }
    generationMW[i] = windGen;
    variableGenMW[i] = variableGen;
    socMWh[i] = soc;
  }

  return { generationMW, variableGenMW, socMWh, unmet };
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

  // Resample a full-year series to the selected window, using hourly points for
  // short windows and daily means for longer ones so the chart stays readable.
  function resample(time, values, period, start, end) {
    const timeSlice = time.slice(start, end);
    const valueSlice = values.slice(start, end);
    if (PERIODS[period].unit === "hourly") {
      return { labels: timeSlice.map(hourlyLabel), values: valueSlice };
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
          label: "Wind generation (MW)",
          data: [],
          borderColor: "#2b7a78",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
        },
        {
          label: "Base generation (MW)",
          data: [],
          borderColor: "#7a5c2b",
          borderDash: [4, 3],
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
        },
        {
          label: "Variable generation used (MW)",
          data: [],
          borderColor: "#e0a458",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
        },
        {
          label: "Demand (MW)",
          data: [],
          borderColor: "#c44536",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y",
        },
        {
          label: "Battery charge (MWh)",
          data: [],
          borderColor: "#5b7fd6",
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: "y1",
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: { title: { display: true, text: "MW" } },
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

    const windCapacityMW = Number(windCapacityInput.value);
    const batteryCapacityMWh = Number(batteryCapacityInput.value);
    const baseloadMW = Number(baseloadCapacityInput.value);
    const variableCapacityMW = Number(variableCapacityInput.value);
    windCapacityValue.textContent = formatQuantity(windCapacityMW, "MW");
    batteryCapacityValue.textContent = formatQuantity(batteryCapacityMWh, "MWh");
    baseloadCapacityValue.textContent = formatQuantity(baseloadMW, "MW");
    variableCapacityValue.textContent = formatQuantity(variableCapacityMW, "MW");

    // Always simulate the full year so battery state of charge carries over correctly,
    // then slice down to the selected window for display and the probability figure.
    const { generationMW, variableGenMW, socMWh, unmet } = runSimulation(
      wind.windSpeed100m,
      scaledDemandMW,
      windCapacityMW,
      batteryCapacityMWh,
      baseloadMW,
      variableCapacityMW
    );

    const genResampled = resample(wind.time, generationMW, period, start, end);
    const variableResampled = resample(wind.time, variableGenMW, period, start, end);
    const socResampled = resample(wind.time, socMWh, period, start, end);
    const demandResampled = resample(demand.time, scaledDemandMW, period, start, end);
    const baseloadSeries = new Array(genResampled.values.length).fill(baseloadMW);

    // Pick one unit per axis (MW/GW/TW...) based on the largest value currently shown on it.
    const yTier = unitTier(
      Math.max(0, ...genResampled.values, ...baseloadSeries, ...variableResampled.values, ...demandResampled.values)
    );
    const yUnit = scaledUnit("MW", yTier.idx);
    const y1Tier = unitTier(Math.max(batteryCapacityMWh, 0, ...socResampled.values));
    const y1Unit = scaledUnit("MWh", y1Tier.idx);

    chart.data.labels = demandResampled.labels;
    chart.data.datasets[0].data = genResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[0].label = `Wind generation (${yUnit})`;
    chart.data.datasets[1].data = baseloadSeries.map((v) => v / yTier.factor);
    chart.data.datasets[1].label = `Base generation (${yUnit})`;
    chart.data.datasets[2].data = variableResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[2].label = `Variable generation used (${yUnit})`;
    chart.data.datasets[3].data = demandResampled.values.map((v) => v / yTier.factor);
    chart.data.datasets[3].label = `Demand (${yUnit})`;
    chart.data.datasets[4].data = socResampled.values.map((v) => v / y1Tier.factor);
    chart.data.datasets[4].label = `Battery charge (${y1Unit})`;
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
      `where wind, base, variable generation, and battery discharge together fully cover demand. Batteries start the year fully charged.`;
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
