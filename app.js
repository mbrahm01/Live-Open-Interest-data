const fmt = n => Number(n).toLocaleString('en-IN');
const fmtL = n => {
  if (!n) return '0';
  const a = Math.abs(n);
  return a >= 1e7 ? (n / 1e7).toFixed(2) + 'Cr'
    : a >= 1e5 ? (n / 1e5).toFixed(2) + 'L'
    : fmt(n);
};

function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), ms);
}

let rawData = null;
let charts = {};
let expiry = '';
let topN = 30;
let sortOI = false;

const ARC = 56.55;
const arcEl = document.getElementById('arc');

function setRing(secondsLeft) {
  const frac = Math.max(0, Math.min(1, secondsLeft / 60));
  arcEl.setAttribute('stroke-dashoffset', (ARC * (1 - frac)).toFixed(2));
  document.getElementById('nextIn').textContent = secondsLeft > 0 ? secondsLeft + 's' : 'fetching…';
}

function parseOI(data, expiry, topN, sortOI) {
  const rec = data.records || {};
  const spot = rec.underlyingValue || 0;
  const rows = rec.data || [];

  const totCeFromAPI = (rec.CE || {}).totOI || 0;
  const totPeFromAPI = (rec.PE || {}).totOI || 0;

  const map = new Map();
  for (const row of rows) {
    const strike = row.strikePrice;
    if (!strike) continue;

    const ce = row.CE || {};
    const pe = row.PE || {};

    if (expiry) {
      const ceMatch = ce.expiryDate === expiry;
      const peMatch = pe.expiryDate === expiry;
      if (!ceMatch && !peMatch) continue;
    }

    const existing = map.get(strike) || { ceOI: 0, peOI: 0, ceChg: 0, peChg: 0 };
    map.set(strike, {
      ceOI: existing.ceOI + (ce.openInterest || 0),
      peOI: existing.peOI + (pe.openInterest || 0),
      ceChg: existing.ceChg + (ce.changeinOpenInterest || 0),
      peChg: existing.peChg + (pe.changeinOpenInterest || 0),
    });
  }

  let entries = [...map.entries()]
    .map(([strike, v]) => ({ strike, ...v }))
    .sort((a, b) => a.strike - b.strike);

  const atmIdx = entries.reduce((best, e, i) =>
    Math.abs(e.strike - spot) < Math.abs(entries[best].strike - spot) ? i : best, 0);
  const half = Math.floor(topN / 2);
  let lo = Math.max(0, atmIdx - half);
  let hi = Math.min(entries.length, lo + topN);
  lo = Math.max(0, hi - topN);
  entries = entries.slice(lo, hi);

  if (sortOI) entries.sort((a, b) => (b.ceOI + b.peOI) - (a.ceOI + a.peOI));

  const strikes = entries.map(e => e.strike);
  const ceOI = entries.map(e => e.ceOI);
  const peOI = entries.map(e => e.peOI);
  const ceChg = entries.map(e => e.ceChg);
  const peChg = entries.map(e => e.peChg);

  const totalCe = totCeFromAPI || ceOI.reduce((s, v) => s + v, 0);
  const totalPe = totPeFromAPI || peOI.reduce((s, v) => s + v, 0);
  const pcr = totalCe ? totalPe / totalCe : 0;

  const allStrikes = [...map.keys()].sort((a, b) => a - b);
  let minPain = Infinity;
  let maxPain = 0;
  for (const s of allStrikes) {
    let pain = 0;
    for (const [k, v] of map) {
      if (k <= s) pain += v.ceOI * (s - k);
      if (k >= s) pain += v.peOI * (k - s);
    }
    if (pain < minPain) {
      minPain = pain;
      maxPain = s;
    }
  }

  return { strikes, ceOI, peOI, ceChg, peChg, totalCe, totalPe, pcr, spot, maxPain };
}

function updateMetrics(p, exp) {
  document.getElementById('mSpot').textContent = fmt(p.spot);
  document.getElementById('mCeOi').textContent = fmtL(p.totalCe);
  document.getElementById('mPeOi').textContent = fmtL(p.totalPe);
  const pcrEl = document.getElementById('mPcr');
  pcrEl.textContent = p.pcr.toFixed(2);
  pcrEl.className = 'mv ' + (p.pcr >= 1 ? 'up' : 'dn');
  document.getElementById('mSent').textContent =
    p.pcr >= 1.2 ? 'Bullish 🐂' : p.pcr <= 0.8 ? 'Bearish 🐻' : 'Neutral';
  document.getElementById('mMP').textContent = fmt(p.maxPain);
  document.getElementById('mN').textContent = p.strikes.length;
  document.getElementById('mExp').textContent = exp || 'All expiries';
}

const GRID = 'rgba(48,54,61,0.5)';
const xTick = { color: '#8b949e', font: { size: 11 }, maxRotation: 90, autoSkip: true, maxTicksLimit: 30 };
const yTick = { color: '#8b949e', callback: v => fmtL(v) };
const tip = { callbacks: { title: c => 'Strike: ' + c[0].label, label: c => c.dataset.label + ': ' + fmt(c.raw) } };

function mkOI(p) {
  if (charts.oi) charts.oi.destroy();
  const atmIdx = p.strikes.reduce((b, s, i) => Math.abs(s - p.spot) < Math.abs(p.strikes[b] - p.spot) ? i : b, 0);
  charts.oi = new Chart(document.getElementById('oiC'), {
    type: 'bar',
    data: {
      labels: p.strikes,
      datasets: [
        {
          label: 'CE OI',
          data: p.ceOI,
          backgroundColor: p.strikes.map((_, i) => i === atmIdx ? '#f0e130' : '#3b82f6'),
          borderRadius: 3,
        },
        {
          label: 'PE OI',
          data: p.peOI,
          backgroundColor: p.strikes.map((_, i) => i === atmIdx ? '#f0e130' : '#ef4444'),
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tip },
      scales: { x: { ticks: xTick, grid: { color: GRID } }, y: { ticks: yTick, grid: { color: GRID } } },
    },
  });
}

function mkChg(p) {
  if (charts.chg) charts.chg.destroy();
  charts.chg = new Chart(document.getElementById('chgC'), {
    type: 'bar',
    data: {
      labels: p.strikes,
      datasets: [
        {
          label: 'CE ΔOI',
          data: p.ceChg,
          backgroundColor: p.ceChg.map(v => v >= 0 ? '#3b82f6' : 'rgba(59,130,246,0.3)'),
          borderRadius: 3,
        },
        {
          label: 'PE ΔOI',
          data: p.peChg,
          backgroundColor: p.peChg.map(v => v >= 0 ? '#ef4444' : 'rgba(239,68,68,0.3)'),
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tip },
      scales: { x: { ticks: xTick, grid: { color: GRID } }, y: { ticks: yTick, grid: { color: GRID } } },
    },
  });
}

function mkLine(p) {
  if (charts.line) charts.line.destroy();
  charts.line = new Chart(document.getElementById('lineC'), {
    type: 'line',
    data: {
      labels: p.strikes,
      datasets: [
        {
          label: 'CE OI',
          data: p.ceOI,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59,130,246,0.08)',
          tension: 0.35,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
        {
          label: 'PE OI',
          data: p.peOI,
          borderColor: '#ef4444',
          backgroundColor: 'rgba(239,68,68,0.08)',
          tension: 0.35,
          fill: true,
          pointRadius: 3,
          pointHoverRadius: 5,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: tip },
      scales: {
        x: { ticks: { ...xTick, maxRotation: 45, autoSkip: true, maxTicksLimit: 20 }, grid: { color: GRID } },
        y: { ticks: yTick, grid: { color: GRID } },
      },
    },
  });
}

function render() {
  if (!rawData) return;
  const p = parseOI(rawData, expiry, topN, sortOI);
  updateMetrics(p, expiry);
  mkOI(p);
  mkChg(p);
  mkLine(p);
}

function populateExpiry(data) {
  const sel = document.getElementById('expSel');
  const seen = new Set();
  for (const row of (data.records || {}).data || []) {
    if (row.CE && row.CE.expiryDate) seen.add(row.CE.expiryDate);
    if (row.PE && row.PE.expiryDate) seen.add(row.PE.expiryDate);
  }
  const dates = [...seen].sort();
  if (sel.options.length <= 1) {
    for (const d of dates) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    }
    if (dates.length && !expiry) {
      expiry = dates[0];
      sel.value = expiry;
    }
  }
}

function ingest(payload) {
  rawData = payload.data;
  populateExpiry(rawData);
  if (payload.fetched_at) document.getElementById('ts').textContent = '🕐 ' + payload.fetched_at;
  if (payload.next_in != null) setRing(payload.next_in);
  document.getElementById('splash').style.display = 'none';
  document.getElementById('main').style.display = 'block';
  render();
}

function connectSSE() {
  const dot = document.getElementById('dot');
  const st = document.getElementById('stTxt');
  dot.className = 'dot';
  st.textContent = 'Connecting…';
  const es = new EventSource('/api/stream');

  es.addEventListener('update', e => {
    const pl = JSON.parse(e.data);
    dot.className = 'dot live';
    st.textContent = 'Live';
    ingest(pl);
    toast('✓ Charts updated');
  });

  es.addEventListener('tick', e => {
    const pl = JSON.parse(e.data);
    setRing(pl.next_in);
  });

  es.addEventListener('error', e => {
    try { toast('⚠ ' + JSON.parse(e.data).error, 4000); } catch {}
  });

  es.onerror = () => {
    dot.className = 'dot err';
    st.textContent = 'Reconnecting…';
  };
}

connectSSE();

document.getElementById('expSel').addEventListener('change', e => {
  expiry = e.target.value;
  render();
});

const slider = document.getElementById('slider');
slider.addEventListener('input', () => {
  topN = parseInt(slider.value);
  document.getElementById('slVal').textContent = topN;
  render();
});

document.getElementById('btnOI').addEventListener('click', () => {
  sortOI = true;
  document.getElementById('btnOI').classList.add('on');
  document.getElementById('btnStrike').classList.remove('on');
  document.getElementById('btnOI').textContent = 'Sort: OI ✓';
  document.getElementById('btnStrike').textContent = 'Sort: Strike';
  render();
});

document.getElementById('btnStrike').addEventListener('click', () => {
  sortOI = false;
  document.getElementById('btnStrike').classList.add('on');
  document.getElementById('btnOI').classList.remove('on');
  document.getElementById('btnStrike').textContent = 'Sort: Strike ✓';
  document.getElementById('btnOI').textContent = 'Sort: OI';
  render();
});
