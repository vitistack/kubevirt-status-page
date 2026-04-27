# Makefile for KubeVirt Status Page

# Define the Go binary name
BINARY_NAME=kubevirt-status-page

# Define the directories
CMD_DIR=cmd/server
INTERNAL_DIR=internal
WEB_DIR=web/static

# Define the Docker image name
DOCKER_IMAGE_NAME=vitistack/$(BINARY_NAME)

# Default target
all: build

# Build the Go application
build:
	go build -o $(BINARY_NAME) $(CMD_DIR)

# Run the application
run: build
	./$(BINARY_NAME)

# Clean up build artifacts
clean:
	go clean
	rm -f $(BINARY_NAME)

# Build Docker image
docker:
	docker build -t $(DOCKER_IMAGE_NAME) .

# Push Docker image to registry
push:
	docker push $(DOCKER_IMAGE_NAME)

# Run tests
test:
	go test ./...

# Format the code
fmt:
	go fmt ./...

# Lint the code
lint:
	golangci-lint run

# Help command
help:
	@echo "Makefile commands:"
	@echo "  all        - Build the application"
	@echo "  build      - Build the Go application"
	@echo "  run        - Run the application"
	@echo "  clean      - Clean up build artifacts"
	@echo "  docker     - Build Docker image"
	@echo "  push       - Push Docker image to registry"
	@echo "  test       - Run tests"
	@echo "  fmt        - Format the code"
	@echo "  lint       - Lint the code"
	@echo "  help       - Show this help message"