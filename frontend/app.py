"""
MM Zettai - Frontend Proxy Server
Reverse proxy + static file server for the meeting application.
Runs on the Windows/client machine, proxies API requests to the GPU backend.
"""

import asyncio
import logging
import os
import re
import subprocess
import threading

import httpx
import uvicorn
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, StreamingResponse, Response, JSONResponse
from fastapi.staticfiles import StaticFiles

# ─── Configuration ────────────────────────────────────────────────────────────

# Backend URL (GPU server) - update this to your GPU server IP
BACKEND_URL = os.environ.get("BACKEND_URL", "http://172.30.140.218:8003")
BACKEND_WS_URL = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://")
HOST = "0.0.0.0"
PORT = 8003

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
logger = logging.getLogger("mm_zettai.frontend")

app = FastAPI(title="MM Zettai Frontend")

# HTTP client pool
http_client = None

# Cloudflare tunnel state
tunnel_url = None
tunnel_process = None

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")


# ─── Cloudflare Tunnel ────────────────────────────────────────────────────────

def _start_tunnel():
    """Start cloudflared quick tunnel in a background thread."""
    global tunnel_url, tunnel_process
    try:
        tunnel_process = subprocess.Popen(
            ["cloudflared", "tunnel", "--url", f"http://localhost:{PORT}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        # cloudflared prints the URL to stderr
        for line in tunnel_process.stderr:
            match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", line)
            if match:
                tunnel_url = match.group(0)
                logger.info(f"Cloudflare tunnel ready: {tunnel_url}")
                break
        # Keep reading stderr so the pipe doesn't block
        for _ in tunnel_process.stderr:
            pass
    except FileNotFoundError:
        logger.warning("cloudflared not found — tunnel sharing disabled. Install cloudflared to enable.")
    except Exception as e:
        logger.error(f"Cloudflare tunnel error: {e}")


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup():
    global http_client
    http_client = httpx.AsyncClient(
        base_url=BACKEND_URL,
        timeout=180.0,
        limits=httpx.Limits(max_connections=50, max_keepalive_connections=30)
    )
    logger.info(f"Frontend proxy started. Backend: {BACKEND_URL}")

    # Start cloudflare tunnel in background
    threading.Thread(target=_start_tunnel, daemon=True).start()


@app.on_event("shutdown")
async def shutdown():
    if http_client:
        await http_client.aclose()
    if tunnel_process:
        tunnel_process.terminate()


# ─── Static Files ─────────────────────────────────────────────────────────────

@app.get("/")
async def serve_index():
    return HTMLResponse(open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8").read())


@app.get("/manifest.json")
async def serve_manifest():
    path = os.path.join(STATIC_DIR, "manifest.json")
    if os.path.exists(path):
        return Response(
            content=open(path, "r", encoding="utf-8").read(),
            media_type="application/manifest+json"
        )
    return Response(status_code=404)


# Mount static files
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ─── Tunnel URL Endpoint ─────────────────────────────────────────────────────

@app.get("/tunnel-url")
async def get_tunnel_url():
    """Return the current Cloudflare tunnel URL (if available)."""
    if tunnel_url:
        return JSONResponse({"url": tunnel_url})
    return JSONResponse({"url": None}, status_code=200)


# ─── API Proxy ────────────────────────────────────────────────────────────────

@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_api(request: Request, path: str):
    """Proxy all API requests to the backend."""
    url = f"/api/{path}"

    # Build forwarding headers (only pass Authorization, Content-Type, Accept)
    fwd_headers = {}
    if "authorization" in request.headers:
        fwd_headers["authorization"] = request.headers["authorization"]

    try:
        if request.method == "GET":
            resp = await http_client.get(url, headers=fwd_headers, params=request.query_params)
        else:
            content_type = request.headers.get("content-type", "")
            if "multipart" in content_type:
                body = await request.body()
                fwd_headers["content-type"] = content_type
                resp = await http_client.request(
                    request.method, url, headers=fwd_headers, content=body
                )
            elif "json" in content_type:
                body = await request.json()
                resp = await http_client.request(
                    request.method, url, headers=fwd_headers, json=body
                )
            else:
                body = await request.body()
                if content_type:
                    fwd_headers["content-type"] = content_type
                resp = await http_client.request(
                    request.method, url, headers=fwd_headers, content=body
                )

        # Filter response headers to avoid conflicts
        resp_headers = {}
        for key, val in resp.headers.items():
            lk = key.lower()
            if lk not in ("transfer-encoding", "content-encoding", "content-length", "connection"):
                resp_headers[key] = val

        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=resp_headers,
            media_type=resp.headers.get("content-type")
        )
    except httpx.ConnectError:
        return Response(
            content='{"detail":"Backend unavailable"}',
            status_code=503,
            media_type="application/json"
        )
    except Exception as e:
        logger.error(f"Proxy error: {e}")
        return Response(
            content=f'{{"detail":"Proxy error: {str(e)}"}}',
            status_code=502,
            media_type="application/json"
        )


# ─── WebSocket Proxy ─────────────────────────────────────────────────────────

@app.websocket("/ws/{path:path}")
async def proxy_websocket(websocket: WebSocket, path: str):
    """Proxy WebSocket connections to the backend."""
    await websocket.accept()

    query_string = str(websocket.query_params)
    backend_url = f"{BACKEND_WS_URL}/ws/{path}"
    if query_string:
        backend_url += f"?{query_string}"

    import websockets

    try:
        async with websockets.connect(backend_url) as backend_ws:
            async def forward_to_backend():
                try:
                    while True:
                        data = await websocket.receive_text()
                        await backend_ws.send(data)
                except WebSocketDisconnect:
                    pass
                except Exception:
                    pass

            async def forward_to_client():
                try:
                    async for message in backend_ws:
                        await websocket.send_text(message)
                except Exception:
                    pass

            await asyncio.gather(forward_to_backend(), forward_to_client())

    except Exception as e:
        logger.error(f"WebSocket proxy error: {e}")
        try:
            await websocket.send_json({"type": "error", "message": "Backend connection failed"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


# ─── Run ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "app:app",
        host=HOST,
        port=PORT,
        workers=1,
        log_level="info"
    )
