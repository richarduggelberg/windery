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

function runSimulation(windSpeed, demandMW, windCapacityMW, batteryCapacityMWh) {
  const totalHours = windSpeed.length;
  const generationMW = new Array(totalHours);
  const socMWh = new Array(totalHours);
  const unmet = new Uint8Array(totalHours);
  let soc = batteryCapacityMWh; // batteries start fully charged

  for (let i = 0; i < totalHours; i++) {
    const generation = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const demand = demandMW[i];
    const net = generation - demand; // MW over a 1-hour step == MWh
    if (net >= 0) {
      const chargeRoom = batteryCapacityMWh - soc;
      soc += Math.min(net, chargeRoom);
    } else {
      const deficit = -net;
      const discharge = Math.min(deficit, soc);
      soc -= discharge;
      if (generation + discharge < demand) unmet[i] = 1;
    }
    generationMW[i] = generation;
    socMWh[i] = soc;
  }

  return { generationMW, socMWh, unmet };
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
  const windCapacityInput = document.getElementById("windCapacity");
  const batteryCapacityInput = document.getElementById("batteryCapacity");
  const windCapacityValue = document.getElementById("windCapacityValue");
  const batteryCapacityValue = document.getElementById("batteryCapacityValue");
  const probabilityEl = document.getElementById("probability");
  const probabilityNoteEl = document.getElementById("probabilityNote");

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
    const windCapacityMW = Number(windCapacityInput.value);
    const batteryCapacityMWh = Number(batteryCapacityInput.value);
    const period = periodInput.value;
    windCapacityValue.textContent = windCapacityMW.toLocaleString();
    batteryCapacityValue.textContent = batteryCapacityMWh.toLocaleString();

    // Always simulate the full year so battery state of charge carries over correctly,
    // then slice down to the selected window for display and the probability figure.
    const { generationMW, socMWh, unmet } = runSimulation(
      wind.windSpeed100m,
      demand.demandMW,
      windCapacityMW,
      batteryCapacityMWh
    );

    const [start, end] = periodIndexRange(wind.time, period);

    const genResampled = resample(wind.time, generationMW, period, start, end);
    const socResampled = resample(wind.time, socMWh, period, start, end);
    const demandResampled = resample(demand.time, demand.demandMW, period, start, end);

    chart.data.labels = demandResampled.labels;
    chart.data.datasets[0].data = genResampled.values;
    chart.data.datasets[1].data = demandResampled.values;
    chart.data.datasets[2].data = socResampled.values;
    chart.options.scales.y1.max = batteryCapacityMWh;
    chart.update("none");

    const windowHours = end - start;
    const unmetHours = unmet.slice(start, end).reduce((a, b) => a + b, 0);
    const probability = 1 - unmetHours / windowHours;
    probabilityEl.textContent = `${(probability * 100).toFixed(1)}%`;
    probabilityNoteEl.textContent =
      `Share of the ${windowHours.toLocaleString()} hourly intervals ${PERIODS[period].preposition} ${PERIODS[period].label} ` +
      `where wind generation plus battery discharge fully covers demand. Batteries start the year fully charged.`;
  }

  periodInput.addEventListener("change", update);
  windCapacityInput.addEventListener("input", update);
  batteryCapacityInput.addEventListener("input", update);
  update();
}

main().catch((err) => {
  console.error(err);
  document.querySelector("main").insertAdjacentHTML(
    "afterbegin",
    `<p class="error">Failed to load simulation data: ${err.message}</p>`
  );
});
