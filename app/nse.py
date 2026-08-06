import logging
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

# Same NSE API and same expiry-lookup API as before for both index and stock
# symbols — NSE's option-chain-indices endpoint accepts stock symbols too, so
# there's no second endpoint to configure. Only the `symbol` query param
# changes based on what's selected.
NSE_URL = os.getenv("API")
EXPIRY_URL = os.getenv("NIFTY_CONTRACT_INFO")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/148.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nseindia.com/option-chain",
}

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    try:
        s.get("https://www.nseindia.com", timeout=10)
        log.info("NSE cookie refreshed")
    except Exception as exc:
        log.warning("Cookie refresh failed: %s", exc)
    return s


def fetch_once(session, symbol="NIFTY", expiry=None):
    params = {"symbol": symbol}
    if expiry:
        params["expiry"] = expiry
    try:
        resp = session.get(NSE_URL, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
        # A symbol NSE doesn't currently treat as F&O-active (delisted from
        # F&O, or just typo'd) comes back 200 with an empty records block
        # rather than an error — catch that here so callers get a clean
        # "no data" signal instead of charting zeros.
        rows = (payload.get("records") or {}).get("data") or []
        if not rows:
            log.warning("Empty option chain for symbol=%s — not F&O-active right now", symbol)
            return None
        return payload
    except Exception as exc:
        log.error("Fetch error (symbol=%s): %s", symbol, exc)
        return None


def fetch_expiry_dates(session, symbol="NIFTY"):
    try:
        resp = session.get(EXPIRY_URL, params={"symbol": symbol}, timeout=5)
        resp.raise_for_status()
        payload = resp.json()
        return payload.get("expiryDates", [])
    except Exception:
        log.exception("Failed to fetch expiry dates for symbol=%s", symbol)
        return []