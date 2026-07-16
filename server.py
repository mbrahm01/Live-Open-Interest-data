"""
NSE Option Chain — Python Backend
===================================
• Fetches OI data from NSE every 60 seconds in a background thread
• Serves data via Server-Sent Events (SSE) so the browser updates instantly
• Also exposes GET /api/data for the initial page load snapshot

Install:   pip install flask requests
Run:       python server.py
Open:      http://localhost:5000
"""

import json
import threading
import time
import logging
from datetime import datetime
from pathlib import Path
from queue import Queue, Empty
import os
import requests
from dotenv import load_dotenv
from flask import Flask, Response, jsonify, send_from_directory

# ── Config ─────────────────────────────────────────────────────────────────────
load_dotenv(Path(__file__).with_name(".env"))
NSE_URL = os.getenv("API")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/148.0.0.0 Safari/537.36"
    ),
    "Referer": "https://www.nseindia.com/option-chain"
}

POLL_INTERVAL    = 60   # seconds between fetches
SESSION_REFRESH  = 300  # re-create session (re-get cookie) every N seconds
STATIC_DIR       = Path(__file__).parent  # index.html lives here

# ── Shared state ───────────────────────────────────────────────────────────────
state = {
    "data":       None,   # latest raw NSE JSON
    "fetched_at": None,   # human-readable timestamp
    "error":      None,
    "next_in":    POLL_INTERVAL,  # seconds until next fetch
}
state_lock = threading.Lock()

subscribers: list[Queue] = []
subscribers_lock = threading.Lock()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

# ── NSE session ────────────────────────────────────────────────────────────────
def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    try:
        s.get("https://www.nseindia.com", timeout=10)
        log.info("NSE cookie refreshed")
    except Exception as exc:
        log.warning("Cookie refresh failed: %s", exc)
    return s

# ── Fetch ──────────────────────────────────────────────────────────────────────
def fetch_once(session: requests.Session):
    try:
        resp = session.get(NSE_URL, timeout=15)
        resp.raise_for_status()
        return resp.json()
    except Exception as exc:
        log.error("Fetch error: %s", exc)
        return None

# ── Broadcast to all SSE clients ───────────────────────────────────────────────
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
            subscribers.remove(q)

# ── Background poller ──────────────────────────────────────────────────────────
def poller():
    session = make_session()
    last_session_time = time.time()

    while True:
        if time.time() - last_session_time > SESSION_REFRESH:
            session = make_session()
            last_session_time = time.time()

        log.info("Fetching NSE data…")
        data = fetch_once(session)
        now  = datetime.now().strftime("%d-%b-%Y %H:%M:%S")

        with state_lock:
            if data:
                state["data"]       = data
                state["fetched_at"] = now
                state["error"]      = None
                spot = data.get("records", {}).get("underlyingValue", "?")
                log.info("✓ Updated  spot=%s", spot)
                broadcast("update", {
                    "data":       data,
                    "fetched_at": now,
                    "error":      None,
                    "next_in":    POLL_INTERVAL,
                })
            else:
                state["error"] = f"Fetch failed at {now}"
                log.warning("Fetch failed, keeping previous data")
                broadcast("error", {"error": state["error"]})

        # Countdown ticks every second so the browser ring stays accurate
        for remaining in range(POLL_INTERVAL - 1, 0, -1):
            time.sleep(1)
            broadcast("tick", {"next_in": remaining})

        time.sleep(1)  # final second

# ── Flask ──────────────────────────────────────────────────────────────────────
app = Flask(__name__, static_folder=None)

@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")

@app.route("/styles.css")
def styles_css():
    return send_from_directory(STATIC_DIR, "styles.css")

@app.route("/app.js")
def app_js():
    return send_from_directory(STATIC_DIR, "app.js")

@app.route("/api/data")
def api_data():
    with state_lock:
        if state["data"] is None:
            return jsonify({"error": "No data yet — first fetch in progress"}), 503
        return jsonify({
            "data":       state["data"],
            "fetched_at": state["fetched_at"],
            "error":      state["error"],
            "next_in":    state["next_in"],
        })

@app.route("/api/stream")
def api_stream():
    q: Queue = Queue(maxsize=20)
    with subscribers_lock:
        subscribers.append(q)

    # Send current snapshot immediately so the page doesn't wait 60 s
    with state_lock:
        if state["data"]:
            payload = json.dumps({
                "data":       state["data"],
                "fetched_at": state["fetched_at"],
                "error":      state["error"],
                "next_in":    state["next_in"],
            })
            q.put_nowait(f"event: update\ndata: {payload}\n\n")

    def generate():
        try:
            while True:
                try:
                    yield q.get(timeout=30)
                except Empty:
                    yield ": heartbeat\n\n"
        except GeneratorExit:
            with subscribers_lock:
                if q in subscribers:
                    subscribers.remove(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )

if __name__ == "__main__":
    t = threading.Thread(target=poller, daemon=True)
    t.start()
    log.info("Poller started — first fetch in progress")
    log.info("Dashboard → http://localhost:5000")
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
