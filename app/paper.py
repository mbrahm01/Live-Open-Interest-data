"""Paper-trading store for saved option strategies.

Persists to a JSON file next to the app so saved strategies survive a
server restart. Writes are atomic (tmp file + os.replace) and guarded by a
lock, because the Flask dev server and the poller thread can both be live
at the same time.

Deliberately simple: this is a personal-scale journal, not a ledger. If it
ever needs multi-user support or concurrent writers, move it to SQLite.
"""

import json
import logging
import os
import threading
import uuid
from datetime import datetime
from pathlib import Path

from .market import IST

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.getenv("PAPER_DATA_DIR", ROOT_DIR / "data"))
STORE_PATH = DATA_DIR / "paper_trades.json"

_lock = threading.Lock()
log = logging.getLogger(__name__)

VALID_SIDES = {"BUY", "SELL"}
VALID_TYPES = {"CE", "PE"}
MAX_LEGS = 12


def _now() -> str:
    return datetime.now(IST).strftime("%d-%b-%Y %H:%M:%S")


def _read_unlocked() -> list:
    if not STORE_PATH.exists():
        return []
    try:
        with STORE_PATH.open("r", encoding="utf-8") as fh:
            payload = json.load(fh)
        trades = payload.get("trades", [])
        return trades if isinstance(trades, list) else []
    except Exception:
        # A corrupt store shouldn't take the whole dashboard down — log it
        # and start fresh rather than raising on every request.
        log.exception("Paper store unreadable at %s — starting empty", STORE_PATH)
        return []


def _write_unlocked(trades: list) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = STORE_PATH.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump({"trades": trades}, fh, indent=2)
    os.replace(tmp, STORE_PATH)


def list_trades() -> list:
    with _lock:
        trades = _read_unlocked()
    # Newest first — the thing you just booked should be at the top.
    return sorted(trades, key=lambda t: t.get("createdAtEpoch", 0), reverse=True)


def _clean_legs(raw_legs) -> list:
    """Validate and normalise legs. Raises ValueError on anything unusable —
    a silently-coerced leg would produce a P&L number that looks real but
    isn't."""
    if not isinstance(raw_legs, list) or not raw_legs:
        raise ValueError("at least one leg is required")
    if len(raw_legs) > MAX_LEGS:
        raise ValueError(f"too many legs (max {MAX_LEGS})")

    legs = []
    for leg in raw_legs:
        if not isinstance(leg, dict):
            raise ValueError("each leg must be an object")
        side = str(leg.get("side", "")).upper()
        opt_type = str(leg.get("optType", "")).upper()
        if side not in VALID_SIDES:
            raise ValueError(f"invalid side: {leg.get('side')!r}")
        if opt_type not in VALID_TYPES:
            raise ValueError(f"invalid option type: {leg.get('optType')!r}")
        try:
            strike = float(leg["strike"])
            premium = float(leg["premium"])
            lots = int(leg["lots"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("strike, premium and lots must be numeric")
        if strike <= 0 or lots <= 0 or premium < 0:
            raise ValueError("strike and lots must be positive, premium non-negative")
        legs.append({
            "side": side,
            "optType": opt_type,
            "strike": strike,
            "premium": premium,
            "lots": lots,
        })
    return legs


def save_trade(body: dict) -> dict:
    legs = _clean_legs(body.get("legs"))
    try:
        lot_size = int(body.get("lotSize", 1))
    except (TypeError, ValueError):
        raise ValueError("lotSize must be an integer")
    if lot_size <= 0:
        raise ValueError("lotSize must be positive")

    spot = body.get("spotAtEntry")
    try:
        spot = float(spot) if spot is not None else None
    except (TypeError, ValueError):
        spot = None

    now = datetime.now(IST)
    trade = {
        "id": uuid.uuid4().hex[:12],
        "name": (str(body.get("name") or "Untitled strategy")).strip()[:80],
        "symbol": (str(body.get("symbol") or "")).strip().upper()[:24],
        "expiry": (str(body.get("expiry") or "")).strip()[:24],
        "lotSize": lot_size,
        "spotAtEntry": spot,
        "legs": legs,
        "status": "open",
        "createdAt": _now(),
        "createdAtEpoch": now.timestamp(),
        "closedAt": None,
        "closedPnl": None,
        "spotAtExit": None,
    }

    with _lock:
        trades = _read_unlocked()
        trades.append(trade)
        _write_unlocked(trades)
    log.info("Paper trade saved: %s (%s legs, %s)", trade["name"], len(legs), trade["symbol"])
    return trade


def close_trade(trade_id: str, pnl, spot_at_exit=None) -> dict | None:
    """Close an open trade at a client-supplied mark. The client computes
    the mark because it already holds the live chain; the server only
    records it."""
    try:
        pnl = float(pnl)
    except (TypeError, ValueError):
        raise ValueError("pnl must be numeric")
    try:
        spot_at_exit = float(spot_at_exit) if spot_at_exit is not None else None
    except (TypeError, ValueError):
        spot_at_exit = None

    with _lock:
        trades = _read_unlocked()
        for trade in trades:
            if trade.get("id") == trade_id:
                if trade.get("status") != "open":
                    return trade  # already closed; idempotent
                trade["status"] = "closed"
                trade["closedPnl"] = pnl
                trade["closedAt"] = _now()
                trade["spotAtExit"] = spot_at_exit
                _write_unlocked(trades)
                log.info("Paper trade closed: %s pnl=%.2f", trade.get("name"), pnl)
                return trade
    return None


def delete_trade(trade_id: str) -> bool:
    with _lock:
        trades = _read_unlocked()
        remaining = [t for t in trades if t.get("id") != trade_id]
        if len(remaining) == len(trades):
            return False
        _write_unlocked(remaining)
    return True