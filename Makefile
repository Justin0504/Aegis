.PHONY: help build up down logs shell clean dev prod install-sdk

# Default target
help:
	@echo "AgentGuard Commands:"
	@echo "  make build        - Build all Docker images"
	@echo "  make up           - Start all services (production)"
	@echo "  make dev          - Start all services (dev, hot-reload)"
	@echo "  make down         - Stop all services"
	@echo "  make logs         - Tail logs from all services"
	@echo "  make shell        - Shell into gateway container"
	@echo "  make clean        - Remove all containers and volumes"
	@echo "  make install-sdk  - Install Python SDK and core-schema locally"

# Build all images
build:
	docker-compose build

# Start services in production mode
up:
	docker-compose up -d

# Stop all services
down:
	docker-compose down

# View logs
logs:
	docker-compose logs -f

# Open shell in gateway container
shell:
	docker-compose exec gateway sh

# Clean everything
clean:
	docker-compose down -v
	docker system prune -f

# Development mode with hot-reload
dev:
	docker-compose -f docker-compose.yml -f docker-compose.dev.yml up

# Production mode
prod:
	docker-compose up -d

# Additional useful commands
gateway-logs:
	docker-compose logs -f gateway

cockpit-logs:
	docker-compose logs -f cockpit

restart-gateway:
	docker-compose restart gateway

restart-cockpit:
	docker-compose restart cockpit

# Database commands
db-backup:
	docker-compose exec gateway sqlite3 /data/agentguard.db ".backup '/data/backup-$(shell date +%Y%m%d-%H%M%S).db'"

db-shell:
	docker-compose exec gateway sqlite3 /data/agentguard.db

# Install Python SDK and its local dependency (core-schema) into the active venv
install-sdk:
	pip install -e ./packages/core-schema/python
	pip install -e ./packages/sdk-python

# Python SDK testing environment
test-sdk:
	docker run -it --rm \
		-v $(PWD)/packages/sdk-python:/app \
		-v $(PWD)/packages/core-schema/python:/core-schema \
		-w /app \
		python:3.10-alpine \
		sh -c "pip install -e . -e /core-schema && python"