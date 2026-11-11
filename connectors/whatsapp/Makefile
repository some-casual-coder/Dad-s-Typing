.PHONY: build test vet fmt check docker

build:
	go build -o bin/connector ./cmd/connector

test:
	go test -race ./...

vet:
	go vet ./...

fmt:
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

check: fmt vet build test

docker:
	docker build -t dt-whatsapp-connector .

itest:
	go test -tags integration -count=1 -v ./internal/integration/
