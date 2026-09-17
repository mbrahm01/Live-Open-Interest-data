import json
from queue import Empty, Queue

from flask import Blueprint, Response, jsonify, render_template, request

from .auth import login_required
from .paper import close_trade, delete_trade, list_trades, save_trade
from .poller import (
    broadcast,
    set_selected_expiry,
    set_selected_index,
    set_selected_mode,
    set_selected_stock,
    state,
    state_lock,
    subscribers,
    subscribers_lock,
)

main_bp = Blueprint("main", __name__)


@main_bp.route("/")
@login_required
def index():
    return render_template("index.html")


@main_bp.route("/api/data")
@login_required
def api_data():
    """Snapshot for initial page load. Accepts ?type=index|stock&symbol=X so a
    fresh page load can request a specific view directly, same params as the
    SSE stream / select_* routes use."""
    req_type = request.args.get("type")
    req_symbol = request.args.get("symbol")
    if req_type == "index" and req_symbol:
        set_selected_index(req_symbol)
    elif req_type == "stock" and req_symbol:
        set_selected_stock(req_symbol)

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
                "mode": state.get("mode"),
                "symbol": state.get("symbol"),
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


@main_bp.route("/select_index", methods=["POST"])
@login_required
def select_index():
    body = request.get_json(silent=True) or {}
    index = (body.get("index") or "").strip().upper()
    if not index:
        return {"ok": False, "error": "missing index"}, 400
    if set_selected_index(index):
        return {"ok": True}, 200
    return {"ok": False, "error": "invalid index"}, 400


@main_bp.route("/select_stock", methods=["POST"])
@login_required
def select_stock():
    body = request.get_json(silent=True) or {}
    symbol = (body.get("symbol") or "").strip().upper()
    if not symbol:
        return {"ok": False, "error": "missing symbol"}, 400
    if set_selected_stock(symbol):
        return {"ok": True}, 200
    return {"ok": False, "error": "invalid or non-F&O symbol"}, 400


@main_bp.route("/select_mode", methods=["POST"])
@login_required
def select_mode():
    """Switches the Index/Stocks toggle. This alone stops the poller from
    fetching the previous mode's symbol — set_selected_mode() flips
    state['mode'], and the poller loop only ever fetches whatever
    state['mode'] currently points to, so there's never simultaneous
    polling of both an index and a stock."""
    body = request.get_json(silent=True) or {}
    mode = (body.get("mode") or "").strip().lower()
    if mode not in ("index", "stock"):
        return {"ok": False, "error": "mode must be 'index' or 'stock'"}, 400
    if set_selected_mode(mode):
        return {"ok": True}, 200
    return {"ok": False, "error": "failed to switch mode"}, 400


@main_bp.route("/api/stream")
@login_required
def api_stream():
    q: Queue = Queue(maxsize=20)
    with subscribers_lock:
        subscribers.append(q)

    with state_lock:
        if state.get("available_indexes"):
            index_payload = json.dumps(
                {
                    "indexes": state["available_indexes"],
                    "selected": state.get("selected_index"),
                }
            )
            q.put_nowait(f"event: index_list\ndata: {index_payload}\n\n")

        if state.get("available_stocks"):
            stock_payload = json.dumps(
                {
                    "stocks": state["available_stocks"],
                    "selected": state.get("selected_stock"),
                }
            )
            q.put_nowait(f"event: stock_list\ndata: {stock_payload}\n\n")

        mode_payload = json.dumps({"mode": state.get("mode", "index")})
        q.put_nowait(f"event: mode\ndata: {mode_payload}\n\n")

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
                    "symbol": state.get("symbol"),
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

# ---------------- Paper trading ----------------
# Saved strategies are stored server-side so they survive a page reload,
# a browser change, or a server restart. P&L marks are computed client-side
# (the browser already holds the live chain) and only recorded here.


@main_bp.route("/api/paper/trades", methods=["GET"])
@login_required
def paper_list():
    return jsonify({"trades": list_trades()})


@main_bp.route("/api/paper/trades", methods=["POST"])
@login_required
def paper_save():
    body = request.get_json(silent=True) or {}
    try:
        trade = save_trade(body)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    return jsonify({"ok": True, "trade": trade}), 201


@main_bp.route("/api/paper/trades/<trade_id>/close", methods=["POST"])
@login_required
def paper_close(trade_id):
    body = request.get_json(silent=True) or {}
    if "pnl" not in body:
        return {"ok": False, "error": "missing pnl"}, 400
    try:
        trade = close_trade(trade_id, body.get("pnl"), body.get("spotAtExit"))
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    if trade is None:
        return {"ok": False, "error": "trade not found"}, 404
    return jsonify({"ok": True, "trade": trade})


@main_bp.route("/api/paper/trades/<trade_id>", methods=["DELETE"])
@login_required
def paper_delete(trade_id):
    if not delete_trade(trade_id):
        return {"ok": False, "error": "trade not found"}, 404
    return jsonify({"ok": True})