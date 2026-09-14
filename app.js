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

function runSimulation(windSpeed, demandMW, windCapacityMW, batteryCapacityMWh) {
  let soc = 0;
  let unmetHours = 0;
  const totalHours = windSpeed.length;

  for (let i = 0; i < totalHours; i++) {
    const generation = windCapacityMW * windCapacityFactor(windSpeed[i]);
    const net = generation - demandMW[i]; // MW over a 1-hour step == MWh
    if (net >= 0) {
      soc = Math.min(batteryCapacityMWh, soc + net);
    } else {
      const deficit = -net;
      if (soc >= deficit) {
        soc -= deficit;
      } else {
        soc = 0;
        unmetHours++;
      }
    }
  }

  return 1 - unmetHours / totalHours;
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

  const capacityFactors = wind.windSpeed100m.map(windCapacityFactor);
  const capacityFactorDaily = dailyAverage(wind.time, capacityFactors);
  const demandDaily = dailyAverage(demand.time, demand.demandMW);

  const windCapacityInput = document.getElementById("windCapacity");
  const batteryCapacityInput = document.getElementById("batteryCapacity");
  const windCapacityValue = document.getElementById("windCapacityValue");
  const batteryCapacityValue = document.getElementById("batteryCapacityValue");
  const probabilityEl = document.getElementById("probability");

  const chart = new Chart(document.getElementById("combinedChart"), {
    type: "line",
    data: {
      labels: demandDaily.labels,
      datasets: [
        {
          label: "Wind generation (MW)",
          data: capacityFactorDaily.means.map((cf) => cf * Number(windCapacityInput.value)),
          borderColor: "#2b7a78",
          pointRadius: 0,
          borderWidth: 1.5,
        },
        {
          label: "Demand (MW)",
          data: demandDaily.means,
          borderColor: "#c44536",
          pointRadius: 0,
          borderWidth: 1.5,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 12 } },
        y: { title: { display: true, text: "MW" } },
      },
    },
  });

  function update() {
    const windCapacityMW = Number(windCapacityInput.value);
    const batteryCapacityMWh = Number(batteryCapacityInput.value);
    windCapacityValue.textContent = windCapacityMW.toLocaleString();
    batteryCapacityValue.textContent = batteryCapacityMWh.toLocaleString();

    chart.data.datasets[0].data = capacityFactorDaily.means.map((cf) => cf * windCapacityMW);
    chart.update("none");

    const probability = runSimulation(
      wind.windSpeed100m,
      demand.demandMW,
      windCapacityMW,
      batteryCapacityMWh
    );
    probabilityEl.textContent = `${(probability * 100).toFixed(1)}%`;
  }

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
