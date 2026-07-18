import logging
import os
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parent.parent
load_dotenv(ROOT_DIR / ".env")

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


def fetch_once(session: requests.Session, expiry=None):
    params = {"symbol": "NIFTY"}
    if expiry:
        params["expiry"] = expiry
    try:
        resp = session.get(NSE_URL, params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.error("Fetch error: %s", exc)
        return None


def fetch_expiry_dates(session):
    """One-time call to a separate endpoint that just returns contract/expiry dates."""
    try:
        resp = session.get(EXPIRY_URL, params={"symbol": "NIFTY"}, timeout=5)
        resp.raise_for_status()
        payload = resp.json()
        return payload.get("expiryDates", [])
    except Exception:
        log.exception("Failed to fetch expiry dates")
        return []
