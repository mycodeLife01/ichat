import asyncio

from app.worker.main import run_worker_from_settings

if __name__ == "__main__":
    asyncio.run(run_worker_from_settings())
