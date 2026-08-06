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
let mode = 'index';       // 'index' | 'stock' — driven by the toggle
let indexSymbol = '';     // e.g. NIFTY, BANKNIFTY — set from the index_list event
let stockSymbol = '';     // e.g. RELIANCE — set from the stock_list event
let topN = 30;
let marketOpen = true; // assume open until the market_status event says otherwise
let sortOI = false;

// Whichever symbol is currently active, regardless of mode — this is what
// gets shown in the metrics footer and is symbol-agnostic downstream.
function activeSymbol() {
    return mode === 'stock' ? stockSymbol : indexSymbol;
}

const ARC = 56.55;
const arcEl = document.getElementById('arc');

function setRing(secondsLeft) {
    const frac = Math.max(0, Math.min(1, secondsLeft / 60));
    arcEl.setAttribute('stroke-dashoffset', (ARC * (1 - frac)).toFixed(2));
    document.getElementById('nextIn').textContent = secondsLeft > 0 ? secondsLeft + 's' : 'fetching…';
}

// --- OI parsing / charting is entirely symbol-agnostic already: NSE returns
// the same {records:{data:[...], underlyingValue}} shape for both an index
// and a stock, so nothing below needs to know or care which mode is active. ---

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

function updateMetrics(p, exp, sym) {
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
    document.getElementById('mExp').textContent = [sym, exp].filter(Boolean).join(' · ') || 'All expiries';
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
    updateMetrics(p, expiry, activeSymbol());
    mkOI(p);
    mkChg(p);
    mkLine(p);
}

function ingest(payload) {
    rawData = payload.data;
    if (payload.fetched_at) document.getElementById('ts').textContent = '🕐 ' + payload.fetched_at;
    if (payload.next_in != null) setRing(payload.next_in);
    document.getElementById('splash').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    render();
}

// --- Toggle UI: show/hide the index vs stock selector, keep them mutually
// exclusive so only one control (and therefore one symbol) is ever "live". ---
function applyModeUI() {
    const idxWrap = document.getElementById('indexSelWrap');
    const stockWrap = document.getElementById('stockSelWrap');
    const toggleIdx = document.getElementById('toggleIndex');
    const toggleStk = document.getElementById('toggleStocks');
    if (idxWrap) idxWrap.style.display = mode === 'index' ? '' : 'none';
    if (stockWrap) stockWrap.style.display = mode === 'stock' ? '' : 'none';
    if (toggleIdx) toggleIdx.classList.toggle('on', mode === 'index');
    if (toggleStk) toggleStk.classList.toggle('on', mode === 'stock');
}

async function switchMode(newMode) {
    if (newMode === mode) return;
    document.getElementById('dot').className = 'dot';
    try {
        const res = await fetch('/select_mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: newMode }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
            toast('⚠ ' + (data.error || 'Failed to switch mode'), 4000);
            return;
        }
        mode = newMode;
        applyModeUI();
        // Don't render here — the server invalidates cached data on mode
        // switch and will broadcast a fresh expiry_list + update for the
        // newly active symbol; splash reappears via ingest() naturally if
        // there's a brief gap.
    } catch (err) {
        toast('⚠ Network error switching mode', 4000);
    }
}

function connectSSE() {
    const dot = document.getElementById('dot');
    const st = document.getElementById('stTxt');
    dot.className = 'dot';
    st.textContent = 'Connecting…';

    fetch('/api/whoami').then(res => res.json()).then(data => {
        if (!data.logged_in) {
            window.location.href = '/login';
            return;
        }
        startEventSource();
    }).catch(() => startEventSource());

    function startEventSource() {
        const es = new EventSource('/api/stream');

        es.addEventListener('update', e => {
            const pl = JSON.parse(e.data);
            if (marketOpen) {
                dot.className = 'dot live';
                st.textContent = 'Live';
            } else {
                dot.className = 'dot off';
                st.textContent = 'Markets Closed';
            }
            ingest(pl);
            toast(marketOpen ? '✓ Charts updated' : '✓ Loaded last available data');
        });

        es.addEventListener('tick', e => {
            const pl = JSON.parse(e.data);
            setRing(pl.next_in);
        });

        es.addEventListener('error', e => {
            try { toast('⚠ ' + JSON.parse(e.data).error, 4000); } catch { }
        });

        es.addEventListener('market_status', e => {
            const { open } = JSON.parse(e.data);
            marketOpen = open;
            if (open) {
                dot.className = 'dot live';
                st.textContent = 'Live';
            } else {
                dot.className = 'dot off';
                st.textContent = 'Markets Closed';
                document.getElementById('nextIn').textContent = '—';
            }
        });

        es.onerror = () => {
            dot.className = 'dot err';
            st.textContent = 'Reconnecting…';
        };

        es.addEventListener('mode', e => {
            const { mode: serverMode } = JSON.parse(e.data);
            mode = serverMode;
            applyModeUI();
        });

        es.addEventListener('expiry_list', (e) => {
            const { expiries, selected } = JSON.parse(e.data);
            const sel = document.getElementById('expSel');
            sel.innerHTML = '';
            expiries.forEach((exp) => {
                const opt = document.createElement('option');
                opt.value = exp;
                opt.textContent = exp;
                sel.appendChild(opt);
            });
            // Server is authoritative here — fires on startup AND whenever
            // the symbol/mode changes, so always follow its `selected`
            // value rather than only filling in when empty.
            expiry = selected || expiries[0] || '';
            sel.value = expiry;
            render();
        });

        es.addEventListener('index_list', (e) => {
            const { indexes, selected } = JSON.parse(e.data);
            const sel = document.getElementById('indexSel');
            if (!sel) return;
            sel.innerHTML = '';
            indexes.forEach((idx) => {
                const opt = document.createElement('option');
                opt.value = idx;
                opt.textContent = idx;
                sel.appendChild(opt);
            });
            indexSymbol = selected || indexes[0] || '';
            sel.value = indexSymbol;
        });

        es.addEventListener('stock_list', (e) => {
            const { stocks, selected } = JSON.parse(e.data);
            const sel = document.getElementById('stockSel');
            if (!sel) return;
            sel.innerHTML = '<option value="">Select a stock…</option>';
            // stocks is {SYMBOL: "Full Company Name"} — dropdown shows both,
            // value sent to the backend is just the ticker symbol.
            Object.entries(stocks).forEach(([sym, name]) => {
                const opt = document.createElement('option');
                opt.value = sym;
                opt.textContent = `${sym} - ${name}`;
                sel.appendChild(opt);
            });
            if (selected) {
                stockSymbol = selected;
                sel.value = selected;
            }
        });
    }
}

connectSSE();

document.getElementById('toggleIndex')?.addEventListener('click', () => switchMode('index'));
document.getElementById('toggleStocks')?.addEventListener('click', () => switchMode('stock'));

const indexSelEl = document.getElementById('indexSel');
if (indexSelEl) {
  indexSelEl.addEventListener('change', async (e) => {
    const newIndex = e.target.value;
    document.getElementById('dot').className = 'dot';
    try {
      const res = await fetch('/select_index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: newIndex }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        toast('⚠ ' + (data.error || 'Failed to switch index'), 4000);
        e.target.value = indexSymbol;
        return;
      }
      indexSymbol = newIndex;
      // don't render here — the server will broadcast a fresh expiry_list
      // followed by an update event for the new index
    } catch (err) {
      toast('⚠ Network error switching index', 4000);
      e.target.value = indexSymbol;
    }
  });
}

const stockSelEl = document.getElementById('stockSel');
if (stockSelEl) {
  stockSelEl.addEventListener('change', async (e) => {
    const newStock = e.target.value;
    if (!newStock) return;
    document.getElementById('dot').className = 'dot';
    try {
      const res = await fetch('/select_stock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: newStock }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        // Covers both "not in our static STOCK_LIST" (400 from server) and
        // symbols NSE itself no longer treats as F&O-active (empty option
        // chain → nse.fetch_once returns None → poller keeps broadcasting
        // the last error), so either way the user sees why nothing loaded.
        toast('⚠ ' + (data.error || 'Failed to switch stock — it may not have an active option chain'), 4500);
        e.target.value = stockSymbol;
        return;
      }
      stockSymbol = newStock;
    } catch (err) {
      toast('⚠ Network error switching stock', 4000);
      e.target.value = stockSymbol;
    }
  });
}

document.getElementById('expSel').addEventListener('change', async (e) => {
  const newExpiry = e.target.value;
  document.getElementById('dot').className = 'dot';
  try {
    const res = await fetch('/select_expiry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiry: newExpiry }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      toast('⚠ ' + (data.error || 'Failed to switch expiry'), 4000);
      e.target.value = expiry;
      return;
    }
    expiry = newExpiry;
  } catch (err) {
    toast('⚠ Network error switching expiry', 4000);
    e.target.value = expiry;
  }
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

const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
        await fetch('/logout', { method: 'POST' });
        window.location.href = '/login';
    });
}

applyModeUI();