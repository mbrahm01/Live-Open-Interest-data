from functools import wraps

from flask import Blueprint, jsonify, redirect, render_template, request, session, url_for

from .db import create_user, verify_user

auth_bp = Blueprint("auth", __name__)


def login_required(view_func):
    """Decorator: redirects to /login for page routes, 401s for API/SSE routes."""

    @wraps(view_func)
    def wrapped(*args, **kwargs):
        if not session.get("username"):
            if request.path.startswith("/api/") or request.path == "/select_expiry":
                return jsonify({"error": "authentication required"}), 401
            return redirect(url_for("auth.login_page"))
        return view_func(*args, **kwargs)

    return wrapped


@auth_bp.route("/register", methods=["GET", "POST"])
def register_page():
    if request.method == "GET":
        return render_template("register.html")
    body = request.get_json(silent=True) or request.form
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or not password:
        return jsonify({"ok": False, "error": "username and password required"}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "error": "password must be at least 6 characters"}), 400
    if not create_user(username, password):
        return jsonify({"ok": False, "error": "username already taken"}), 409
    session["username"] = username
    return jsonify({"ok": True})


@auth_bp.route("/login", methods=["GET", "POST"])
def login_page():
    if request.method == "GET":
        return render_template("login.html")
    body = request.get_json(silent=True) or request.form
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not verify_user(username, password):
        return jsonify({"ok": False, "error": "invalid username or password"}), 401
    session["username"] = username
    return jsonify({"ok": True})


@auth_bp.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@auth_bp.route("/api/whoami")
def whoami():
    return jsonify({"logged_in": bool(session.get("username"))})
