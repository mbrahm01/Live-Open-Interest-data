"""
NSE Option Chain — Python Backend
===================================
• Fetches OI data from NSE every 60 seconds in a background thread
• Serves data via Server-Sent Events (SSE) so the browser updates instantly
• Also exposes GET /api/data for the initial page load snapshot

Install:   pip install -r requirements.txt
Run:       python server.py
Open:      http://localhost:5000
"""

import logging
import threading

from app import create_app
from app.db import init_db
from app.poller import poller

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)


if __name__ == "__main__":
    init_db()
    t = threading.Thread(target=poller, daemon=True)
    t.start()
    log.info("Poller started — first fetch in progress")
    log.info("Dashboard → http://localhost:5000")
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
