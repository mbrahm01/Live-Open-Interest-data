// ================== STRATEGY BUILDER + PAPER TRADING ==================
// Self-contained module. Reads the option chain that app.js already has in
// memory (via window.onStrategyDataUpdate, called from ingest()/render())
// so no extra network calls are needed for the builder itself. Saved paper
// trades are persisted server-side via /api/paper/*.
(function () {
  let legs = [];
  let legIdCounter = 1;
  let payoffChart = null;
  let currentChain = { spot: 0, strikesList: [], byStrike: {} };
  let lastSymbol = '';
  let currentSymbol = '';
  let trades = [];

  // Best-effort defaults; user can always override the Lot size field.
  const LOT_SIZE_DEFAULTS = { NIFTY: 75, BANKNIFTY: 35, FINNIFTY: 65 };

  // ---------- Chain indexing ----------
  function buildChainIndex(rawData) {
    const rec = (rawData && rawData.records) || {};
    const spot = rec.underlyingValue || 0;
    const rows = rec.data || [];
    const byStrike = {};
    const strikesSet = new Set();
    for (const row of rows) {
      const k = row.strikePrice;
      if (!k) continue;
      strikesSet.add(k);
      const ce = row.CE || {};
      const pe = row.PE || {};
      const existing = byStrike[k] || {};
      byStrike[k] = {
        ceLTP: ce.lastPrice != null ? ce.lastPrice : existing.ceLTP,
        peLTP: pe.lastPrice != null ? pe.lastPrice : existing.peLTP,
      };
    }
    return { spot, strikesList: [...strikesSet].sort((a, b) => a - b), byStrike };
  }

  function nearestATM() {
    if (!currentChain.strikesList.length) return 0;
    return currentChain.strikesList.reduce((best, k) =>
      Math.abs(k - currentChain.spot) < Math.abs(best - currentChain.spot) ? k : best,
      currentChain.strikesList[0]);
  }

  function ltpFor(strike, optType) {
    const row = currentChain.byStrike[strike];
    if (!row) return null;
    const v = optType === 'CE' ? row.ceLTP : row.peLTP;
    return v != null ? v : null;
  }

  function currentExpiry() {
    const sel = document.getElementById('expSel');
    return sel ? sel.value : '';
  }

  // Called by app.js on every fresh SSE update, so the strike list / LTPs
  // (and hence live premium suggestions and paper-trade marks) always track
  // the current chain.
  window.onStrategyDataUpdate = function (rawData, symbol) {
    currentChain = buildChainIndex(rawData);
    currentSymbol = symbol || currentSymbol;
    if (symbol && symbol !== lastSymbol) {
      lastSymbol = symbol;
      const lotInput = document.getElementById('sbLotSize');
      if (lotInput && !lotInput.dataset.userEdited) {
        lotInput.value = LOT_SIZE_DEFAULTS[symbol] || 1;
      }
    }
    refreshStrikeDropdowns();
    if (legs.length) computeAndRender();
    renderTrades(); // re-mark open paper trades against the new LTPs
  };

  function refreshStrikeDropdowns() {
    document.querySelectorAll('.sbStrikeSel').forEach(sel => {
      const cur = Number(sel.value);
      sel.innerHTML = '';
      currentChain.strikesList.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        sel.appendChild(opt);
      });
      if (currentChain.strikesList.includes(cur)) sel.value = cur;
    });
  }

  // ---------- Leg CRUD ----------
  function addLeg(preset) {
    preset = preset || {};
    const id = legIdCounter++;
    const strike = preset.strike != null ? preset.strike : nearestATM();
    const optType = preset.optType || 'CE';
    const ltp = ltpFor(strike, optType);
    legs.push({
      id,
      side: preset.side || 'BUY',
      optType,
      strike,
      premium: preset.premium != null ? preset.premium : (ltp != null ? ltp : 0),
      lots: preset.lots || 1,
    });
    renderLegs();
  }

  function clearLegs() {
    legs = [];
    renderLegs();
  }

  function renderLegs() {
    const wrap = document.getElementById('sbLegs');
    if (!wrap) return;
    if (!legs.length) {
      wrap.innerHTML = '<div class="sb-empty">No legs yet — add one or use a preset below.</div>';
      renderStats(null);
      clearChartArea();
      return;
    }
    wrap.innerHTML = '';
    legs.forEach(leg => {
      const row = document.createElement('div');
      row.className = 'sb-leg-row';
      row.innerHTML =
        '<select class="sbSide" data-id="' + leg.id + '">' +
          '<option value="BUY"' + (leg.side === 'BUY' ? ' selected' : '') + '>Buy</option>' +
          '<option value="SELL"' + (leg.side === 'SELL' ? ' selected' : '') + '>Sell</option>' +
        '</select>' +
        '<select class="sbOptType" data-id="' + leg.id + '">' +
          '<option value="CE"' + (leg.optType === 'CE' ? ' selected' : '') + '>Call</option>' +
          '<option value="PE"' + (leg.optType === 'PE' ? ' selected' : '') + '>Put</option>' +
        '</select>' +
        '<select class="sbStrikeSel" data-id="' + leg.id + '"></select>' +
        '<input class="sbPremium" data-id="' + leg.id + '" type="number" step="0.05" value="' + leg.premium + '" title="Premium" />' +
        '<input class="sbLots" data-id="' + leg.id + '" type="number" min="1" step="1" value="' + leg.lots + '" title="Lots" />' +
        '<button class="sb-remove" data-id="' + leg.id + '" title="Remove leg">✕</button>';
      wrap.appendChild(row);
      const strikeSel = row.querySelector('.sbStrikeSel');
      currentChain.strikesList.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = k;
        if (k === leg.strike) opt.selected = true;
        strikeSel.appendChild(opt);
      });
      // A leg whose strike isn't in the current chain (expiry or symbol
      // changed since it was added) would otherwise silently display some
      // other strike while the maths still used the original one.
      if (!currentChain.strikesList.includes(leg.strike)) {
        const opt = document.createElement('option');
        opt.value = leg.strike;
        opt.textContent = leg.strike + ' (off-chain)';
        opt.selected = true;
        strikeSel.appendChild(opt);
      }
    });
    wireLegEvents();
    computeAndRender();
  }

  function wireLegEvents() {
    document.querySelectorAll('.sbSide').forEach(el => el.onchange = e => {
      findLeg(e.target.dataset.id).side = e.target.value;
      computeAndRender();
    });
    document.querySelectorAll('.sbOptType').forEach(el => el.onchange = e => {
      const leg = findLeg(e.target.dataset.id);
      leg.optType = e.target.value;
      const ltp = ltpFor(leg.strike, leg.optType);
      if (ltp != null) leg.premium = ltp;
      renderLegs();
    });
    document.querySelectorAll('.sbStrikeSel').forEach(el => el.onchange = e => {
      const leg = findLeg(e.target.dataset.id);
      leg.strike = Number(e.target.value);
      const ltp = ltpFor(leg.strike, leg.optType);
      if (ltp != null) leg.premium = ltp;
      renderLegs();
    });
    document.querySelectorAll('.sbPremium').forEach(el => el.oninput = e => {
      findLeg(e.target.dataset.id).premium = parseFloat(e.target.value) || 0;
      computeAndRender();
    });
    document.querySelectorAll('.sbLots').forEach(el => el.oninput = e => {
      findLeg(e.target.dataset.id).lots = Math.max(1, parseInt(e.target.value) || 1);
      computeAndRender();
    });
    document.querySelectorAll('.sb-remove').forEach(el => el.onclick = e => {
      legs = legs.filter(l => l.id !== Number(e.target.dataset.id));
      renderLegs();
    });
  }

  function findLeg(id) {
    return legs.find(l => l.id == id);
  }

  // ---------- Presets ----------
  function stepAway(k, steps) {
    if (!currentChain.strikesList.length) return k;
    const idx = currentChain.strikesList.indexOf(k);
    const target = Math.min(currentChain.strikesList.length - 1, Math.max(0, idx + steps));
    return currentChain.strikesList[target];
  }

  const PRESETS = {
    long_straddle: () => {
      const atm = nearestATM();
      clearLegs();
      addLeg({ side: 'BUY', optType: 'CE', strike: atm });
      addLeg({ side: 'BUY', optType: 'PE', strike: atm });
    },
    long_strangle: () => {
      const atm = nearestATM();
      clearLegs();
      addLeg({ side: 'BUY', optType: 'CE', strike: stepAway(atm, 2) });
      addLeg({ side: 'BUY', optType: 'PE', strike: stepAway(atm, -2) });
    },
    bull_call_spread: () => {
      const atm = nearestATM();
      clearLegs();
      addLeg({ side: 'BUY', optType: 'CE', strike: atm });
      addLeg({ side: 'SELL', optType: 'CE', strike: stepAway(atm, 2) });
    },
    bear_put_spread: () => {
      const atm = nearestATM();
      clearLegs();
      addLeg({ side: 'BUY', optType: 'PE', strike: atm });
      addLeg({ side: 'SELL', optType: 'PE', strike: stepAway(atm, -2) });
    },
    iron_condor: () => {
      const atm = nearestATM();
      clearLegs();
      addLeg({ side: 'SELL', optType: 'CE', strike: stepAway(atm, 2) });
      addLeg({ side: 'BUY', optType: 'CE', strike: stepAway(atm, 4) });
      addLeg({ side: 'SELL', optType: 'PE', strike: stepAway(atm, -2) });
      addLeg({ side: 'BUY', optType: 'PE', strike: stepAway(atm, -4) });
    },
  };

  // ---------- Payoff math ----------
  function payoffAt(S, lotSize) {
    let total = 0;
    for (const leg of legs) {
      const qty = leg.lots * lotSize;
      const sign = leg.side === 'BUY' ? 1 : -1;
      const intrinsic = leg.optType === 'CE'
        ? Math.max(S - leg.strike, 0)
        : Math.max(leg.strike - S, 0);
      total += sign * (intrinsic - leg.premium) * qty;
    }
    return total;
  }

  // Slope of total payoff as S -> +infinity. Only calls matter there
  // (every put's intrinsic value is flat 0 once S is above all strikes).
  // A non-zero value means the profit/loss on that side is genuinely
  // unbounded — unlike the downside, which is always capped by S >= 0.
  function highSlope(lotSize) {
    let s = 0;
    for (const leg of legs) {
      if (leg.optType !== 'CE') continue;
      const sign = leg.side === 'BUY' ? 1 : -1;
      s += sign * leg.lots * lotSize;
    }
    return s;
  }

  function readLotSize() {
    const el = document.getElementById('sbLotSize');
    const v = el ? parseInt(el.value, 10) : NaN;
    return Number.isFinite(v) && v > 0 ? v : 1;
  }

  function computePayoff() {
    const lotSize = readLotSize();
    const spotRaw = Number(currentChain.spot);
    const spot = Number.isFinite(spotRaw) && spotRaw > 0 ? spotRaw : Number(legs[0].strike);

    // The payoff function is exactly piecewise-linear with kinks only at
    // each leg's strike, so evaluating it AT the strikes gives an exact
    // polyline rather than a sampled approximation.
    const strikes = [...new Set(legs.map(l => Number(l.strike)))]
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (!strikes.length || !Number.isFinite(spot)) return null;

    const minK = strikes[0], maxK = strikes[strikes.length - 1];
    const pad = Math.max((maxK - minK) * 0.6, spot * 0.08, 50);
    let lo = Math.max(0, Math.min(minK - pad, spot - pad * 0.3));
    let hi = Math.max(maxK + pad, spot + pad * 0.3);
    if (!(hi > lo)) { lo = Math.max(0, minK - 100); hi = maxK + 100; }

    const xs = [lo, ...strikes, hi];
    const ys = xs.map(S => Math.round(payoffAt(S, lotSize) * 100) / 100);
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;

    const slopeHigh = highSlope(lotSize);
    const zeroBound = payoffAt(0, lotSize); // true worst/best case as S -> 0
    const maxProfit = slopeHigh > 0 ? Infinity : Math.max(Math.max(...ys), zeroBound);
    const maxLoss = slopeHigh < 0 ? -Infinity : Math.min(Math.min(...ys), zeroBound);

    // Breakevens: exact, since each segment between consecutive kinks is
    // genuinely linear.
    const breakevens = [];
    for (let i = 1; i < ys.length; i++) {
      const y0 = ys[i - 1], y1 = ys[i];
      if ((y0 < 0 && y1 >= 0) || (y0 > 0 && y1 <= 0)) {
        const x0 = xs[i - 1], x1 = xs[i];
        const frac = y0 === y1 ? 0 : -y0 / (y1 - y0);
        const be = x0 + frac * (x1 - x0);
        if (Number.isFinite(be)) breakevens.push(Math.round(be * 100) / 100);
      }
    }

    const netPremium = legs.reduce((sum, leg) => {
      const sign = leg.side === 'BUY' ? -1 : 1; // paid = negative, received = positive
      return sum + sign * leg.premium * leg.lots * lotSize;
    }, 0);

    return { xs, ys, spot, lotSize, maxProfit, maxLoss, breakevens, netPremium };
  }

  function fmtMoney(v) {
    if (v === Infinity || v === -Infinity) return 'Unlimited';
    if (!Number.isFinite(v)) return '—';
    return (v >= 0 ? '+₹' : '-₹') + Math.abs(Math.round(v)).toLocaleString('en-IN');
  }

  function renderStats(res) {
    const el = document.getElementById('sbStats');
    if (!el) return;
    if (!res) { el.innerHTML = ''; return; }
    const beText = res.breakevens.length
      ? res.breakevens.map(b => b.toLocaleString('en-IN')).join(', ')
      : '—';
    el.innerHTML =
      '<div class="mc"><div class="ml">Max profit</div><div class="mv up">' + fmtMoney(res.maxProfit) + '</div></div>' +
      '<div class="mc"><div class="ml">Max loss</div><div class="mv dn">' + fmtMoney(res.maxLoss) + '</div></div>' +
      '<div class="mc"><div class="ml">Breakeven</div><div class="mv">' + beText + '</div></div>' +
      '<div class="mc"><div class="ml">Net premium</div><div class="mv">' + fmtMoney(res.netPremium) +
        '</div><div class="ms">' + (res.netPremium >= 0 ? 'credit received' : 'debit paid') + '</div></div>';
  }

  // ---------- Chart rendering ----------
  // Every render tears down the old chart AND replaces the canvas node.
  // Reusing one canvas across many re-renders is the usual reason a chart
  // stops drawing after live data refreshes: Chart.js keeps sizing/context
  // state and resize listeners bound to that node, so any instance that
  // didn't unbind cleanly can leave the canvas in a state where later
  // charts draw nothing. A fresh node each render makes this idempotent.
  function destroyChart() {
    if (payoffChart) {
      try { payoffChart.destroy(); } catch (e) { /* already disposed */ }
      payoffChart = null;
    }
  }

  function clearChartArea() {
    destroyChart();
    const wrap = document.getElementById('sbChartWrap');
    if (wrap) wrap.querySelectorAll('canvas, .sb-chart-error').forEach(n => n.remove());
  }

  function freshCanvas(wrap) {
    wrap.querySelectorAll('canvas').forEach(c => c.remove());
    const c = document.createElement('canvas');
    c.id = 'sbChart';
    c.setAttribute('role', 'img');
    c.setAttribute('aria-label', 'Strategy payoff chart at expiry');
    wrap.appendChild(c);
    return c;
  }

  function renderChart(res) {
    const wrap = document.getElementById('sbChartWrap');
    if (!wrap) return;
    destroyChart();
    const old = wrap.querySelector('.sb-chart-error');
    if (old) old.remove();

    if (!res) {
      showChartError(wrap, new Error('payoff could not be computed for these legs'));
      return;
    }
    try {
      buildChart(freshCanvas(wrap), res);
    } catch (e) {
      console.error('[strategy builder] payoff chart failed to render:', e);
      showChartError(wrap, e);
    }
  }

  function showChartError(wrap, err) {
    const box = document.createElement('div');
    box.className = 'sb-chart-error';
    box.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;' +
      'justify-content:center;color:#ef4444;font-size:12px;text-align:center;padding:16px;';
    box.textContent = 'Chart failed to render: ' + (err && err.message ? err.message : String(err)) +
      ' — see browser console for details.';
    wrap.appendChild(box);
  }

  function dashed(label, data, color, dash) {
    return { label, data, borderColor: color, borderWidth: 1.5, borderDash: dash,
             pointRadius: 0, fill: false, tension: 0 };
  }

  function buildChart(canvas, res) {
    const spotY = payoffAt(res.spot, res.lotSize);
    const bePoints = res.breakevens.map(b => ({ x: b, y: 0 }));
    const xMin = res.xs[0], xMax = res.xs[res.xs.length - 1];
    const yMin = Math.min(...res.ys, 0);
    const yMax = Math.max(...res.ys, 0);
    const pad = Math.max(1, (yMax - yMin) * 0.1);
    const yLo = yMin - pad, yHi = yMax + pad;

    // options.parsing is false below, so EVERY dataset must supply explicit
    // {x, y} point objects — a plain array of numbers breaks the whole chart.
    const mainLine = res.xs.map((x, i) => ({ x, y: res.ys[i] }));

    const refs = [];
    if (res.maxProfit !== Infinity) {
      refs.push(dashed('Max profit line',
        [{ x: xMin, y: res.maxProfit }, { x: xMax, y: res.maxProfit }], '#22c55e', [6, 4]));
    }
    if (res.maxLoss !== -Infinity) {
      refs.push(dashed('Max loss line',
        [{ x: xMin, y: res.maxLoss }, { x: xMax, y: res.maxLoss }], '#ef4444', [6, 4]));
    }
    res.breakevens.forEach(b => {
      refs.push(dashed('Breakeven line', [{ x: b, y: yLo }, { x: b, y: yHi }], '#58a6ff', [3, 4]));
    });

    payoffChart = new Chart(canvas, {
      type: 'line',
      data: {
        datasets: [
          { label: 'P&L at expiry', data: mainLine, borderColor: '#ef4444',
            borderWidth: 2.5, pointRadius: 0, tension: 0, fill: false },
          dashed('Zero', [{ x: xMin, y: 0 }, { x: xMax, y: 0 }], 'rgba(230,237,243,0.55)', []),
          dashed('Axis', [{ x: xMin, y: yLo }, { x: xMin, y: yHi }], 'rgba(230,237,243,0.55)', []),
          ...refs,
          { label: 'Current spot', type: 'scatter', data: [{ x: res.spot, y: spotY }],
            backgroundColor: '#f0e130', pointStyle: 'rectRot', pointRadius: 6, pointHoverRadius: 7 },
          { label: 'Breakeven', type: 'scatter', data: bePoints,
            backgroundColor: '#58a6ff', pointStyle: 'triangle', pointRadius: 5, pointHoverRadius: 6 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        parsing: false,
        interaction: { mode: 'nearest', intersect: false },
        layout: { padding: { top: 10, bottom: 10 } },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: item => ['P&L at expiry', 'Current spot', 'Breakeven'].includes(item.dataset.label),
            callbacks: {
              title: items => 'Spot: ' + Number(items[0].parsed.x).toLocaleString('en-IN'),
              label: ctx => (ctx.dataset.label === 'P&L at expiry' ? 'P&L' : ctx.dataset.label) +
                ': ' + fmtMoney(ctx.parsed.y),
            },
          },
        },
        scales: {
          x: { type: 'linear', min: xMin, max: xMax,
               ticks: { color: '#8b949e', font: { size: 11 } },
               grid: { display: false }, border: { display: false },
               title: { display: true, text: 'Underlying spot at expiry', color: '#8b949e' } },
          y: { min: yLo, max: yHi,
               ticks: { color: '#8b949e', callback: v => fmtMoney(v) },
               grid: { display: false }, border: { display: false } },
        },
      },
    });
  }

  function computeAndRender() {
    if (!legs.length) {
      renderStats(null);
      clearChartArea();
      return;
    }
    const res = computePayoff();
    renderStats(res);
    renderChart(res);
  }

  // ================== PAPER TRADING ==================
  // A saved trade freezes its entry premiums. Live P&L marks those legs
  // against the current chain's LTPs — only meaningful while the loaded
  // symbol and expiry match what the trade was booked on, so anything else
  // shows "not loaded" rather than a misleading number.
  function legsSignature(t) {
    return t.legs.map(l =>
      (l.side === 'BUY' ? '+' : '-') + l.lots + 'x' + l.strike + l.optType).join('  ');
  }

  function markToMarket(trade) {
    if (trade.symbol !== currentSymbol || trade.expiry !== currentExpiry()) return null;
    let current = 0;
    for (const leg of trade.legs) {
      const ltp = ltpFor(leg.strike, leg.optType);
      if (ltp == null) return null; // strike no longer quoted — don't fake a mark
      const sign = leg.side === 'BUY' ? 1 : -1;
      current += sign * ltp * leg.lots * trade.lotSize;
    }
    const entry = trade.legs.reduce((s, leg) => {
      const sign = leg.side === 'BUY' ? 1 : -1;
      return s + sign * leg.premium * leg.lots * trade.lotSize;
    }, 0);
    return current - entry;
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts || {}));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  async function loadTrades() {
    try {
      const data = await api('/api/paper/trades');
      trades = data.trades || [];
      renderTrades();
    } catch (e) {
      console.error('[paper] failed to load trades:', e);
    }
  }

  async function saveCurrentStrategy() {
    if (!legs.length) { toast('Add at least one leg first.'); return; }
    const nameInput = document.getElementById('sbTradeName');
    const name = (nameInput && nameInput.value.trim()) || 'Untitled strategy';
    const payload = {
      name,
      symbol: currentSymbol,
      expiry: currentExpiry(),
      lotSize: readLotSize(),
      spotAtEntry: currentChain.spot || null,
      legs: legs.map(l => ({ side: l.side, optType: l.optType, strike: l.strike,
                             premium: l.premium, lots: l.lots })),
    };
    try {
      await api('/api/paper/trades', { method: 'POST', body: JSON.stringify(payload) });
      if (nameInput) nameInput.value = '';
      toast('Strategy saved to paper trades.');
      loadTrades();
    } catch (e) {
      console.error('[paper] save failed:', e);
      toast('Could not save strategy.');
    }
  }

  async function closeTrade(id) {
    const trade = trades.find(t => t.id === id);
    const pnl = trade ? markToMarket(trade) : null;
    if (pnl == null) {
      toast('Load this trade\u2019s symbol and expiry to close it at a live price.');
      return;
    }
    try {
      await api('/api/paper/trades/' + id + '/close', {
        method: 'POST',
        body: JSON.stringify({ pnl, spotAtExit: currentChain.spot || null }),
      });
      loadTrades();
    } catch (e) {
      console.error('[paper] close failed:', e);
      toast('Could not close trade.');
    }
  }

  async function deleteTrade(id) {
    try {
      await api('/api/paper/trades/' + id, { method: 'DELETE' });
      loadTrades();
    } catch (e) {
      console.error('[paper] delete failed:', e);
      toast('Could not delete trade.');
    }
  }

  function loadTradeIntoBuilder(id) {
    const t = trades.find(x => x.id === id);
    if (!t) return;
    legs = t.legs.map(l => ({ id: legIdCounter++, side: l.side, optType: l.optType,
                              strike: l.strike, premium: l.premium, lots: l.lots }));
    const lotInput = document.getElementById('sbLotSize');
    if (lotInput) { lotInput.value = t.lotSize; lotInput.dataset.userEdited = '1'; }
    renderLegs();
    const wrap = document.getElementById('sbChartWrap');
    if (wrap) wrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function renderTrades() {
    const wrap = document.getElementById('sbTrades');
    if (!wrap) return;
    if (!trades.length) {
      wrap.innerHTML = '<div class="sb-empty">No saved strategies yet. Build one above and hit “Save strategy”.</div>';
      renderPaperSummary();
      return;
    }
    let html = '<table class="sb-table"><thead><tr>' +
      '<th>Strategy</th><th>Symbol</th><th>Expiry</th><th>Legs</th>' +
      '<th>Booked</th><th>P&amp;L</th><th>Status</th><th></th></tr></thead><tbody>';
    trades.forEach(t => {
      const live = t.status === 'open' ? markToMarket(t) : t.closedPnl;
      const cls = live == null ? '' : (live >= 0 ? 'up' : 'dn');
      const pnlText = live == null ? '<span class="sb-dim">not loaded</span>' : fmtMoney(live);
      html += '<tr>' +
        '<td>' + escapeHtml(t.name) + '</td>' +
        '<td>' + escapeHtml(t.symbol || '—') + '</td>' +
        '<td>' + escapeHtml(t.expiry || '—') + '</td>' +
        '<td class="sb-dim sb-legs">' + escapeHtml(legsSignature(t)) + '</td>' +
        '<td class="sb-dim">' + escapeHtml(t.createdAt || '') + '</td>' +
        '<td class="' + cls + '">' + pnlText + '</td>' +
        '<td>' + (t.status === 'open'
          ? '<span class="sb-pill open">Open</span>'
          : '<span class="sb-pill closed">Closed</span>') + '</td>' +
        '<td class="sb-actions">' +
          '<button class="sb-mini" data-act="load" data-id="' + t.id + '">Load</button>' +
          (t.status === 'open'
            ? '<button class="sb-mini" data-act="close" data-id="' + t.id + '">Close</button>' : '') +
          '<button class="sb-mini danger" data-act="del" data-id="' + t.id + '">✕</button>' +
        '</td></tr>';
    });
    wrap.innerHTML = html + '</tbody></table>';

    wrap.querySelectorAll('.sb-mini').forEach(btn => {
      btn.onclick = () => {
        const id = btn.dataset.id;
        if (btn.dataset.act === 'load') loadTradeIntoBuilder(id);
        else if (btn.dataset.act === 'close') closeTrade(id);
        else if (btn.dataset.act === 'del') deleteTrade(id);
      };
    });
    renderPaperSummary();
  }

  function renderPaperSummary() {
    const el = document.getElementById('sbPaperSummary');
    if (!el) return;
    const open = trades.filter(t => t.status === 'open');
    const closed = trades.filter(t => t.status !== 'open');
    let openPnl = 0, marked = 0;
    open.forEach(t => {
      const v = markToMarket(t);
      if (v != null) { openPnl += v; marked++; }
    });
    const realised = closed.reduce((s, t) => s + (t.closedPnl || 0), 0);
    el.innerHTML =
      '<div class="mc"><div class="ml">Open positions</div><div class="mv">' + open.length +
        '</div><div class="ms">' + marked + ' marked live</div></div>' +
      '<div class="mc"><div class="ml">Unrealised P&amp;L</div><div class="mv ' +
        (openPnl >= 0 ? 'up' : 'dn') + '">' + (marked ? fmtMoney(openPnl) : '—') + '</div></div>' +
      '<div class="mc"><div class="ml">Realised P&amp;L</div><div class="mv ' +
        (realised >= 0 ? 'up' : 'dn') + '">' + (closed.length ? fmtMoney(realised) : '—') +
        '</div><div class="ms">' + closed.length + ' closed</div></div>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2600);
  }

  // ---------- Wire up static controls once DOM is ready ----------
  function init() {
    const addBtn = document.getElementById('sbAddLeg');
    if (addBtn) addBtn.addEventListener('click', () => addLeg());

    const clearBtn = document.getElementById('sbClear');
    if (clearBtn) clearBtn.addEventListener('click', clearLegs);

    const saveBtn = document.getElementById('sbSaveTrade');
    if (saveBtn) saveBtn.addEventListener('click', saveCurrentStrategy);

    document.querySelectorAll('.sb-preset').forEach(btn => {
      btn.addEventListener('click', () => {
        const fn = PRESETS[btn.dataset.preset];
        if (fn) fn();
      });
    });

    const lotInput = document.getElementById('sbLotSize');
    if (lotInput) {
      lotInput.addEventListener('input', () => {
        lotInput.dataset.userEdited = '1';
        computeAndRender();
      });
    }

    // Expiry changes affect which saved trades can be marked live.
    const expSel = document.getElementById('expSel');
    if (expSel) expSel.addEventListener('change', () => setTimeout(renderTrades, 0));

    renderLegs();
    loadTrades();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();