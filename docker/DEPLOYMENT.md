# AgentGuard Deployment Guide

## Quick Start

### Development Mode
```bash
# Start all services with hot-reload
make dev

# Access services:
# - Compliance Cockpit: http://localhost:3000
# - Gateway API: http://localhost:8080
# - Adminer (DB UI): http://localhost:8081
# - Redis Commander: http://localhost:8082
```

### Production Mode
```bash
# Build images
make build

# Start services
make prod

# Check logs
make logs
```

## Service Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   Compliance    │────▶│   MCP Gateway   │
│    Cockpit      │     │   (Port 8080)   │
│  (Port 3000)    │     └────────┬────────┘
└─────────────────┘              │
                                 ├──────▶ SQLite
                                 ├──────▶ Redis
                                 └──────▶ OTLP Collector
```

## Environment Configuration

### Gateway Environment Variables
- `PORT`: Gateway port (default: 8080)
- `DB_PATH`: Database file path (default: /data/agentguard.db)
- `REDIS_ENABLED`: Enable Redis caching
- `REDIS_URL`: Redis connection URL
- `KILL_SWITCH_MAX_VIOLATIONS`: Max violations before blocking (default: 3)
- `KILL_SWITCH_WINDOW`: Violation window in seconds (default: 3600)

### Cockpit Environment Variables
- `NEXT_PUBLIC_GATEWAY_URL`: Gateway API URL

## Database Management

### Backup Database
```bash
make db-backup
```

### Access Database Shell
```bash
make db-shell
```

### Migration to PostgreSQL
1. Update `docker-compose.yml` to use PostgreSQL
2. Update gateway to use PostgreSQL connection
3. Run migration scripts (to be developed)

## Monitoring & Observability

### Logs
```bash
# All services
make logs

# Specific service
make gateway-logs
make cockpit-logs
```

### Metrics
- Prometheus metrics: http://localhost:8888/metrics
- OpenTelemetry traces sent to collector

## Security Considerations

1. **Change Default Passwords**
   - PostgreSQL password in docker-compose.yml
   - Redis password (add requirepass)

2. **TLS/SSL**
   - Add reverse proxy (nginx/traefik) with SSL
   - Enable TLS for inter-service communication

3. **Network Isolation**
   - Use Docker networks to isolate services
   - Only expose necessary ports

4. **Volume Permissions**
   - Ensure proper ownership of data volumes
   - Run services as non-root users

## Production Checklist

- [ ] Change all default passwords
- [ ] Configure SSL/TLS certificates
- [ ] Set up backup strategy
- [ ] Configure monitoring alerts
- [ ] Set resource limits in docker-compose
- [ ] Enable authentication on all services
- [ ] Configure firewall rules
- [ ] Set up log rotation
- [ ] Test disaster recovery plan

## Scaling

### Horizontal Scaling
- Gateway: Run multiple instances behind load balancer
- Cockpit: Run multiple instances (stateless)
- Redis: Use Redis Cluster for HA
- PostgreSQL: Set up replication

### Resource Limits
Add to docker-compose.yml:
```yaml
services:
  gateway:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
        reservations:
          cpus: '1'
          memory: 1G
```

## Troubleshooting

### Container won't start
```bash
# Check logs
docker-compose logs <service-name>

# Rebuild image
docker-compose build --no-cache <service-name>
```

### Permission issues
```bash
# Fix volume permissions
docker-compose exec <service-name> chown -R node:node /data
```

### Database locked
```bash
# Restart gateway service
make restart-gateway
```

## Kubernetes Deployment

Helm charts and Kubernetes manifests are planned for future release. For now, you can:

1. Build and push images to registry
2. Create Kubernetes deployments based on docker-compose
3. Use ConfigMaps for environment variables
4. Use PersistentVolumes for data storage