import json
import logging
import os
import threading
import time
from datetime import datetime
from queue import Empty, Queue

from .market import MARKET_CLOSED_POLL, is_market_open
from .nse import fetch_expiry_dates, fetch_once, make_session

POLL_INTERVAL = 60
SESSION_REFRESH = 300

AVAILABLE_INDEXES = [s.strip() for s in os.getenv("INDEXES", "NIFTY,BANKNIFTY,FINNIFTY,").split(",") if s.strip()]
DEFAULT_INDEX = AVAILABLE_INDEXES[0] if AVAILABLE_INDEXES else "NIFTY"

# Static F&O stock universe for the "Stocks" toggle. NSE revises the F&O
# list quarterly (SEBI review), so this is a best-effort starting list, not
# a guarantee — nse.fetch_once() already treats an empty option-chain
# response as a failed fetch, so a symbol that's fallen off F&O just shows
# "no data" via the normal error path rather than crashing anything.
# TMPV = Tata Motors Passenger Vehicles Ltd, the demerged (Oct 2025)
# passenger-vehicle entity — a real, distinct, F&O-listed symbol, not a typo.
STOCK_LIST = {
    "ADANIENT": "Adani Enterprises Ltd.", "ADANIPORTS": "Adani Ports & SEZ Ltd.",
    "APOLLOHOSP": "Apollo Hospitals Enterprise Ltd.", "ASIANPAINT": "Asian Paints Ltd.",
    "AXISBANK": "Axis Bank Ltd.", "BAJAJ-AUTO": "Bajaj Auto Ltd.",
    "BAJFINANCE": "Bajaj Finance Ltd.", "BAJAJFINSV": "Bajaj Finserv Ltd.",
    "BEL": "Bharat Electronics Ltd.", "BHARTIARTL": "Bharti Airtel Ltd.",
    "CIPLA": "Cipla Ltd.", "COALINDIA": "Coal India Ltd.",
    "DRREDDY": "Dr. Reddy's Laboratories Ltd.", "EICHERMOT": "Eicher Motors Ltd.",
    "GRASIM": "Grasim Industries Ltd.", "HCLTECH": "HCL Technologies Ltd.",
    "HDFCBANK": "HDFC Bank Ltd.", "HDFCLIFE": "HDFC Life Insurance Co. Ltd.",
    "HINDALCO": "Hindalco Industries Ltd.", "HINDUNILVR": "Hindustan Unilever Ltd.",
    "ICICIBANK": "ICICI Bank Ltd.", "INDIGO": "InterGlobe Aviation Ltd.",
    "INFY": "Infosys Ltd.", "ITC": "ITC Ltd.", "JIOFIN": "Jio Financial Services Ltd.",
    "JSWSTEEL": "JSW Steel Ltd.", "KOTAKBANK": "Kotak Mahindra Bank Ltd.",
    "LT": "Larsen & Toubro Ltd.", "M&M": "Mahindra & Mahindra Ltd.",
    "MARUTI": "Maruti Suzuki India Ltd.", "MAXHEALTH": "Max Healthcare Institute Ltd.",
    "NESTLEIND": "Nestle India Ltd.", "NTPC": "NTPC Ltd.", "ONGC": "Oil & Natural Gas Corp. Ltd.",
    "POWERGRID": "Power Grid Corp. of India Ltd.", "RELIANCE": "Reliance Industries Ltd.",
    "SBILIFE": "SBI Life Insurance Co. Ltd.", "SBIN": "State Bank of India",
    "SHRIRAMFIN": "Shriram Finance Ltd.", "SUNPHARMA": "Sun Pharmaceutical Industries Ltd.",
    "TATACONSUM": "Tata Consumer Products Ltd.", "TMPV": "Tata Motors Passenger Vehicles Ltd.",
    "TATASTEEL": "Tata Steel Ltd.", "TCS": "Tata Consultancy Services Ltd.",
    "TECHM": "Tech Mahindra Ltd.", "TITAN": "Titan Company Ltd.", "TRENT": "Trent Ltd.",
    "ULTRACEMCO": "UltraTech Cement Ltd.", "WIPRO": "Wipro Ltd.",
}

state = {
    "data": None,
    "fetched_at": None,
    "error": None,
    "next_in": POLL_INTERVAL,
    # "index" or "stock" — which toggle position is active
    "mode": "index",
    "selected_expiry": None,
    "available_expiries": [],
}
state_lock = threading.Lock()

subscribers: list[Queue] = []
subscribers_lock = threading.Lock()

wake_event = threading.Event()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def broadcast(event: str, payload: dict):
    msg = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
    with subscribers_lock:
        dead = []
        for q in subscribers:
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(q)
        for q in dead:
            if q in subscribers:
                subscribers.remove(q)


def _active_symbol():
    with state_lock:
        mode = state["mode"]
        symbol = state["selected_index"] if mode == "index" else state["selected_stock"]
        return symbol, state.get("selected_expiry")


def _fetch_and_broadcast(session, next_in: int):
    """Fetch one snapshot for whichever symbol/mode is currently active,
    update shared state, and broadcast it. Same API call either way — only
    the symbol param changes, whether it's NIFTY or RELIANCE."""
    symbol, active_expiry = _active_symbol()
    if not symbol:
        return None

    log.info("Fetching NSE data… symbol=%s expiry=%s", symbol, active_expiry)
    data = fetch_once(session, symbol=symbol, expiry=active_expiry)
    now = datetime.now().strftime("%d-%b-%Y %H:%M:%S")

    with state_lock:
        # Bail if the user switched symbol/mode while this request was in
        # flight, so a slow response for the old symbol can't clobber a
        # fresher selection.
        cur_symbol = state["selected_index"] if state["mode"] == "index" else state["selected_stock"]
        if cur_symbol != symbol:
            log.info("Discarding stale fetch for symbol=%s (selection moved on)", symbol)
            return data
        if data:
            state["data"] = data
            state["fetched_at"] = now
            state["error"] = None
            state["expiry"] = active_expiry
            state["symbol"] = symbol
            spot = data.get("records", {}).get("underlyingValue", "?")
            log.info("✓ Updated  symbol=%s spot=%s expiry=%s", symbol, spot, active_expiry)
            broadcast(
                "update",
                {
                    "data": data,
                    "fetched_at": now,
                    "error": None,
                    "next_in": next_in,
                    "expiry": active_expiry,
                    "symbol": symbol,
                },
            )
        else:
            state["error"] = f"Fetch failed at {now}"
            log.warning("Fetch failed for symbol=%s, keeping previous data", symbol)
            broadcast("error", {"error": state["error"], "symbol": symbol})
    return data


def _refresh_expiries(session):
    """Fetch the expiry list for the currently active symbol and update
    state. Called at startup and whenever the selected symbol/mode changes."""
    symbol, _ = _active_symbol()
    if not symbol:
        return None

    expiries = fetch_expiry_dates(session, symbol=symbol)
    selected = expiries[0] if expiries else None

    with state_lock:
        state["available_expiries"] = expiries
        state["selected_expiry"] = selected

    if expiries:
        broadcast("expiry_list", {"expiries": expiries, "selected": selected})
    else:
        log.warning("No expiry dates fetched for symbol=%s", symbol)
    return selected


def _invalidate_for_new_selection():
    """Shared invalidation logic for any change of symbol/mode — expiries
    and cached data are symbol-specific, so both must be cleared and the
    poller woken to refetch."""
    with state_lock:
        state["available_expiries"] = []
        state["selected_expiry"] = None
        state["data"] = None
    wake_event.set()


def set_selected_mode(mode: str) -> bool:
    """Switch between 'index' and 'stock' toggle positions. Cleanly stops
    polling the old symbol — the poller loop only ever fetches the single
    active mode/symbol, so no dual-polling ever happens."""
    if mode not in ("index", "stock"):
        return False
    with state_lock:
        if state["mode"] == mode:
            return True
        state["mode"] = mode
        log.info("Mode changed → %s", mode)
    _invalidate_for_new_selection()
    return True


def set_selected_index(index: str) -> bool:
    if index not in AVAILABLE_INDEXES:
        log.warning("Rejected index selection %r — not in available list %r", index, AVAILABLE_INDEXES)
        return False
    with state_lock:
        if state.get("selected_index") == index and state["mode"] == "index":
            return True
        state["selected_index"] = index
        state["mode"] = "index"
        log.info("Selected index changed → %s", index)
    _invalidate_for_new_selection()
    return True


def set_selected_stock(symbol: str) -> bool:
    symbol = (symbol or "").strip().upper()
    if symbol not in STOCK_LIST:
        log.warning("Rejected stock selection %r — not in STOCK_LIST", symbol)
        return False
    with state_lock:
        if state.get("selected_stock") == symbol and state["mode"] == "stock":
            return True
        state["selected_stock"] = symbol
        state["mode"] = "stock"
        log.info("Selected stock changed → %s", symbol)
    _invalidate_for_new_selection()
    return True


def set_selected_expiry(expiry: str) -> bool:
    with state_lock:
        available = state.get("available_expiries", [])
        if expiry not in available:
            log.warning("Rejected expiry selection %r — not in available list %r", expiry, available)
            return False
        state["selected_expiry"] = expiry
        log.info("Selected expiry changed → %s", expiry)
    wake_event.set()
    return True


def poller():
    session = make_session()
    last_session_time = time.time()

    with state_lock:
        state["available_indexes"] = AVAILABLE_INDEXES
        state["selected_index"] = DEFAULT_INDEX
        state["available_stocks"] = STOCK_LIST  # {symbol: company name}
        state["selected_stock"] = None
        state["mode"] = "index"

    broadcast("index_list", {"indexes": AVAILABLE_INDEXES, "selected": DEFAULT_INDEX})
    broadcast("stock_list", {"stocks": STOCK_LIST, "selected": None})

    _refresh_expiries(session)

    market_open = None
    # Tracks the (mode, symbol) our cached expiries/data currently belong to
    current_selection = ("index", DEFAULT_INDEX)

    while True:
        with state_lock:
            mode = state["mode"]
            selection = (mode, state["selected_index"] if mode == "index" else state["selected_stock"])

        if selection != current_selection and selection[1] is not None:
            log.info("Selection changed %s → %s, refreshing expiries", current_selection, selection)
            current_selection = selection
            _refresh_expiries(session)
            # fall through immediately to fetch fresh data below, regardless
            # of market hours — same "load once" behavior expiry-switching
            # already had for index mode, now shared by stock mode too

        currently_open = is_market_open()
        if currently_open != market_open:
            market_open = currently_open
            with state_lock:
                state["market_open"] = market_open
            broadcast("market_status", {"open": market_open})
            log.info("Market status changed → %s", "OPEN" if market_open else "CLOSED")

        if not market_open:
            with state_lock:
                have_data = state["data"] is not None
                cached_symbol = state.get("symbol")
                cached_expiry = state.get("expiry")
                selected_exp = state["selected_expiry"]
            if not have_data or cached_symbol != selection[1] or cached_expiry != selected_exp:
                log.info("Market closed, fetching once for %s", selection)
                _fetch_and_broadcast(session, next_in=0)
            wake_event.wait(timeout=MARKET_CLOSED_POLL)
            wake_event.clear()
            continue

        if time.time() - last_session_time > SESSION_REFRESH:
            session = make_session()
            last_session_time = time.time()

        _fetch_and_broadcast(session, next_in=POLL_INTERVAL)

        with state_lock:
            active_selection = ("index", state["selected_index"]) if state["mode"] == "index" else ("stock", state["selected_stock"])
            active_expiry = state["selected_expiry"]

        for remaining in range(POLL_INTERVAL - 1, 0, -1):
            wake_event.wait(timeout=1)
            wake_event.clear()
            with state_lock:
                now_selection = ("index", state["selected_index"]) if state["mode"] == "index" else ("stock", state["selected_stock"])
                if now_selection != active_selection or state["selected_expiry"] != active_expiry:
                    log.info("Selection changed by user → refetching immediately")
                    break
            if not is_market_open():
                log.info("Market closed mid-cycle → stopping ticks")
                break
            broadcast("tick", {"next_in": remaining})
        else:
            time.sleep(1)
            continue