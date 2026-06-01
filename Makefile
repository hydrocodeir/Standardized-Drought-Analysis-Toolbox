PYTHON ?= python3
HOST ?= 127.0.0.1
PORT ?= 8000
HOST_PORT ?= 127.0.0.1:18080

.PHONY: help install run test docker-up docker-down docker-logs docker-restart docker-ps health clean-pyc

help:
	@echo "SDAT Dashboard commands"
	@echo ""
	@echo "Local:"
	@echo "  make install        Install Python requirements"
	@echo "  make run            Run FastAPI locally on $(HOST):$(PORT)"
	@echo "  make test           Run unit tests"
	@echo ""
	@echo "Docker:"
	@echo "  make docker-up      Build and start containers on HOST_PORT=$(HOST_PORT)"
	@echo "  make docker-down    Stop containers"
	@echo "  make docker-logs    Follow container logs"
	@echo "  make docker-restart Restart containers"
	@echo "  make docker-ps      Show compose status"
	@echo ""
	@echo "Checks:"
	@echo "  make health         Check local FastAPI health endpoint"
	@echo "  make clean-pyc      Remove Python cache files"
	@echo ""
	@echo "Examples:"
	@echo "  make run PORT=8001"
	@echo "  make docker-up HOST_PORT=127.0.0.1:18080"

install:
	$(PYTHON) -m pip install -r requirements.txt

run:
	uvicorn app.main:app --reload --host $(HOST) --port $(PORT)

test:
	$(PYTHON) -m unittest discover -s tests -p "test_*.py"

docker-up:
	HOST_PORT=$(HOST_PORT) docker compose up --build -d

docker-down:
	docker compose down

docker-logs:
	docker compose logs -f

docker-restart:
	HOST_PORT=$(HOST_PORT) docker compose up --build -d --force-recreate

docker-ps:
	docker compose ps

health:
	$(PYTHON) -c "import urllib.request; print(urllib.request.urlopen('http://$(HOST):$(PORT)/healthz', timeout=5).read().decode())"

clean-pyc:
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	find . -type f -name "*.pyc" -delete
