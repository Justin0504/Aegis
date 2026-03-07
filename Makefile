.PHONY: help up down dev logs clean install-sdk

help:
	@echo "AEGIS Commands:"
	@echo "  make up          - Start gateway + dashboard"
	@echo "  make down        - Stop all services"
	@echo "  make dev         - Start with hot-reload"
	@echo "  make logs        - Tail logs"
	@echo "  make clean       - Remove containers and volumes"
	@echo "  make install-sdk - Install Python SDK locally"

up:
	docker compose up -d --build

down:
	docker compose down

dev:
	docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

logs:
	docker compose logs -f

clean:
	docker compose down -v

install-sdk:
	pip install -e ./packages/core-schema/python
	pip install -e ./packages/sdk-python
