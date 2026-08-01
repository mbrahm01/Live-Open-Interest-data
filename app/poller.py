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

state = {
    "data": None,
    "fetched_at": None,
    "error": None,
    "next_in": POLL_INTERVAL,
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


def _fetch_and_broadcast(session, next_in: int):
    """Fetch one snapshot, update shared state, and broadcast it. Returns the fetched data (or None)."""
    with state_lock:
        active_index = state["selected_index"]
        active_expiry = state["selected_expiry"]

    log.info("Fetching NSE data… index=%s expiry=%s", active_index, active_expiry)
    data = fetch_once(session, symbol=active_index, expiry=active_expiry)
    now = datetime.now().strftime("%d-%b-%Y %H:%M:%S")

    with state_lock:
        if data:
            state["data"] = data
            state["fetched_at"] = now
            state["error"] = None
            state["expiry"] = active_expiry
            state["index"] = active_index
            spot = data.get("records", {}).get("underlyingValue", "?")
            log.info("✓ Updated  index=%s spot=%s expiry=%s", active_index, spot, active_expiry)
            broadcast(
                "update",
                {
                    "data": data,
                    "fetched_at": now,
                    "error": None,
                    "next_in": next_in,
                    "expiry": active_expiry,
                    "index": active_index,
                },
            )
        else:
            state["error"] = f"Fetch failed at {now}"
            log.warning("Fetch failed, keeping previous data")
            broadcast("error", {"error": state["error"]})
    return data


def _refresh_expiries(session):
    """Fetch the expiry list for the currently selected index and update state.
    Called at startup and again whenever the selected index changes."""
    with state_lock:
        idx = state.get("selected_index", DEFAULT_INDEX)

    expiries = fetch_expiry_dates(session, symbol=idx)
    selected = expiries[0] if expiries else None

    with state_lock:
        state["available_expiries"] = expiries
        state["selected_expiry"] = selected

    if expiries:
        broadcast("expiry_list", {"expiries": expiries, "selected": selected})
    else:
        log.warning("No expiry dates fetched for index=%s", idx)
    return selected


def set_selected_index(index: str) -> bool:
    if index not in AVAILABLE_INDEXES:
        log.warning("Rejected index selection %r — not in available list %r", index, AVAILABLE_INDEXES)
        return False
    with state_lock:
        if state.get("selected_index") == index:
            return True  # no-op, already selected
        state["selected_index"] = index
        # Expiries and cached data are index-specific — invalidate both so the
        # poller knows it must refresh the expiry list before fetching data.
        state["available_expiries"] = []
        state["selected_expiry"] = None
        state["data"] = None
        log.info("Selected index changed → %s", index)
    wake_event.set()
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

    broadcast("index_list", {"indexes": AVAILABLE_INDEXES, "selected": DEFAULT_INDEX})

    _refresh_expiries(session)

    market_open = None
    current_index = DEFAULT_INDEX  # tracks the index our cached expiries/data belong to

    while True:
        with state_lock:
            selected_index = state["selected_index"]

        if selected_index != current_index:
            log.info("Index changed %s → %s, refreshing expiries", current_index, selected_index)
            current_index = selected_index
            _refresh_expiries(session)
            # fall through immediately to fetch fresh data below, regardless of
            # market hours — same "load once" behavior expiry-switching already has

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
                cached_index = state.get("index")
                cached_expiry = state.get("expiry")
                selected_exp = state["selected_expiry"]
            if not have_data or cached_index != selected_index or cached_expiry != selected_exp:
                log.info("Market closed, fetching once for index=%s expiry=%s", selected_index, selected_exp)
                _fetch_and_broadcast(session, next_in=0)
            wake_event.wait(timeout=MARKET_CLOSED_POLL)
            wake_event.clear()
            continue

        if time.time() - last_session_time > SESSION_REFRESH:
            session = make_session()
            last_session_time = time.time()

        _fetch_and_broadcast(session, next_in=POLL_INTERVAL)

        with state_lock:
            active_index = state["selected_index"]
            active_expiry = state["selected_expiry"]

        for remaining in range(POLL_INTERVAL - 1, 0, -1):
            wake_event.wait(timeout=1)
            wake_event.clear()
            with state_lock:
                if state["selected_index"] != active_index or state["selected_expiry"] != active_expiry:
                    log.info("Selection changed by user → refetching immediately")
                    break
            if not is_market_open():
                log.info("Market closed mid-cycle → stopping ticks")
                break
            broadcast("tick", {"next_in": remaining})
        else:
            time.sleep(1)
            continue