import os
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask

from .auth import auth_bp
from .routes import main_bp

ROOT_DIR = Path(__file__).resolve().parent.parent


def create_app():
    load_dotenv(ROOT_DIR / ".env")
    app = Flask(
        __name__,
        static_folder="static",
        static_url_path="",
        template_folder="templates",
    )
    app.secret_key = os.getenv("FLASK_SECRET_KEY", "")
    app.config["SECRET_KEY"] = app.secret_key

    app.register_blueprint(auth_bp)
    app.register_blueprint(main_bp)
    return app
