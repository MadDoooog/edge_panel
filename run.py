"""Entry point: python run.py"""
import uvicorn
from backend.config import load_config

if __name__ == "__main__":
    cfg = load_config()
    srv = cfg.get("server", {})
    host = srv.get("host", "127.0.0.1")
    port = int(srv.get("port", 8765))
    uvicorn.run(
        "backend.main:app",
        host=host,
        port=port,
        reload=False,
        log_level="info",
    )
