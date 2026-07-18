from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
MARKET_OPEN = dtime(9, 15)
MARKET_CLOSE = dtime(15, 30)
MARKET_CLOSED_POLL = 30


def is_market_open(now_ist: datetime | None = None) -> bool:
    """NSE cash/derivatives market hours: Mon–Fri, 09:15–15:30 IST."""
    now_ist = now_ist or datetime.now(IST)
    if now_ist.weekday() >= 5:  # 5=Saturday, 6=Sunday
        return False
    return MARKET_OPEN <= now_ist.time() <= MARKET_CLOSE
