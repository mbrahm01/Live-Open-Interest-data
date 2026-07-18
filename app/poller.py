import json
import logging
import threading
import time
from datetime import datetime
from queue import Empty, Queue

from .market import MARKET_CLOSED_POLL, is_market_open
from .nse import fetch_expiry_dates, fetch_once, make_session

POLL_INTERVAL = 60
SESSION_REFRESH = 300

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
        active_expiry = state["selected_expiry"]

    log.info("Fetching NSE data… expiry=%s", active_expiry)
    data = fetch_once(session, expiry=active_expiry)
    now = datetime.now().strftime("%d-%b-%Y %H:%M:%S")

    with state_lock:
        if data:
            state["data"] = data
            state["fetched_at"] = now
            state["error"] = None
            state["expiry"] = active_expiry
            spot = data.get("records", {}).get("underlyingValue", "?")
            log.info("✓ Updated  spot=%s expiry=%s", spot, active_expiry)
            broadcast(
                "update",
                {
                    "data": data,
                    "fetched_at": now,
                    "error": None,
                    "next_in": next_in,
                    "expiry": active_expiry,
                },
            )
        else:
            state["error"] = f"Fetch failed at {now}"
            log.warning("Fetch failed, keeping previous data")
            broadcast("error", {"error": state["error"]})
    return data


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

    available_expiries = fetch_expiry_dates(session)
    selected_expiry = available_expiries[0] if available_expiries else None

    with state_lock:
        state["available_expiries"] = available_expiries
        state["selected_expiry"] = selected_expiry

    if available_expiries:
        broadcast("expiry_list", {"expiries": available_expiries, "selected": selected_expiry})
    else:
        log.warning("No expiry dates fetched — expiry endpoint may have failed")

    market_open = None

    while True:
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
                cached_expiry = state.get("expiry")
                selected = state["selected_expiry"]
            if not have_data or cached_expiry != selected:
                log.info("Market closed, fetching once for expiry=%s", selected)
                _fetch_and_broadcast(session, next_in=0)
            wake_event.wait(timeout=MARKET_CLOSED_POLL)
            wake_event.clear()
            continue

        if time.time() - last_session_time > SESSION_REFRESH:
            session = make_session()
            last_session_time = time.time()

        _fetch_and_broadcast(session, next_in=POLL_INTERVAL)

        with state_lock:
            active_expiry = state["selected_expiry"]

        for remaining in range(POLL_INTERVAL - 1, 0, -1):
            wake_event.wait(timeout=1)
            wake_event.clear()
            with state_lock:
                if state["selected_expiry"] != active_expiry:
                    log.info("Expiry changed by user → refetching immediately")
                    break
            if not is_market_open():
                log.info("Market closed mid-cycle → stopping ticks")
                break
            broadcast("tick", {"next_in": remaining})
        else:
            time.sleep(1)
            continue
