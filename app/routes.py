import json
from queue import Empty, Queue

from flask import Blueprint, Response, jsonify, render_template, request

from .auth import login_required
from .poller import broadcast, set_selected_expiry, state, state_lock, subscribers, subscribers_lock

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
@login_required
def index():
    return render_template("index.html")


@main_bp.route("/api/data")
@login_required
def api_data():
    with state_lock:
        if state["data"] is None:
            return jsonify({"error": "No data yet — first fetch in progress"}), 503
        return jsonify(
            {
                "data": state["data"],
                "fetched_at": state["fetched_at"],
                "error": state["error"],
                "next_in": state["next_in"],
                "market_open": state.get("market_open"),
            }
        )


@main_bp.route("/select_expiry", methods=["POST"])
@login_required
def select_expiry():
    body = request.get_json(silent=True) or {}
    expiry = body.get("expiry")
    if not expiry:
        return {"ok": False, "error": "missing expiry"}, 400
    if set_selected_expiry(expiry):
        return {"ok": True}, 200
    return {"ok": False, "error": "invalid expiry"}, 400


@main_bp.route("/api/stream")
@login_required
def api_stream():
    q: Queue = Queue(maxsize=20)
    with subscribers_lock:
        subscribers.append(q)

    with state_lock:
        if state.get("market_open") is not None:
            q.put_nowait(f"event: market_status\ndata: {json.dumps({'open': state['market_open']})}\n\n")

        if state.get("available_expiries"):
            expiry_payload = json.dumps(
                {
                    "expiries": state["available_expiries"],
                    "selected": state["selected_expiry"],
                }
            )
            q.put_nowait(f"event: expiry_list\ndata: {expiry_payload}\n\n")

        if state["data"]:
            payload = json.dumps(
                {
                    "data": state["data"],
                    "fetched_at": state["fetched_at"],
                    "error": state["error"],
                    "next_in": state["next_in"],
                    "expiry": state.get("selected_expiry"),
                }
            )
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
