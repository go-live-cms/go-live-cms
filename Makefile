postgres:
	docker run --name postgres12 -p 5432:5432 -e POSTGRES_USER=root -e POSTGRES_PASSWORD=secret -d postgres:12-alpine

createdb:
	docker exec -it postgres12 createdb --username=root --owner=root golive_cms

dropdb:
	docker exec -it postgres12 dropdb --username=root golive_cms

new_migrate: ## copy this and add you own name
	migrate create -ext sql -dir db/migration -seq migration_name

migrateup:
	migrate -path db/migration -database "postgresql://root:secret@localhost:5432/golive_cms?sslmode=disable" --verbose up

migratedown:
	migrate -path db/migration -database "postgresql://root:secret@localhost:5432/golive_cms?sslmode=disable" --verbose down

sqlc:
	sqlc generate

server:
	go run main.go

# Dev seed (admin, dummy users, content, media files) into the DB in app.env.
# Idempotent; refuses unless GIN_MODE=debug (pass ARGS=-force to override).
seed:
	go run ./cmd/seed $(ARGS)

# Same, inside the running dev stack's api container.
devseed:
	docker compose --env-file app.env -f compose.dev.yaml exec api go run ./cmd/seed $(ARGS)

test:
	go test -v -cover ./...

test-db:
	go test -v -cover ./db/...

test-api:
	go test -v -cover ./api/...

test-token:
	go test -v -cover ./token/...

# Total statement coverage of ./... (includes the generated db/mock and the
# untested main packages, so it reads lower than the per-package numbers).
COVERAGE_MIN ?= 59.0

test-coverage:
	go test -coverprofile=coverage.out ./...
	go tool cover -func=coverage.out | grep total

# CI gate: fails when total coverage drops below COVERAGE_MIN. Raise the floor
# when coverage goes up; don't lower it to get a change through.
coverage-check: test-coverage
	@go tool cover -func=coverage.out | awk -v min=$(COVERAGE_MIN) '/^total:/ { sub("%", "", $$3); if ($$3 + 0 < min + 0) { printf "FAIL: total coverage %s%% is below the %s%% floor\n", $$3, min; exit 1 } printf "OK: total coverage %s%% (floor %s%%)\n", $$3, min }'

mock:
	mockgen -package mockdb -destination db/mock/store.go github.com/go-live-cms/go-live-cms/db/sqlc Store

# Documentation commands
docs: ## Start godoc documentation server
	./scripts/start-docs.sh

install-godoc: ## Install godoc tool
	go install golang.org/x/tools/cmd/godoc@latest

# Development commands
devbuild:
	docker compose --env-file app.env -f compose.dev.yaml up --build

dev:
	docker compose --env-file app.env -f compose.dev.yaml up

devdown:
	docker compose --env-file app.env -f compose.dev.yaml down

devlogs:
	docker compose --env-file app.env -f compose.dev.yaml logs -f

devlogs-api:
	docker compose --env-file app.env -f compose.dev.yaml logs -f api

devlogs-web:
	docker compose --env-file app.env -f compose.dev.yaml logs -f web

devrebuild:
	docker compose --env-file app.env -f compose.dev.yaml up --build --force-recreate

# Production commands
prod:
	docker compose -f compose.yaml up --build

proddown:
	docker compose -f compose.yaml down

prodlogs:
	docker compose -f compose.yaml logs -f

.PHONY: createdb dropdb postgres migrateup migratedown sqlc server seed devseed test test-db test-api test-token test-coverage coverage-check mock dev devdown devlogs devlogs-api devlogs-web devrebuild prod proddown prodlogs docs install-godoc